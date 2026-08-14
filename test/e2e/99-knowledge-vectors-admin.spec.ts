import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';
import { createChatSessionViaUi, deleteChatSessionViaUi } from './helpers/settings';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const cookie = getAuthCookie() || undefined;

// ─── Knowledge management ───────────────────────────────────────
// NOTE: by product decision there is NO document-management UI — the app
// only manages embedding providers and external vector stores (the
// retriever node searches those stores at runtime). The upload/collection
// endpoints remain as the ingestion API (external integrations, fixtures).

test.describe('Knowledge CRUD (API contract — no document UI by design)', () => {
  let docId: string;

  test.afterEach(async ({ request }) => {
    if (docId) await request.delete(`${API_URL}/documents/${docId}`).catch(() => {});
  });

  test('upload document via knowledge route', async ({ request }) => {
    const res = await request.post(`${API_URL}/knowledge/upload`, {
      data: {
        name: 'Knowledge Doc',
        content: 'Test content for knowledge management E2E test.',
        collectionName: 'e2e-knowledge',
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.name).toBe('Knowledge Doc');
    docId = data.id;
  });

  test('upload document via documents route', async ({ request }) => {
    const res = await request.post(`${API_URL}/documents/upload`, {
      data: { name: 'Docs Doc', content: 'Content for documents route test.' },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.id).toBeDefined();
    docId = data.id;
  });

  test('list documents', async ({ request }) => {
    const res = await request.post(`${API_URL}/documents/upload`, {
      data: { name: 'List Doc', content: 'For listing test.' },
    });
    const doc = await res.json();
    docId = doc.id;

    const listRes = await request.get(`${API_URL}/documents`);
    expect(listRes.ok()).toBe(true);
    const docs = await listRes.json();
    expect(docs.some((d: any) => d.id === doc.id)).toBe(true);
  });

  test('upload produces chunks and the collection reports the document', async ({ request }) => {
    const content = 'Knowledge bases power retrieval. Chunks are indexed with embeddings. ' +
      'Each chunk stores its original text so retrieval can return context.';
    const res = await request.post(`${API_URL}/knowledge/upload`, {
      data: { name: 'Chunk Doc', content, collectionName: 'e2e-chunk-count' },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    docId = data.id;
    expect(data.chunkCount).toBeGreaterThan(0);

    const colsRes = await request.get(`${API_URL}/knowledge/collections`);
    expect(colsRes.ok()).toBe(true);
    const cols = await colsRes.json();
    const col = cols.find((c: any) => c.collection_name === 'e2e-chunk-count');
    expect(col).toBeDefined();
    expect(col.document_count).toBeGreaterThanOrEqual(1);

    const colRes = await request.get(`${API_URL}/knowledge/collections/e2e-chunk-count`);
    expect(colRes.ok()).toBe(true);
    const docs = await colRes.json();
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.some((d: any) => d.id === data.id)).toBe(true);
  });

  test('delete document removes it from the document list', async ({ request }) => {
    const upRes = await request.post(`${API_URL}/documents/upload`, {
      data: { name: 'Delete Me Doc', content: 'This document will be deleted.', collectionName: 'e2e-del-doc' },
    });
    expect(upRes.ok()).toBe(true);
    const doc = await upRes.json();
    docId = doc.id;

    const before = await (await request.get(`${API_URL}/documents`)).json();
    expect(before.some((d: any) => d.id === doc.id)).toBe(true);

    const delRes = await request.delete(`${API_URL}/documents/${doc.id}`);
    expect(delRes.ok()).toBe(true);
    docId = '';

    const after = await (await request.get(`${API_URL}/documents`)).json();
    expect(after.some((d: any) => d.id === doc.id)).toBe(false);

    const colDocs = await (await request.get(`${API_URL}/knowledge/collections/e2e-del-doc`)).json();
    expect(colDocs.some((d: any) => d.id === doc.id)).toBe(false);
  });

  test('get collection details', async ({ request }) => {
    const res = await request.post(`${API_URL}/knowledge/upload`, {
      data: { name: 'Col Doc', content: 'For collection.', collectionName: 'e2e-col' },
    });
    docId = (await res.json()).id;

    const colRes = await request.get(`${API_URL}/knowledge/collections/e2e-col`);
    expect(colRes.ok()).toBe(true);
  });

  test('delete collection', async ({ request }) => {
    await request.post(`${API_URL}/knowledge/upload`, {
      data: { name: 'ToDelete', content: 'To be deleted.', collectionName: 'e2e-to-delete' },
    });

    const delRes = await request.delete(`${API_URL}/knowledge/collections/e2e-to-delete`);
    expect(delRes.ok()).toBe(true);
  });
});

// ─── Vector store endpoints (CRUD via UI is covered in 70-settings) ──────────

test.describe('Vector store endpoints', () => {
  let storeId: string;

  test.afterEach(async ({ request }) => {
    if (storeId) await request.delete(`${API_URL}/vector-stores/${storeId}`).catch(() => {});
  });

  test('list collections via a vector store (contract)', async ({ request }) => {
    const createRes = await request.post(`${API_URL}/vector-stores`, {
      data: { name: 'ColStore', storeType: 'qdrant', url: 'http://qdrant-e2e:6333' },
    });
    const store = await createRes.json();
    storeId = store.id;
    const colRes = await request.get(`${API_URL}/vector-stores/${store.id}/collections`);
    expect(colRes.ok()).toBe(true);
  });

  test('retriever queries an uploaded collection and returns structured results', async ({ request }) => {
    // Create an LLM endpoint backed by the mock LLM so the uploaded chunks
    // get real (non-zero) embedding vectors in Postgres.
    const epRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: 'E2E KB Embed Endpoint',
        providerType: 'openai',
        baseUrl: 'http://mock-llm-e2e:3002/v1',
        apiKey: 'mock-key',
        defaultModel: 'text-embedding-ada-002',
        models: ['text-embedding-ada-002'],
      },
    });
    const embeddingEndpointId = epRes.ok() ? (await epRes.json()).id : undefined;

    // Upload a document so the collection has chunks
    const content = 'Qdrant is a vector database used for similarity search over embeddings. ' +
      'Chunks are matched by cosine similarity against the query embedding.';
    const upRes = await request.post(`${API_URL}/knowledge/upload`, {
      data: {
        name: 'Vector Search Doc',
        content,
        collectionName: 'e2e-vector-search',
        embeddingEndpointId,
      },
    });
    expect(upRes.ok()).toBe(true);
    const uploaded = await upRes.json();
    const docId = uploaded.id;
    expect(uploaded.chunkCount).toBeGreaterThan(0);

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('VectorSearch'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'r1', type: 'retriever', position: { x: 300, y: 0 }, data: { label: 'Retriever', type: 'retriever', config: { collectionName: 'e2e-vector-search', topK: 5, minScore: 0 } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['retriever.count'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'r1', targetHandle: 'input-0' },
        { id: 'e2', source: 'r1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'vector database' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const retrieverOutput = completed?.data?.output?.r1 || {};
    expect(retrieverOutput.query).toBe('vector database');
    expect(typeof retrieverOutput.count).toBe('number');
    expect(Array.isArray(retrieverOutput.chunks)).toBe(true);
    expect(retrieverOutput.count).toBe(retrieverOutput.chunks.length);
    // The uploaded chunk TEXT must actually be returned — regression guard:
    // the search used to hit an empty Qdrant store and return 0 chunks.
    expect(retrieverOutput.chunks.length).toBeGreaterThanOrEqual(1);
    expect(retrieverOutput.chunks[0].text).toContain('vector database');

    await deleteFlow(request, flow.id);
    await request.delete(`${API_URL}/documents/${docId}`).catch(() => {});
    if (embeddingEndpointId) await request.delete(`${API_URL}/llm-endpoints/${embeddingEndpointId}`).catch(() => {});
  });
});

// ─── Execution history ──────────────────────────────────────────

test.describe('Execution history', () => {
  let flowId: string;

  test.afterEach(async ({ request }) => {
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('GET /api/flows/:flowId/executions returns execution list (contract)', async ({ request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('ExecHist'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();
    flowId = flow.id;

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const execRes = await request.get(`${API_URL}/flows/${flow.id}/executions`);
    expect(execRes.ok()).toBe(true);
    const execs = await execRes.json();
    expect(Array.isArray(execs.data || execs)).toBe(true);
  });

  test('execution history page shows the paused execution', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('ExecHistPage'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Go?', buttons: [{ label: 'Approve', value: 'approved' }] } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
        { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    flowId = flow.id;

    // Debug runs are excluded from the run history — use a persisted run
    // paused at the HITL gate (awaiting_approval)
    const { executeUntilPaused } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;
    const { executionId } = await executeUntilPaused(flow.id, { message: 'test' }, cookie);
    expect(executionId).toBeTruthy();

    // The run history page lists the execution with an Awaiting Approval badge
    await page.goto(`/flows/${flow.id}/executions`);
    const row = page.locator('div.bg-surface.rounded-lg.border.p-4').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.getByText('Awaiting Approval')).toBeVisible({ timeout: 5000 });
  });
});

// ─── Chat sessions (CRUD via the chat page UI) ──────────────────

test.describe('Chat sessions', () => {
  let flowId: string;

  test.beforeAll(async ({ request }) => {
    const res = await createFlow(request, {
      name: uniqueFlowName('ChatSessions'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Chat', type: 'trigger', config: { triggerType: 'chat' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    flowId = (await res.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('session list shows the session created via the UI', async ({ page, request }) => {
    const sessionId = await createChatSessionViaUi(page, flowId);
    expect(sessionId).toBeTruthy();

    const sessions = await (await request.get(`${API_URL}/chat/${flowId}/sessions`)).json();
    expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);

    // Clean up so the following test sees a single session row
    await deleteChatSessionViaUi(page, flowId, 'New Chat');
  });

  test('DELETE /api/chat/sessions/:sessionId returns 404 after UI deletion', async ({ page, request }) => {
    const sessionId = await createChatSessionViaUi(page, flowId);

    await deleteChatSessionViaUi(page, flowId, 'New Chat');

    const gone = await request.get(`${API_URL}/chat/sessions/${sessionId}`);
    expect(gone.status()).toBe(404);
  });
});

// ─── Flow errors ────────────────────────────────────────────────

test.describe('Flow error handling', () => {
  test('flow with missing output references returns error', async ({ request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('InvalidRef'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['nonexistent.field'] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    const { debugExecute } = await import('./helpers/stream');
    try {
      const events = await debugExecute(flow.id, { message: 'test' }, cookie);
      const failed = events.find(e => e.type === 'execution.failed');
      expect(failed).toBeDefined();
    } catch {
      // Error thrown is fine — execution failed as expected
    }

    await deleteFlow(request, flow.id);
  });
});
