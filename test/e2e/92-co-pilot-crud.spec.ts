import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import {
  approvePendingViaUi,
  rejectPendingViaUi,
  deleteExecutionViaUi,
  renameProfileViaUi,
  changePasswordViaUi,
  createChatSessionViaUi,
  deleteChatSessionViaUi,
  setWebhookDeploymentViaUi,
  renewWebhookKeyViaUi,
  revokeWebhookKeyViaUi,
  enableChatApiViaUi,
  createChatApiKeyViaUi,
  deleteChatApiKeyViaUi,
  saveGlobalContextViaUi,
} from './helpers/settings';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

// ─── Server-contract tests kept here; every user-facing flow below goes
// through the real UI. CRUD coverage that now lives in UI specs:
//   70-settings   → LLM endpoints, MCP servers, embedding providers, vector stores
//   75-groups     → groups, members, roles, group vault binding (vault form)
//   76-sso        → SSO / OIDC config
//   79-agent-ctx  → agent contexts, global/group context
//   80-secrets    → secrets + vaults (incl. reveal, rotate, re-encrypt)
//   82-env-vars   → environment variables
//   99-knowledge  → documents & collections

test.describe('Co-Pilot tools', () => {
  // ─── HITL approval via the /approvals page ────────────────────────
  test('approve a HITL execution via the approvals page', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-HITL-UI'),
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
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;

    const { executionId } = await executeUntilPaused(flow.id, { message: 'test' }, cookie);
    expect(executionId).toBeTruthy();

    // The paused execution is visible in the pending-approvals list (contract)
    const pending = await (await request.get(`${API_URL}/executions/pending`)).json();
    expect(pending.some((e: any) => e.id === executionId)).toBe(true);

    // Approve through the approvals page UI
    await approvePendingViaUi(page, flow.name);

    // The execution completes after the replay
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
    expect(JSON.stringify(exec.pending_hitls)).not.toContain('awaiting');

    // No longer pending
    const pendingAfter = await (await request.get(`${API_URL}/executions/pending`)).json();
    expect(pendingAfter.some((e: any) => e.id === executionId)).toBe(false);

    // Approving a second time must fail (contract — no longer awaiting)
    const approveAgain = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approveAgain.status).toBe(400);

    await deleteFlow(request, flow.id);
  });

  test('reject a HITL execution via the approvals page with feedback', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-HITL-Reject'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Approve?', buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }] } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
        { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;

    const { executionId } = await executeUntilPaused(flow.id, { message: 'test' }, cookie);

    await rejectPendingViaUi(page, flow.name);

    // A 'rejected' HITL decision routes the flow off the rejected handle — with
    // no edge there, the run ends (completed/rejected) and stops awaiting.
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).not.toBe('awaiting_approval');
    expect(['completed', 'rejected', 'cancelled']).toContain(exec.status);

    // No longer pending
    const pendingAfter = await (await request.get(`${API_URL}/executions/pending`)).json();
    expect(pendingAfter.some((e: any) => e.id === executionId)).toBe(false);

    await deleteFlow(request, flow.id);
  });

  test('assignments: decide via approvals page, assignment row reflects it', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-Assign-UI'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Go', buttons: [{ label: 'Approve', value: 'approved' }] } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
        { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;
    const { executionId } = await executeUntilPaused(flow.id, { message: 'test' }, cookie);

    // A pending assignment mirrors the HITL pause
    const assignments = await (await request.get(`${API_URL}/assignments?status=pending`)).json();
    const mine = assignments.find((a: any) => a.execution_id === executionId);
    expect(mine).toBeDefined();
    expect(mine.hitl_node_id).toBe('h1');

    // Decide through the approvals page UI with feedback
    await approvePendingViaUi(page, flow.name, 'looks good');

    // The assignment is no longer pending, feedback is persisted
    const after = await (await request.get(`${API_URL}/assignments`)).json();
    const decided = after.find((a: any) => a.id === mine.id);
    expect(decided.status).toBe('approved');
    expect(decided.feedback).toBe('looks good');
    expect(decided.decided_by_user_id).toBeTruthy();

    // Deciding again must fail (contract)
    const againRes = await request.post(`${API_URL}/assignments/${mine.id}/decide`, { data: { status: 'rejected' } });
    expect(againRes.status()).toBe(400);

    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');

    await deleteFlow(request, flow.id);
  });

  test('POST /api/assignments/:id/decide validates decisions and unknown ids', async ({ request }) => {
    const badRes = await request.post(`${API_URL}/assignments/00000000-0000-0000-0000-000000000000/decide`, { data: { status: 'maybe' } });
    expect(badRes.status()).toBe(400);
    const missingRes = await request.post(`${API_URL}/assignments/00000000-0000-0000-0000-000000000000/decide`, { data: { status: 'approved' } });
    expect(missingRes.status()).toBe(404);
  });

  test('GET /api/assignments returns the current user\'s assignments', async ({ request }) => {
    const res = await request.get(`${API_URL}/assignments`);
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    const pendingRes = await request.get(`${API_URL}/assignments?status=pending`);
    expect(pendingRes.status()).toBe(200);
    const pending = await pendingRes.json();
    expect(pending.every((a: any) => a.status === 'pending')).toBe(true);
  });

  test('cancel a paused execution (engine contract)', async ({ request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-Cancel'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Wait', buttons: [{ label: 'Go', value: 'go' }] } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
        { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await flowRes.json();
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;
    const { executionId } = await executeUntilPaused(flow.id, { message: 'cancel' }, cookie);
    const cancelRes = await fetch(`${API_URL}/executions/${executionId}/cancel`, { method: 'POST', headers: { Cookie: cookie || '' } });
    expect(cancelRes.ok).toBe(true);
    const exec = await pollExecution(request, executionId, 15000);
    expect(exec.status).toBe('cancelled');
    await deleteFlow(request, flow.id);
  });

  // ─── Run history via the flow executions page ─────────────────────
  test('run history: list, view details and delete an execution via UI', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-RunHist'),
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

    // Debug runs are excluded from the run history — use a persisted run
    // paused at the HITL gate (awaiting_approval)
    const { executeUntilPaused } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;
    const { executionId } = await executeUntilPaused(flow.id, { message: 'test' }, cookie);
    expect(executionId).toBeTruthy();

    // List view shows the execution with the awaiting-approval badge
    await page.goto(`/flows/${flow.id}/executions`);
    const row = page.locator('div.bg-surface.rounded-lg.border.p-4').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.getByText('Awaiting Approval')).toBeVisible({ timeout: 5000 });

    // Detail view shows the trace (the step fetch can be slow under load)
    await row.click();
    await expect(page.getByRole('heading', { name: 'Execution Details' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Step Trace')).toBeVisible({ timeout: 20000 });
    // Return to the list via navigation (the state-toggle Back button can
    // detach mid-click while the detail view re-renders)
    await page.goto(`/flows/${flow.id}/executions`);

    // Delete via the UI
    await deleteExecutionViaUi(page, flow.id);
    await deleteFlow(request, flow.id);
  });

  // ─── Profile ───────────────────────────────────────────────────────
  test('update profile name via the profile page', async ({ page, request }) => {
    await renameProfileViaUi(page, 'CP Profile');
    const profile = await (await request.get(`${API_URL}/auth/profile`)).json();
    expect(profile.name).toBe('CP Profile');
    // Restore
    await renameProfileViaUi(page, 'E2E Test User');
    const restored = await (await request.get(`${API_URL}/auth/profile`)).json();
    expect(restored.name).toBe('E2E Test User');
  });

  test('change password via the profile page', async ({ page, request }) => {
    await changePasswordViaUi(page, 'Test1234!', 'NewCP5678!');

    // The new password works
    const loginNew = await request.post(`${API_URL}/auth/login`, { data: { email: 'e2e@test.local', password: 'NewCP5678!' } });
    expect(loginNew.ok()).toBe(true);

    // Revert via API (fixture — the UI only changes the password)
    const revert = await request.put(`${API_URL}/auth/password`, { data: { currentPassword: 'NewCP5678!', newPassword: 'Test1234!' } });
    expect(revert.ok()).toBe(true);
    const loginOld = await request.post(`${API_URL}/auth/login`, { data: { email: 'e2e@test.local', password: 'Test1234!' } });
    expect(loginOld.ok()).toBe(true);
  });

  test('auth config + setup status (contract)', async ({ request }) => {
    expect((await request.get(`${API_URL}/auth/config`)).ok()).toBe(true);
    expect((await request.get(`${API_URL}/auth/setup-status`)).ok()).toBe(true);
  });

  // ─── Global context via the settings page ─────────────────────────
  test('update global context via the settings page', async ({ page, request }) => {
    const orig = await (await request.get(`${API_URL}/settings/global-context`)).json();
    await saveGlobalContextViaUi(page, 'CP Global Context');
    const updated = await (await request.get(`${API_URL}/settings/global-context`)).json();
    expect(updated.value || updated).toBe('CP Global Context');
    // Restore
    await request.put(`${API_URL}/settings/global-context`, { data: { value: orig.value || '' } });
  });

  // ─── Chat sessions via the chat UI ─────────────────────────────────
  test('chat sessions: create and delete via the chat page', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-ChatSessions'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Chat', type: 'trigger', config: { triggerType: 'chat' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    // New Chat via the UI navigates to a fresh session
    const sessionId = await createChatSessionViaUi(page, flow.id);
    expect(sessionId).toBeTruthy();
    const session = await (await request.get(`${API_URL}/chat/sessions/${sessionId}`)).json();
    expect(session.id).toBe(sessionId);

    // The session list shows it (the backend titles new sessions "New Chat")
    await page.goto(`/chat/${flow.id}`);
    await expect(page.getByText('New Chat').first()).toBeVisible({ timeout: 5000 });

    // Delete via the UI, then the contract 404
    await deleteChatSessionViaUi(page, flow.id, 'New Chat');
    const gone = await request.get(`${API_URL}/chat/sessions/${sessionId}`);
    expect(gone.status()).toBe(404);

    await deleteFlow(request, flow.id);
  });

  // ─── Chat API deployment + keys via the flow editor ────────────────
  test('chat API deployment + keys via the flow editor', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-ChatAPI'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Chat', type: 'trigger', config: { triggerType: 'chat' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Enable the deployment and set the model via the UI
    await enableChatApiViaUi(page, 'test-model');
    const deployment = await (await request.get(`${API_URL}/flows/${flow.id}/chat-api/deployment`)).json();
    expect(deployment.enabled).toBe(true);
    expect(deployment.model_name).toBe('test-model');

    // Generate a key via the UI — the raw key is shown once
    const rawKey = await createChatApiKeyViaUi(page, 'CP Key');
    expect(rawKey).toMatch(/^ca_/);
    const keys = await (await request.get(`${API_URL}/flows/${flow.id}/chat-api/keys`)).json();
    expect(keys.some((k: any) => k.label === 'CP Key')).toBe(true);

    // Delete the key via the UI
    await deleteChatApiKeyViaUi(page);
    const keysAfter = await (await request.get(`${API_URL}/flows/${flow.id}/chat-api/keys`)).json();
    expect(keysAfter.some((k: any) => k.label === 'CP Key')).toBe(false);

    await deleteFlow(request, flow.id);
  });

  // ─── Webhook deployment + keys via the flow editor ─────────────────
  test('webhook deployment + keys via the flow editor', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-Webhook-UI'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'webhook' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Set the deployment config via the trigger config modal
    await setWebhookDeploymentViaUi(page, { pathSlug: 'cp-webhook', rateLimit: '5', summary: 'CP test' });
    const deployment = await (await request.get(`${API_URL}/flows/${flow.id}/deployment`)).json();
    expect(deployment.pathSlug).toBe('cp-webhook');
    expect(deployment.rateLimit).toBe(5);
    expect(deployment.summary).toBe('CP test');

    // Renew the personal key via the UI — the raw wh_ key is shown once
    const rawKey = await renewWebhookKeyViaUi(page);
    expect(rawKey).toMatch(/^wh_/);

    // Revoke via the UI
    await revokeWebhookKeyViaUi(page);

    await deleteFlow(request, flow.id);
  });

  // ─── Navigation smoke ──────────────────────────────────────────────
  test('navigate to various pages', async ({ page }) => {
    for (const path of ['/settings/endpoints', '/settings/mcp-servers', '/settings/users', '/profile', '/approvals']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Server contracts (validation, status codes, no-leak guarantees).
  // The happy paths these protect are covered through the UI in the
  // specs listed at the top of this file.
  // ═══════════════════════════════════════════════════════════════════

  test('create_endpoint — rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, { data: { name: 'Bad' } });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(400);
  });

  test('get_default_endpoint — returns default or 404', async ({ request }) => {
    const res = await request.get(`${API_URL}/llm-endpoints/default`);
    expect([200, 404]).toContain(res.status());
  });

  test('create_mcp_server — rejects missing url', async ({ request }) => {
    const res = await request.post(`${API_URL}/mcp-servers`, { data: { name: 'Bad MCP' } });
    expect(res.status()).toBe(400);
  });

  test('create_embedding_provider — rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/embedding-providers`, { data: { name: 'Bad Emb' } });
    expect(res.status()).toBe(400);
  });

  test('create_vector_store — rejects missing url', async ({ request }) => {
    const res = await request.post(`${API_URL}/vector-stores`, { data: { name: 'Bad VS' } });
    expect(res.status()).toBe(400);
  });

  test('create_user — rejects duplicate email with a clean 409', async ({ request }) => {
    const email = `cp-dup-${Date.now()}@test.local`;
    await request.post(`${API_URL}/users`, { data: { email, password: 'Test1234!', name: 'First' } });
    const res2 = await request.post(`${API_URL}/users`, { data: { email, password: 'Test1234!', name: 'Second' } });
    expect(res2.status()).toBe(409);
    expect((await res2.json()).error).toBe('Email already registered');
    const users = await (await request.get(`${API_URL}/users`)).json();
    const dup = users.find((u: any) => u.email === email);
    if (dup) await request.delete(`${API_URL}/users/${dup.id}`);
  });

  test('create_group — rejects duplicate name', async ({ request }) => {
    const name = `CP-Dup-${Date.now()}`;
    await request.post(`${API_URL}/groups`, { data: { name } });
    const res2 = await request.post(`${API_URL}/groups`, { data: { name } });
    expect(res2.status()).toBe(409);
    const groups = await (await request.get(`${API_URL}/groups`)).json();
    const dup = groups.find((g: any) => g.name === name);
    if (dup) await request.delete(`${API_URL}/groups/${dup.id}`);
  });

  test('create_secret — rejects empty name', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, { data: { name: '', value: 'v', scope: 'app' } });
    expect(res.status()).toBe(400);
  });

  test('secret list never leaks values (contract)', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, { data: { name: `CP-Leak-${Date.now()}`, value: 'secret-val', scope: 'app' } });
    const secret = await res.json();
    const listRes = await request.get(`${API_URL}/secrets?scope=app`);
    const list = await listRes.json();
    const found = list.find((s: any) => s.id === secret.id);
    expect(found).toBeDefined();
    expect(found.encrypted_value).toBeUndefined();
    expect(found.value).toBeUndefined();
    await request.delete(`${API_URL}/secrets/${secret.id}`);
  });

  test('get_secret_audit_log (contract)', async ({ request }) => {
    expect((await request.get(`${API_URL}/secrets/audit-log`)).ok()).toBe(true);
  });

  test('get_vault — unknown id returns 404', async ({ request }) => {
    const missing = await request.get(`${API_URL}/secret-vaults/00000000-0000-0000-0000-000000000000`);
    expect(missing.status()).toBe(404);
  });

  test('create_vault — rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/secret-vaults`, { data: { name: 'Bad Vault' } });
    expect(res.status()).toBe(400);
  });

  test('vault create never returns the api key (contract)', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-VaultLeak-${Date.now()}` } });
    const group = await gRes.json();
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'CP-LeakVault', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'admin', apiKey: 'test-key', groupId: group.id },
    });
    expect(res.ok()).toBe(true);
    const vault = await res.json();
    expect(vault.api_key).toBeUndefined();
    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('get_group_vault + set_group_vault (admin contract)', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-GV-${Date.now()}` } });
    const grp = await gRes.json();
    const vaultRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: `CP-GVault-${Date.now()}`, vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', login: 'admin', apiKey: 'test-key', groupId: grp.id },
    });
    const vault = await vaultRes.json();
    const setRes = await request.put(`${API_URL}/group-vault-config/${grp.id}`, { data: { vaultId: vault.id, enabled: true } });
    expect(setRes.ok()).toBe(true);
    const getRes = await request.get(`${API_URL}/group-vault-config/${grp.id}`);
    expect(getRes.ok()).toBe(true);
    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
    await request.delete(`${API_URL}/groups/${grp.id}`);
  });

  test('create_agent_context — rejects empty title', async ({ request }) => {
    const res = await request.post(`${API_URL}/agent-contexts`, { data: { content: 'x' } });
    expect(res.status()).toBe(400);
  });

  test('validate_flow — validates flow structure', async ({ request }) => {
    const res = await request.post(`${API_URL}/flows/validate`, {
      data: {
        nodes: [
          { id: 't1', type: 'trigger', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'o1', type: 'output', data: { label: 'Output', type: 'output', config: {} } },
        ],
        edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
      },
    });
    expect(res.ok()).toBe(true);
  });

  test('list_roles — seeded roles exist', async ({ request }) => {
    const res = await request.get(`${API_URL}/roles`);
    expect(res.ok()).toBe(true);
    const roles = await res.json();
    expect(roles.some((r: any) => r.name === 'admin')).toBe(true);
  });
});
