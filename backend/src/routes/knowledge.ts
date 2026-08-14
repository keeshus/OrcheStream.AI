import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { documents, embeddings, llmEndpoints, embeddingProviders } from '../db/schema.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { upsertToRegisteredStores } from 'orchestream-ai-shared';

const router = Router();

// GET /api/knowledge/collections — list distinct collection names with counts
router.get('/knowledge/collections', asyncHandler(async (_req, res) => {
  const result = await db.execute(sql`
    SELECT collection_name, COUNT(*)::int as document_count
    FROM documents
    GROUP BY collection_name
    ORDER BY collection_name
  `);
  res.json(result.rows || []);
}));

// GET /api/knowledge/collections/:name — get documents in a collection
router.get('/knowledge/collections/:name', asyncHandler(async (req, res) => {
  const name = req.params.name as string;
  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.collection_name, name))
    .orderBy(documents.created_at);
  res.json(docs);
}));

// POST /api/knowledge/upload — upload document to a collection
router.post('/knowledge/upload', requirePermission('knowledge:write'), asyncHandler(async (req, res) => {
  const { name, content, collectionName = 'default', embeddingEndpointId, embeddingModel } = req.body;
  if (!name || !content) {
    res.status(400).json({ error: 'name and content are required' });
    return;
  }

  const [doc] = await db.insert(documents).values({
    name,
    content,
    collection_name: collectionName,
    metadata: {},
  }).returning();

  // Chunk the text
  const chunks = chunkText(content, 500, 50);

  // Generate embeddings
  let embedFn: (text: string) => Promise<number[]>;
  const model = embeddingModel || 'text-embedding-ada-002';

  // A configured embedding provider takes precedence — it carries its own
  // model. LLM endpoints are accepted as a fallback for legacy callers.
  if (embeddingEndpointId) {
    const [provider] = await db.select().from(embeddingProviders).where(eq(embeddingProviders.id, embeddingEndpointId));
    if (provider) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({
        apiKey: provider.api_key,
        baseURL: provider.base_url || undefined,
      });
      embedFn = async (text: string) => {
        const resp = await client.embeddings.create({ model: provider.model, input: text });
        return resp.data[0].embedding;
      };
    } else {
      const [endpoint] = await db.select().from(llmEndpoints).where(eq(llmEndpoints.id, embeddingEndpointId));
      if (endpoint && (endpoint.provider_type === 'openai' || endpoint.provider_type === 'litellm')) {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({
          apiKey: endpoint.api_key,
          baseURL: endpoint.base_url || undefined,
        });
        embedFn = async (text: string) => {
          const resp = await client.embeddings.create({ model, input: text });
          return resp.data[0].embedding;
        };
      }
    }
  }

  // Fallback if no endpoint configured
  if (!embedFn!) {
    embedFn = async () => new Array(1536).fill(0);
  }

  const chunkRecords = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedFn(chunks[i]);
    chunkRecords.push({
      document_id: doc.id,
      chunk_index: i,
      chunk_text: chunks[i],
      embedding,
    });
  }

  if (chunkRecords.length > 0) {
    await db.insert(embeddings).values(chunkRecords);
    // Mirror chunks into any user-registered external stores (e.g. Qdrant)
    // so the retriever finds them whichever store the search path prefers.
    await upsertToRegisteredStores(collectionName, chunkRecords.map((c) => ({
      id: crypto.randomUUID(),
      embedding: c.embedding as number[],
      payload: { documentId: doc.id, chunkText: c.chunk_text, chunkIndex: c.chunk_index },
    })));
  }

  res.status(201).json({ ...doc, chunkCount: chunks.length });
}));

// DELETE /api/knowledge/collections/:name — delete entire collection
router.delete('/knowledge/collections/:name', requirePermission('knowledge:write'), asyncHandler(async (req, res) => {
  const name = req.params.name as string;
  const docs = await db.select({ id: documents.id }).from(documents).where(eq(documents.collection_name, name));
  for (const d of docs) {
    await db.delete(embeddings).where(eq(embeddings.document_id, d.id));
  }
  await db.delete(documents).where(eq(documents.collection_name, name));
  res.status(204).send();
}));

// DELETE /api/knowledge/documents/:id — delete single document
router.delete('/knowledge/documents/:id', requirePermission('knowledge:write'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  await db.delete(embeddings).where(eq(embeddings.document_id, id));
  await db.delete(documents).where(eq(documents.id, id));
  res.status(204).send();
}));

// Simple text chunker
function chunkText(text: string, maxLength = 500, _overlap = 50): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxLength) {
      if (para.trim()) chunks.push(para.trim());
      continue;
    }
    const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > maxLength && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks.length > 0 ? chunks : [text.slice(0, maxLength)];
}

export default router;
