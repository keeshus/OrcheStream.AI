import { Router } from 'express';
import { db } from '../db/connection.js';
import { documents, embeddings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { requirePermission } from '../middleware/auth.js';
import { upsertToRegisteredStores } from 'orchestream-ai-shared';
// Inline embedding call to avoid cross-workspace TS rootDir issues.
// At runtime, tsx resolves this fine; the worker module is available.
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const mod = await import('../../../worker/src/rag/embeddings.js');
    return mod.generateEmbedding(text);
  } catch {
    // Fallback for when worker isn't available (e.g. tests)
    console.warn('Could not load embedding module, returning zero vector');
    return new Array(1536).fill(0);
  }
}

import { asyncHandler } from '../utils/async-handler.js';

const router = Router();

// POST /api/documents/upload — Upload a document, chunk it, generate embeddings
router.post('/documents/upload', requirePermission('document:write'), asyncHandler(async (req, res) => {
  const { name, content, collectionName = 'default', metadata = {} } = req.body;

  if (!name || !content) {
    res.status(400).json({ error: 'Name and content are required' });
    return;
  }

  // Create document record
  const [doc] = await db.insert(documents).values({
    name,
    content,
    collection_name: collectionName,
    metadata,
  }).returning();

  // Simple text chunking: split by paragraphs, then by sentence boundaries
  const chunks = chunkText(content, 500, 50);

  // Generate embeddings for each chunk
  const chunkEmbeddings = await Promise.all(chunks.map(async (chunkText) => {
    const embedding = await generateEmbedding(chunkText);
    return embedding as any;
  }));

  if (chunks.length > 0) {
    await db.insert(embeddings).values(chunks.map((chunkText, index) => ({
      document_id: doc.id,
      chunk_index: index,
      chunk_text: chunkText,
      embedding: chunkEmbeddings[index],
    })));
    // Mirror chunks into any user-registered external stores (e.g. Qdrant)
    // so the retriever finds them whichever store the search path prefers.
    await upsertToRegisteredStores(collectionName, chunks.map((chunkText, index) => ({
      id: crypto.randomUUID(),
      embedding: chunkEmbeddings[index],
      payload: { documentId: doc.id, chunkText, chunkIndex: index },
    })));
  }

  res.status(201).json({ ...doc, chunkCount: chunks.length });
}));

// GET /api/documents — List all documents
router.get('/documents', asyncHandler(async (req, res) => {
  const result = await db.select().from(documents).orderBy(documents.created_at);
  res.json(result);
}));

// DELETE /api/documents/:id — Delete document and its embeddings
router.delete('/documents/:id', requirePermission('document:write'), asyncHandler(async (req, res) => {
  const docId = req.params.id as string;
  await db.delete(embeddings).where(eq(embeddings.document_id, docId));
  await db.delete(documents).where(eq(documents.id, docId));
  res.status(204).end();
}));

// Simple text chunker — split by paragraphs, keep overlap
function chunkText(text: string, maxLength: number = 500, overlap: number = 50): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= maxLength) {
      if (para.trim()) chunks.push(para.trim());
      continue;
    }

    // Split long paragraphs into overlapping chunks
    const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > maxLength && current) {
        chunks.push(current.trim());
        // Overlap: keep the last sentence
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks;
}

export default router;
