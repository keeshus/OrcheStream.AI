import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { debugExecute, pollExecution } from './helpers/stream';
import { getAuthCookie } from './helpers/auth';
import {
  createFlowViaUi, addNode, configureNode, closeConfig, fillField,
  fillFieldByPlaceholder, connect, moveNodeToSlot, saveFlow,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const cookie = getAuthCookie() || undefined;

/** Open the config modal for a node (no rename). */
async function openConfigLocal(page: any, label: string) {
  await page.locator('.react-flow__node').filter({ has: page.getByText(label, { exact: true }) }).first().click();
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
}

// ── UI flow builders (spec-local, mirror 90-node-types) ─────────

/** Build a trigger → hitl → output flow through the editor UI. */
async function buildHITLFlow(page: any, request: any, name: string, prompt: string, buttons: { label: string; value: string }[]) {
  const flowId = await createFlowViaUi(page, name);
  await configureNode(page, 'Trigger', 'Trigger');
  await closeConfig(page);
  await moveNodeToSlot(page, 'Trigger', -1, 0);
  const h = await addNode(page, 'hitl');
  await moveNodeToSlot(page, h, 0, 0);
  await configureNode(page, h, 'Gate');
  const modal = page.getByTestId('node-config-modal');
  await fillFieldByPlaceholder(page, 'Please review the generated content before proceeding...', prompt);
  // Custom buttons only render after switching the HITL mode to Custom
  await modal.getByRole('button', { name: 'Custom', exact: true }).click();
  for (let i = 0; i < buttons.length; i++) {
    // The buttons list starts empty — every row must be added explicitly
    await modal.getByRole('button', { name: '+ Add Button' }).click();
    await modal.getByLabel('Label').nth(i).fill(buttons[i].label);
    await modal.getByLabel('Value').nth(i).fill(buttons[i].value);
  }
  await closeConfig(page);
  const o = await addNode(page, 'output');
  await moveNodeToSlot(page, o, 1, 0);
  await configureNode(page, o, 'Output');
  await closeConfig(page);
  await connect(page, 'Trigger', 'output-0', 'Gate', 'input-0');
  await connect(page, 'Gate', 'output-0', 'Output', 'input-0');
  await saveFlow(page);
  return flowId;
}

/** Build a trigger → output chat flow through the editor UI. */
async function buildChatFlow(page: any, request: any, name: string) {
  const flowId = await createFlowViaUi(page, name);
  await configureNode(page, 'Trigger', 'Chat');
  const modal = page.getByTestId('node-config-modal');
  await modal.locator('[data-field-label="Trigger Type"]').click();
  await page.getByRole('option', { name: 'Chat' }).first().click();
  await closeConfig(page);
  await moveNodeToSlot(page, 'Chat', -1, 0);
  const o = await addNode(page, 'output');
  await moveNodeToSlot(page, o, 1, 0);
  await configureNode(page, o, 'Output');
  await closeConfig(page);
  await connect(page, 'Chat', 'output-0', 'Output', 'input-0');
  // Chat flows require exactly one output field selected before they can save
  await openConfigLocal(page, 'Output');
  const modal2 = page.getByTestId('node-config-modal');
  await modal2.locator('label').filter({ has: page.getByText('message', { exact: true }) }).locator('input[type="checkbox"]').check();
  await closeConfig(page);
  await saveFlow(page);
  return flowId;
}

// ─── Retriever node ─────────────────────────────────────────────
// NOTE: kept API-based — Retriever nodes render NO connection handles on the
// canvas (inputs={0}, tool-output only; wired via the LLM Agent's tool-input
// "purple dot" instead), so a retriever flow cannot be wired in the editor
// UI. The retriever CONFIG form is covered in 94-node-type-configs.

test.describe('Retriever node — comprehensive (API-pinned: no canvas handles)', () => {
  let embeddingProviderId: string | null = null;
  let docId: string | null = null;
  let flowId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Create embedding provider pointing at mock LLM
    const epRes = await request.post(`${API_URL}/embedding-providers`, {
      data: {
        name: 'E2E Embed',
        providerType: 'openai',
        baseUrl: 'http://mock-llm-e2e:3002/v1',
        apiKey: 'mock-key',
        model: 'text-embedding-ada-002',
      },
    });
    if (epRes.ok()) {
      const ep = await epRes.json();
      embeddingProviderId = ep.id;
    }
  });

  test.afterAll(async ({ request }) => {
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
    if (docId) await request.delete(`${API_URL}/documents/${docId}`).catch(() => {});
    if (embeddingProviderId) await request.delete(`${API_URL}/embedding-providers/${embeddingProviderId}`).catch(() => {});
  });

  test('upload a document with content', async ({ request }) => {
    const res = await request.post(`${API_URL}/knowledge/upload`, {
      data: {
        name: 'Test Doc',
        content: 'Paris is the capital of France. London is the capital of the UK. Berlin is the capital of Germany.',
        collectionName: 'e2e-countries',
      },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.chunkCount).toBeGreaterThan(0);
    docId = data.id;
  });

  test('retriever executes and returns output with the correct structure', async ({ request }) => {
    test.skip(!embeddingProviderId, 'Embedding provider not available');

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('RetrieverFull'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'r1', type: 'retriever', position: { x: 300, y: 0 }, data: { label: 'Retriever', type: 'retriever', config: { collectionName: 'e2e-countries', topK: 5, minScore: 0, embeddingProviderId } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['retriever.count', 'retriever.query', 'retriever.chunks'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'r1', targetHandle: 'input-0' },
        { id: 'e2', source: 'r1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    flowId = flow.id;

    const events = await debugExecute(flow.id, { message: 'capital of France' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed!.data?.output;
    expect(output).toBeDefined();

    // Verify retriever output structure
    const retrieverOutput = output?.r1 || {};
    expect(retrieverOutput.query).toBeDefined();
    expect(typeof retrieverOutput.count).toBe('number');
    expect(Array.isArray(retrieverOutput.chunks)).toBe(true);
  });

  test('retriever with high minScore returns no results', async ({ request }) => {
    test.skip(!embeddingProviderId, 'Embedding provider not available');

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('RetrieverHighScore'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'r1', type: 'retriever', position: { x: 300, y: 0 }, data: { label: 'Retriever', type: 'retriever', config: { collectionName: 'e2e-countries', topK: 5, minScore: 0.99, embeddingProviderId } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['retriever.count'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'r1', targetHandle: 'input-0' },
        { id: 'e2', source: 'r1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    flowId = flow.id;

    const events = await debugExecute(flow.id, { message: 'capital of France' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const output = completed!.data?.output;
    expect(output).toBeDefined();

    const retrieverOutput = output?.r1 || {};
    expect(retrieverOutput.query).toBeDefined();
    expect(typeof retrieverOutput.count).toBe('number');
    expect(Array.isArray(retrieverOutput.chunks)).toBe(true);
    // minScore 0.99 exceeds the similarity of every stored chunk, so no
    // results may be returned (the mock embedding similarity is far below).
    expect(retrieverOutput.count).toBeLessThan(1);
    expect(retrieverOutput.chunks.length).toBe(0);
  });

  test('retriever with minScore 0 returns everything the store has', async ({ request }) => {
    test.skip(!embeddingProviderId, 'Embedding provider not available');

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('RetrieverZeroScore'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'r1', type: 'retriever', position: { x: 300, y: 0 }, data: { label: 'Retriever', type: 'retriever', config: { collectionName: 'e2e-countries', topK: 5, minScore: 0, embeddingProviderId } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['retriever.count'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'r1', targetHandle: 'input-0' },
        { id: 'e2', source: 'r1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    flowId = flow.id;

    const events = await debugExecute(flow.id, { message: 'capital of France' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const retrieverOutput = completed!.data?.output?.r1 || {};
    expect(typeof retrieverOutput.count).toBe('number');
    // With no threshold, every chunk in the store passes; count == chunks
    expect(retrieverOutput.count).toBe(retrieverOutput.chunks.length);
    // Regression guard: uploaded chunks must actually be searchable. The
    // search used to hit an empty Qdrant store and return 0 chunks.
    expect(retrieverOutput.count).toBeGreaterThanOrEqual(1);
    expect(retrieverOutput.chunks[0].text).toContain('Paris is the capital of France');
  });
});

// ─── Approvals page ─────────────────────────────────────────────
// NOTE: flows are built via the editor UI; the pause/approve cycle itself
// stays API-based — persisted executions (executeUntilPaused/pollExecution)
// have no debug-overlay equivalent (the overlay runs in-memory).

test.describe('Approvals page — reject', () => {
  let flowId: string;

  test.afterEach(async ({ request }) => {
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('POST /api/executions/:executionId/reject rejects execution', async ({ page, request }) => {
    flowId = await buildHITLFlow(page, request, uniqueFlowName('HITLRejectAPI'), 'Go?', [
      { label: 'Reject', value: 'rejected' },
      { label: 'Approve', value: 'approved' },
    ]);

    const { executeUntilPaused } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(flowId, { message: 'test' }, cookie);

    // Reject via API
    const rejectRes = await fetch(`${API_URL}/executions/${executionId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ reason: 'Not needed' }),
    });
    expect(rejectRes.ok).toBe(true);

    const exec = await pollExecution(request, executionId, 15000);
    expect(exec.status).toBe('cancelled');
  });

  test('reject from approvals page shows rejection', async ({ page, request }) => {
    flowId = await buildHITLFlow(page, request, uniqueFlowName('HITLRejectUI'), 'Go?', [
      { label: 'Reject', value: 'rejected' },
      { label: 'Approve', value: 'approved' },
    ]);

    const { executeUntilPaused } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(flowId, { message: 'test' }, cookie);

    // Navigate to approvals page and click the real Reject button (from the HITL config)
    await page.goto('/approvals');
    await expect(page.getByText('Pending Approvals')).toBeVisible({ timeout: 10000 });
    const rejectBtn = page.locator('button:has-text("Reject")').first();
    await expect(rejectBtn).toBeVisible({ timeout: 5000 });
    await rejectBtn.click();

    // The execution is removed from the pending list…
    await expect(rejectBtn).toHaveCount(0, { timeout: 10000 });

    // …and reaches a terminal state.
    // The /executions/:id/reject endpoint is covered by the API test above
    // (POST /api/executions/:executionId/reject asserts status 'cancelled').
    // The UI path routes through approve/decision, so the UI execution
    // completes with decision='rejected' instead of being cancelled.
    const exec = await pollExecution(request, executionId, 20000);
    expect(['completed', 'cancelled', 'failed']).toContain(exec.status);
  });
});

// ─── Cancel execution ───────────────────────────────────────────

test.describe('Cancel execution', () => {
  let flowId: string;

  test.afterEach(async ({ request }) => {
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('POST /api/executions/:executionId/cancel cancels running execution', async ({ page, request }) => {
    flowId = await buildHITLFlow(page, request, uniqueFlowName('CancelTest'), 'Wait', [
      { label: 'Go', value: 'go' },
    ]);

    const { executeUntilPaused } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(flowId, { message: 'cancel' }, cookie);

    // Cancel via API
    const cancelRes = await fetch(`${API_URL}/executions/${executionId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    });
    expect(cancelRes.ok).toBe(true);

    // Verify cancelled
    const exec = await pollExecution(request, executionId, 15000);
    expect(exec.status).toBe('cancelled');
  });

  test('cancel pending execution via the /settings/executions page', async ({ page, request }) => {
    flowId = await buildHITLFlow(page, request, uniqueFlowName('CancelUI'), 'Wait', [
      { label: 'Go', value: 'go' },
    ]);

    const { executeUntilPaused } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(flowId, { message: 'cancel-ui' }, cookie);

    await page.goto('/settings/executions');
    await expect(page.getByText('Pending Approvals')).toBeVisible({ timeout: 10000 });

    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    await expect(cancelBtn).toBeVisible({ timeout: 10000 });
    await cancelBtn.click();

    // Confirm in the dialog (button is labeled 'Cancel execution', not a generic 'Delete')
    const confirmBtn = page.getByRole('button', { name: 'Cancel execution' });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    const exec = await pollExecution(request, executionId, 15000);
    expect(exec.status).toBe('cancelled');
  });

  test('settings executions page shows empty state and manual refresh works', async ({ page }) => {
    // With no pending executions the page shows the empty state
    await page.goto('/settings/executions');
    await expect(page.getByText('Pending Approvals')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('All caught up! No pending executions.')).toBeVisible({ timeout: 10000 });

    // The manual Refresh button is present and re-fetches without error
    const refreshBtn = page.getByRole('button', { name: 'Refresh' });
    await expect(refreshBtn).toBeVisible({ timeout: 5000 });
    await refreshBtn.click();
    await expect(page.getByText('All caught up! No pending executions.')).toBeVisible({ timeout: 10000 });
  });

  test('settings executions page shows access denied for non-admins', async ({ page, request }) => {
    const email = `exec-denied-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Exec Denied', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    const rolesRes = await request.get(`${API_URL}/roles`);
    const roles = await rolesRes.json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${regData.user.id}/role`, { data: { role_id: editorRole.id } });

    try {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill('Test1234!');
      await page.getByRole('button', { name: /sign.?in/i }).click();
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });

      await page.goto('/settings/executions');
      await expect(page.getByText('Access denied')).toBeVisible({ timeout: 10000 });
    } finally {
      await request.delete(`${API_URL}/users/${regData.user.id}`).catch(() => {});
    }
  });
});

// ─── Auth endpoints (no UI surface — API contract tests) ────────

test.describe('Auth edge cases (API contract — no UI)', () => {
  test('POST /api/auth/logout clears session and API becomes unauthorized', async ({ page }) => {
    // Sanity check: authenticated before logout
    const beforeRes = await page.request.get(`${API_URL}/flows`);
    expect(beforeRes.ok()).toBe(true);

    const res = await page.request.post(`${API_URL}/auth/logout`);
    expect(res.ok()).toBe(true);

    // After logout the API must reject the session
    const afterRes = await page.request.get(`${API_URL}/flows`);
    expect(afterRes.status()).toBe(401);

    // Re-login for subsequent tests
    await page.goto('/login');
    await page.getByLabel('Email').fill('e2e@test.local');
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: /sign.?in/i }).click();
    await page.waitForLoadState('networkidle');

    // API works again with the fresh session
    const reloginRes = await page.request.get(`${API_URL}/flows`);
    expect(reloginRes.ok()).toBe(true);
  });

  test('PUT /api/auth/password changes password and new password works', async ({ request }) => {
    const res = await request.put(`${API_URL}/auth/password`, {
      data: { currentPassword: 'Test1234!', newPassword: 'NewTest5678!' },
    });
    expect(res.ok()).toBe(true);

    // Old password must now fail to log in…
    const oldLogin = await request.post(`${API_URL}/auth/login`, {
      data: { email: 'e2e@test.local', password: 'Test1234!' },
    });
    expect(oldLogin.status()).toBe(401);

    // …while the new password succeeds
    const newLogin = await request.post(`${API_URL}/auth/login`, {
      data: { email: 'e2e@test.local', password: 'NewTest5678!' },
    });
    expect(newLogin.ok()).toBe(true);
    const loginData = await newLogin.json();
    expect(loginData.user.email).toBe('e2e@test.local');

    // Change back so subsequent tests pass
    const restore = await request.put(`${API_URL}/auth/password`, {
      data: { currentPassword: 'NewTest5678!', newPassword: 'Test1234!' },
    });
    expect(restore.ok()).toBe(true);

    const restoredLogin = await request.post(`${API_URL}/auth/login`, {
      data: { email: 'e2e@test.local', password: 'Test1234!' },
    });
    expect(restoredLogin.ok()).toBe(true);
  });

  test('GET /api/auth/config returns auth config', async ({ request }) => {
    const res = await request.get(`${API_URL}/auth/config`);
    expect(res.ok()).toBe(true);
    const config = await res.json();
    expect(config).toBeDefined();
  });
});

// ─── Flow check-name endpoint (no UI surface) ───────────────────

test.describe('Flow utilities (API contract — no UI)', () => {
  test('GET /api/flows/check-name returns availability for unique name', async ({ request }) => {
    const res = await request.get(`${API_URL}/flows/check-name?name=UniqueFlow999`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.available).toBe(true);
  });

  test('GET /api/flows/check-name returns unavailable for taken name', async ({ request }) => {
    const flowRes = await createFlow(request, { name: 'TakenNameFlow' });
    const flow = await flowRes.json();

    const res = await request.get(`${API_URL}/flows/check-name?name=TakenNameFlow`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data.available).toBe(false);

    await deleteFlow(request, flow.id);
  });
});

// ─── Settings CRUD (API contract — UI equivalents covered in the
//     settings/groups/secrets specs) ─────────────────────────────

test.describe('Settings CRUD from API (server contract — UI in settings specs)', () => {
  let createdId: string;

  test.afterEach(async ({ request }) => {
    if (createdId) await request.delete(`${API_URL}/llm-endpoints/${createdId}`).catch(() => {});
  });

  test('PUT /api/llm-endpoints/:id updates an LLM endpoint', async ({ request }) => {
    const createRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Update Test', providerType: 'openai', baseUrl: 'http://test.local/v1', apiKey: 'sk-test', defaultModel: 'gpt-4', models: ['gpt-4'] },
    });
    const ep = await createRes.json();
    createdId = ep.id;

    const updateRes = await request.put(`${API_URL}/llm-endpoints/${ep.id}`, {
      data: { name: 'E2E Updated', defaultModel: 'gpt-4-turbo' },
    });
    expect(updateRes.ok()).toBe(true);
    const updated = await updateRes.json();
    expect(updated.name).toBe('E2E Updated');
    expect(updated.default_model || updated.defaultModel).toBe('gpt-4-turbo');
  });

  test('PUT /api/secrets/:id updates a secret', async ({ request }) => {
    const createRes = await request.post(`${API_URL}/secrets`, {
      data: { name: 'UpdateSecret', value: 'original-value', scope: 'app' },
    });
    const secret = await createRes.json();
    createdId = secret.id;

    const updateRes = await request.put(`${API_URL}/secrets/${secret.id}`, {
      data: { value: 'updated-value' },
    });
    expect(updateRes.ok()).toBe(true);

    await request.delete(`${API_URL}/secrets/${secret.id}`);
    createdId = '';
  });

  test('PUT /api/mcp-servers/:id updates an MCP server', async ({ request }) => {
    const createRes = await request.post(`${API_URL}/mcp-servers`, {
      data: { name: 'E2E MCP Update', url: 'http://test-mcp.local/sse' },
    });
    const server = await createRes.json();
    createdId = server.id;

    const updateRes = await request.put(`${API_URL}/mcp-servers/${server.id}`, {
      data: { name: 'E2E MCP Updated' },
    });
    expect(updateRes.ok()).toBe(true);

    await request.delete(`${API_URL}/mcp-servers/${server.id}`);
    createdId = '';
  });

  test('GET /api/secret-vaults returns vault list', async ({ request }) => {
    const res = await request.get(`${API_URL}/secret-vaults`);
    expect(res.ok()).toBe(true);
    const vaults = await res.json();
    expect(Array.isArray(vaults)).toBe(true);
  });
});

// ─── Document listing (no UI surface for these GET contracts) ───

test.describe('Document endpoints (API contract)', () => {
  test('GET /api/documents returns document list', async ({ request }) => {
    const res = await request.get(`${API_URL}/documents`);
    expect(res.ok()).toBe(true);
    const docs = await res.json();
    expect(Array.isArray(docs)).toBe(true);
  });

  test('GET /api/knowledge/collections returns collection list', async ({ request }) => {
    const res = await request.get(`${API_URL}/knowledge/collections`);
    expect(res.ok()).toBe(true);
    const cols = await res.json();
    expect(Array.isArray(cols)).toBe(true);
  });
});

// ─── Remaining admin/niche endpoints ────────────────────────────

test.describe('Admin and niche endpoints', () => {
  test('POST /api/roles/seed seeds default roles', async ({ request }) => {
    const res = await request.post(`${API_URL}/roles/seed`);
    // May return 200 (created) or 409 (already exist) — either is valid
    expect([200, 409]).toContain(res.status());
  });

  test('POST /api/llm/chat (Co-Pilot API) responds', async ({ request }) => {
    // The route requires endpointId (backend/src/routes/llm.ts:16) and a
    // messages array (line 17). With neither provided, it must return a
    // specific 400 with a meaningful error — never a 5xx.
    const res = await request.post(`${API_URL}/llm/chat`, {
      data: { message: 'hello', flowId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('endpointId is required');
  });

  test('POST /api/llm/chat streams token + done events on the happy path', async ({ request }) => {
    // Create a mock-backed endpoint for the chat route
    const epRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: `E2E-Chat-${Date.now()}`,
        providerType: 'openai',
        baseUrl: 'http://mock-llm-e2e:3002/v1',
        apiKey: 'mock-key',
        defaultModel: 'mock-gpt-4',
        models: ['mock-gpt-4'],
      },
    });
    expect(epRes.ok()).toBe(true);
    const ep = await epRes.json();

    try {
      const chatRes = await request.post(`${API_URL}/llm/chat`, {
        data: {
          endpointId: ep.id,
          messages: [{ role: 'user', content: 'hello chat' }],
          systemPrompt: 'You are a helpful assistant.',
        },
      });
      expect(chatRes.ok()).toBe(true);
      const text = await chatRes.text();
      // SSE stream: token events followed by a done event
      expect(text).toContain('"type":"token"');
      expect(text).toContain('"type":"done"');
      // Reassemble the streamed tokens — the phrase is split across events
      const tokens = [...text.matchAll(/"type":"token","content":"((?:\\.|[^"\\])*)"/g)]
        .map(m => m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
      expect(tokens.join('')).toContain('Mock response to: hello chat');
    } finally {
      await request.delete(`${API_URL}/llm-endpoints/${ep.id}`).catch(() => {});
    }
  });

  test('POST /api/llm/chat streams a tool_call event when the mock requests one', async ({ request }) => {
    const epRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: `E2E-ChatTool-${Date.now()}`,
        providerType: 'openai',
        baseUrl: 'http://mock-llm-e2e:3002/v1',
        apiKey: 'mock-key',
        defaultModel: 'mock-gpt-4',
        models: ['mock-gpt-4'],
      },
    });
    expect(epRes.ok()).toBe(true);
    const ep = await epRes.json();

    try {
      const chatRes = await request.post(`${API_URL}/llm/chat`, {
        data: {
          endpointId: ep.id,
          messages: [{ role: 'user', content: 'MOCK_TOOL_CALL: list_flows {}' }],
          systemPrompt: 'You are a helpful assistant.',
          tools: [{ name: 'list_flows', description: 'List flows', input_schema: { type: 'object', properties: {} } }],
        },
      });
      expect(chatRes.ok()).toBe(true);
      const text = await chatRes.text();
      expect(text).toContain('"type":"tool_call"');
      expect(text).toContain('list_flows');
      expect(text).toContain('"type":"done"');
    } finally {
      await request.delete(`${API_URL}/llm-endpoints/${ep.id}`).catch(() => {});
    }
  });

  test('POST /api/llm/chat returns 404 for unknown endpoint and 400 for oversized history', async ({ request }) => {
    const missing = await request.post(`${API_URL}/llm/chat`, {
      data: { endpointId: '00000000-0000-0000-0000-000000000000', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toBe('Endpoint not found');

    // More than 50 messages is rejected up-front
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }));
    const oversized = await request.post(`${API_URL}/llm/chat`, {
      data: { endpointId: '00000000-0000-0000-0000-000000000000', messages: tooMany },
    });
    expect(oversized.status()).toBe(400);
    expect((await oversized.json()).error).toBe('Too many messages');
  });

  test('GET /api/health reports service status', async ({ request }) => {
    const res = await request.get(`${API_URL.replace(/\/api$/, '')}/api/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /api/secrets/audit-log returns audit data', async ({ request }) => {
    const res = await request.get(`${API_URL}/secrets/audit-log`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('POST /api/executions/:id/admin-cancel cancels execution as admin', async ({ page, request }) => {
    const flowId = await buildHITLFlow(page, request, uniqueFlowName('AdminCancel'), 'Wait', [
      { label: 'Go', value: 'go' },
    ]);

    const { executeUntilPaused } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(flowId, { message: 'cancel' }, cookie);

    const cancelRes = await fetch(`${API_URL}/executions/${executionId}/admin-cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    });
    expect(cancelRes.ok).toBe(true);

    const exec = await pollExecution(request, executionId, 15000);
    expect(exec.status).toBe('cancelled');

    await deleteFlow(request, flowId);
  });

  test('chat session messages SSE endpoint returns events', async ({ page, request }) => {
    // The chat flow itself is built via the editor UI; the session + SSE
    // stream are the endpoint under test (no UI surface for the raw stream).
    const flowId = await buildChatFlow(page, request, uniqueFlowName('ChatMsgTest'));

    // Create a session
    const sessionRes = await request.post(`${API_URL}/chat/${flowId}/sessions`, { data: { title: 'Msg Test' } });
    const { id: sessionId } = await sessionRes.json();

    // Read the SSE stream and assert at least one event arrives
    const sseRes = await fetch(`${API_URL}/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(sseRes.ok).toBe(true);
    const reader = sseRes.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buf = '';
    const events: string[] = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) events.push(line.slice(6));
      }
      if (events.length >= 3) break;
    }
    expect(events.length).toBeGreaterThan(0);

    // The final 'done' event carries the assistant message content
    const doneEvent = events.map(e => { try { return JSON.parse(e); } catch { return null; } }).find(e => e?.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.data.content).toBeDefined();

    await deleteFlow(request, flowId);
  });
});
