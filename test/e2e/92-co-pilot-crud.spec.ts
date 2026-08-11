import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

test.describe('Co-Pilot tools', () => {
  // ─── LLM Endpoints ─────────────────────────────────────────────
  test('list_endpoints', async ({ request }) => {
    const res = await request.get(`${API_URL}/llm-endpoints`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('create_endpoint — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'CP LLM', providerType: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-4', models: ['gpt-4'] },
    });
    expect(res.ok()).toBe(true);
    const ep = await res.json();
    expect(ep.name).toBe('CP LLM');
    await request.delete(`${API_URL}/llm-endpoints/${ep.id}`);
  });

  test('create_endpoint — rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, { data: { name: 'Bad' } });
    expect(res.ok()).toBe(false);
    expect(res.status()).toBe(400);
  });

  test('delete_endpoint — removes endpoint', async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'CP Del', providerType: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-4' },
    });
    const ep = await res.json();
    const delRes = await request.delete(`${API_URL}/llm-endpoints/${ep.id}`);
    expect(delRes.ok()).toBe(true);
    const listRes = await request.get(`${API_URL}/llm-endpoints`);
    const list = await listRes.json();
    expect(list.some((e: any) => e.id === ep.id)).toBe(false);
  });

  // ─── MCP Servers ───────────────────────────────────────────────
  test('list_mcp_servers', async ({ request }) => {
    const res = await request.get(`${API_URL}/mcp-servers`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('create_mcp_server — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/mcp-servers`, {
      data: { name: 'CP MCP', url: 'http://mock-mcp-e2e:3003/sse' },
    });
    expect(res.ok()).toBe(true);
    const server = await res.json();
    expect(server.name).toBe('CP MCP');
    await request.delete(`${API_URL}/mcp-servers/${server.id}`);
  });

  test('create_mcp_server — rejects missing url', async ({ request }) => {
    const res = await request.post(`${API_URL}/mcp-servers`, { data: { name: 'Bad MCP' } });
    expect(res.status()).toBe(400);
  });

  test('refresh_mcp_tools — refreshes tool list', async ({ request }) => {
    const res = await request.post(`${API_URL}/mcp-servers`, {
      data: { name: 'CP Refresh', url: 'http://mock-mcp-e2e:3003/sse' },
    });
    const server = await res.json();
    const refreshRes = await request.post(`${API_URL}/mcp-servers/${server.id}/refresh`);
    expect(refreshRes.ok()).toBe(true);
    await request.delete(`${API_URL}/mcp-servers/${server.id}`);
  });

  test('delete_mcp_server — removes server', async ({ request }) => {
    const res = await request.post(`${API_URL}/mcp-servers`, {
      data: { name: 'CP Del MCP', url: 'http://e2e-del.local/sse' },
    });
    const server = await res.json();
    expect((await request.delete(`${API_URL}/mcp-servers/${server.id}`)).ok()).toBe(true);
  });

  // ─── Embedding Providers ───────────────────────────────────────
  test('list_embedding_providers', async ({ request }) => {
    const res = await request.get(`${API_URL}/embedding-providers`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('create_embedding_provider — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/embedding-providers`, {
      data: { name: 'CP Emb', providerType: 'openai', apiKey: 'sk-test', model: 'text-embedding-ada-002' },
    });
    expect(res.ok()).toBe(true);
    const ep = await res.json();
    expect(ep.name).toBe('CP Emb');
    await request.delete(`${API_URL}/embedding-providers/${ep.id}`);
  });

  test('create_embedding_provider — rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/embedding-providers`, { data: { name: 'Bad Emb' } });
    expect(res.status()).toBe(400);
  });

  test('delete_embedding_provider — removes provider', async ({ request }) => {
    const res = await request.post(`${API_URL}/embedding-providers`, {
      data: { name: 'CP Del Emb', providerType: 'openai', apiKey: 'sk-test' },
    });
    const ep = await res.json();
    expect((await request.delete(`${API_URL}/embedding-providers/${ep.id}`)).ok()).toBe(true);
  });

  // ─── Vector Stores ─────────────────────────────────────────────
  test('list_vector_stores', async ({ request }) => {
    const res = await request.get(`${API_URL}/vector-stores`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('create_vector_store — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/vector-stores`, {
      data: { name: 'CP VS', storeType: 'qdrant', url: 'http://qdrant-e2e:6333' },
    });
    expect(res.ok()).toBe(true);
    const vs = await res.json();
    expect(vs.name).toBe('CP VS');
    await request.delete(`${API_URL}/vector-stores/${vs.id}`);
  });

  test('create_vector_store — rejects missing url', async ({ request }) => {
    const res = await request.post(`${API_URL}/vector-stores`, { data: { name: 'Bad VS' } });
    expect(res.status()).toBe(400);
  });

  test('delete_vector_store — removes store', async ({ request }) => {
    const res = await request.post(`${API_URL}/vector-stores`, {
      data: { name: 'CP Del VS', storeType: 'qdrant', url: 'http://qdrant-e2e:6333' },
    });
    const vs = await res.json();
    expect((await request.delete(`${API_URL}/vector-stores/${vs.id}`)).ok()).toBe(true);
  });

  // ─── Users ─────────────────────────────────────────────────────
  test('list_users', async ({ request }) => {
    const res = await request.get(`${API_URL}/users`);
    expect(res.ok()).toBe(true);
    const users = await res.json();
    expect(Array.isArray(users)).toBe(true);
    expect(users.some((u: any) => u.email === 'e2e@test.local')).toBe(true);
  });

  test('create_user — success', async ({ request }) => {
    const email = `cp-user-${Date.now()}@test.local`;
    const res = await request.post(`${API_URL}/users`, {
      data: { email, password: 'Test1234!', name: 'CP User' },
    });
    expect(res.status()).toBe(201);
    const user = await res.json();
    expect(user.email).toBe(email);
    expect(user.id).toBeDefined();

    // New user shows up in the user list
    const users = await (await request.get(`${API_URL}/users`)).json();
    expect(users.some((u: any) => u.email === email)).toBe(true);

    await request.delete(`${API_URL}/users/${user.id}`);
  });

  test('create_user — rejects duplicate email', async ({ request }) => {
    const email = `cp-dup-${Date.now()}@test.local`;
    await request.post(`${API_URL}/users`, { data: { email, password: 'Test1234!', name: 'First' } });
    const res2 = await request.post(`${API_URL}/users`, { data: { email, password: 'Test1234!', name: 'Second' } });
    // Must be a clean 409 conflict (not a 500 unique-violation)
    expect(res2.status()).toBe(409);
    expect((await res2.json()).error).toBe('Email already registered');
    // Cleanup: find and delete
    const users = await (await request.get(`${API_URL}/users`)).json();
    const dup = users.find((u: any) => u.email === email);
    if (dup) await request.delete(`${API_URL}/users/${dup.id}`);
  });

  test('delete_user — removes user', async ({ request }) => {
    const email = `cp-del-${Date.now()}@test.local`;
    const res = await request.post(`${API_URL}/users`, { data: { email, password: 'Test1234!', name: 'Del' } });
    const user = await res.json();
    expect((await request.delete(`${API_URL}/users/${user.id}`)).ok()).toBe(true);
    const users = await (await request.get(`${API_URL}/users`)).json();
    expect(users.some((u: any) => u.id === user.id)).toBe(false);
  });

  test('update_user_role — changes role', async ({ request }) => {
    const email = `cp-role-${Date.now()}@test.local`;
    const res = await request.post(`${API_URL}/users`, { data: { email, password: 'Test1234!', name: 'Role' } });
    const user = await res.json();
    const roles = await (await request.get(`${API_URL}/roles`)).json();
    const reader = roles.find((r: any) => r.name === 'reader');

    const updateRes = await request.put(`${API_URL}/users/${user.id}/role`, { data: { role_id: reader.id } });
    expect(updateRes.ok()).toBe(true);

    await request.delete(`${API_URL}/users/${user.id}`);
  });

  // ─── Profile ───────────────────────────────────────────────────
  test('update_profile — changes name', async ({ request }) => {
    await request.put(`${API_URL}/auth/profile`, { data: { name: 'CP Profile' } });
    const profile = await (await request.get(`${API_URL}/auth/profile`)).json();
    expect(profile.name).toBe('CP Profile');
    await request.put(`${API_URL}/auth/profile`, { data: { name: 'E2E Test User' } });
  });

  test('get_profile — returns current user', async ({ request }) => {
    const res = await request.get(`${API_URL}/auth/profile`);
    expect(res.ok()).toBe(true);
    const profile = await res.json();
    expect(profile.email).toBe('e2e@test.local');
  });

  // ─── Executions ────────────────────────────────────────────────
  test('list_executions', async ({ request }) => {
    const res = await request.get(`${API_URL}/executions`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('get_execution_details + delete_execution', async ({ request }) => {
    const list = await (await request.get(`${API_URL}/executions`)).json();
    const execs = Array.isArray(list) ? list : [];
    const target = execs.find((e: any) => !e.input?._debug);
    if (target) {
      const detail = await (await request.get(`${API_URL}/executions/${target.id}`)).json();
      expect(detail.id).toBe(target.id);
      expect((await request.delete(`${API_URL}/executions/${target.id}`)).ok()).toBe(true);
    }
  });

  // ─── Approvals ─────────────────────────────────────────────────
  test('get_pending_approvals', async ({ request }) => {
    const res = await request.get(`${API_URL}/executions/pending`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('approve_execution + reject_execution — via API', async ({ request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('CP-HITL'),
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

    // Assert the persisted execution is awaiting_approval before approving
    await expect
      .poll(async () => {
        const r = await request.get(`${API_URL}/executions/${executionId}`);
        return r.ok() ? (await r.json()).status : 'unavailable';
      }, { timeout: 5000 })
      .toBe('awaiting_approval');

    // The execution is visible in the pending-approvals list
    const pending = await (await request.get(`${API_URL}/executions/pending`)).json();
    expect(pending.some((e: any) => e.id === executionId)).toBe(true);

    // Approve
    const approveRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approveRes.ok).toBe(true);
    const approved = await approveRes.json();
    // The approval enqueues a replay job for the worker — the run completes asynchronously
    expect(['running', 'completed']).toContain(approved.status);

    // State transition: awaiting_approval -> completed
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
    expect(exec.pending_hitls).toBeDefined();
    expect(JSON.stringify(exec.pending_hitls)).not.toContain('awaiting');

    // It is no longer pending
    const pendingAfter = await (await request.get(`${API_URL}/executions/pending`)).json();
    expect(pendingAfter.some((e: any) => e.id === executionId)).toBe(false);

    // Approving a second time must fail (not awaiting_approval anymore)
    const approveAgain = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approveAgain.status).toBe(400);

    await deleteFlow(request, flow.id);
  });

  // ─── Flows ─────────────────────────────────────────────────────
  test('list_flows', async ({ request }) => {
    const created = await createFlow(request, { name: uniqueFlowName('CPListFlows') });
    const flow = await created.json();

    const res = await request.get(`${API_URL}/flows`);
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.data)).toBe(true);
    const found = data.data.find((f: any) => f.id === flow.id);
    expect(found).toBeDefined();
    expect(found.name).toBe(flow.name);
    expect(found.created_by_name).toBeDefined();

    await deleteFlow(request, flow.id);
  });

  test('search_flows — returns filtered results', async ({ request }) => {
    const name = uniqueFlowName('SearchTarget');
    await createFlow(request, { name });
    const res = await request.get(`${API_URL}/flows?limit=100&search=${encodeURIComponent(name)}`);
    const data = await res.json();
    expect(data.data.some((f: any) => f.name === name)).toBe(true);
  });

  // ─── Navigation ────────────────────────────────────────────────
  test('navigate_to — various pages', async ({ page }) => {
    for (const path of ['/settings/endpoints', '/settings/mcp-servers', '/settings/users', '/profile', '/approvals']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });
    }
  });

  // ─── Secrets ───────────────────────────────────────────────────
  test('list_secrets', async ({ request }) => {
    const res = await request.get(`${API_URL}/secrets`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('create_secret — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, {
      data: { name: 'CP-Secret', value: 'cp-value', scope: 'app' },
    });
    expect(res.ok()).toBe(true);
    const secret = await res.json();
    expect(secret.name).toBe('CP-Secret');
    await request.delete(`${API_URL}/secrets/${secret.id}`);
  });

  test('create_secret — rejects empty name', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, { data: { name: '', value: 'v', scope: 'app' } });
    expect(res.status()).toBe(400);
  });

  test('update_secret — changes value', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, {
      data: { name: 'CP-Upd', value: 'old', scope: 'app' },
    });
    const secret = await res.json();
    const updateRes = await request.put(`${API_URL}/secrets/${secret.id}`, { data: { value: 'new' } });
    expect(updateRes.ok()).toBe(true);
    await request.delete(`${API_URL}/secrets/${secret.id}`);
  });

  test('delete_secret — removes secret', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, {
      data: { name: 'CP-Del', value: 'x', scope: 'app' },
    });
    const secret = await res.json();
    expect((await request.delete(`${API_URL}/secrets/${secret.id}`)).ok()).toBe(true);
  });

  test('rotate_key — rotates encryption key', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets/rotate-key`);
    expect(res.ok()).toBe(true);
  });

  // ─── Secret Vaults ─────────────────────────────────────────────
  let vaultGroupId: string;

  test.beforeAll(async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-VaultGrp-${Date.now()}` } });
    vaultGroupId = (await gRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (vaultGroupId) await request.delete(`${API_URL}/groups/${vaultGroupId}`).catch(() => {});
  });

  test('list_vaults', async ({ request }) => {
    const res = await request.get(`${API_URL}/secret-vaults`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('get_vault — fetches a single vault by id', async ({ request }) => {
    const createRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'CP-GetVault', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'admin', apiKey: 'test-key', groupId: vaultGroupId },
    });
    expect(createRes.ok()).toBe(true);
    const vault = await createRes.json();

    const res = await request.get(`${API_URL}/secret-vaults/${vault.id}`);
    expect(res.ok()).toBe(true);
    const single = await res.json();
    expect(single.id).toBe(vault.id);
    expect(single.name).toBe('CP-GetVault');
    expect(single.vault_type).toBe('cyberark');
    expect(single.base_url).toBe('http://mock-cyberark-e2e:3005');

    // Unknown vault id -> 404
    const missing = await request.get(`${API_URL}/secret-vaults/00000000-0000-0000-0000-000000000000`);
    expect(missing.status()).toBe(404);

    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
  });

  test('create_vault — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'CP-Vault', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'admin', apiKey: 'test-key', groupId: vaultGroupId },
    });
    expect(res.ok()).toBe(true);
    const vault = await res.json();
    expect(vault.name).toBe('CP-Vault');
    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
  });

  test('create_vault — rejects missing fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/secret-vaults`, { data: { name: 'Bad Vault' } });
    expect(res.status()).toBe(400);
  });

  test('test_vault_connection — tests connection', async ({ request }) => {
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'CP-VaultTest', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'admin', apiKey: 'test-key', groupId: vaultGroupId },
    });
    const vault = await res.json();
    const testRes = await request.post(`${API_URL}/secret-vaults/${vault.id}/test`);
    expect(testRes.ok()).toBe(true);
    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
  });

  test('update_vault — updates config', async ({ request }) => {
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'CP-UpdV', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', login: 'admin', apiKey: 'test-key', groupId: vaultGroupId },
    });
    const vault = await res.json();
    const updRes = await request.put(`${API_URL}/secret-vaults/${vault.id}`, { data: { name: 'CP-UpdV-New' } });
    expect(updRes.ok()).toBe(true);
    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
  });

  test('delete_vault — removes vault', async ({ request }) => {
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'CP-DelV', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', login: 'admin', apiKey: 'test-key', groupId: vaultGroupId },
    });
    const vault = await res.json();
    expect((await request.delete(`${API_URL}/secret-vaults/${vault.id}`)).ok()).toBe(true);
  });

  // ─── Global Context ────────────────────────────────────────────
  test('get_global_context', async ({ request }) => {
    const res = await request.get(`${API_URL}/settings/global-context`);
    expect(res.ok()).toBe(true);
  });

  test('update_global_context — saves and reads back', async ({ request }) => {
    const orig = await (await request.get(`${API_URL}/settings/global-context`)).json();
    await request.put(`${API_URL}/settings/global-context`, { data: { value: 'CP Global Context' } });
    const updated = await (await request.get(`${API_URL}/settings/global-context`)).json();
    expect(updated.value || updated).toBe('CP Global Context');
    await request.put(`${API_URL}/settings/global-context`, { data: { value: orig.value || '' } });
  });

  // ─── SSO Config ────────────────────────────────────────────────
  test('get_sso_config', async ({ request }) => {
    const res = await request.get(`${API_URL}/admin/sso-config`);
    expect(res.ok()).toBe(true);
  });

  test('update_sso_config — saves config', async ({ request }) => {
    const orig = await (await request.get(`${API_URL}/admin/sso-config`)).json();
    await request.put(`${API_URL}/admin/sso-config`, {
      data: { provider: 'oidc', clientId: 'cp-test', clientSecret: 'cp-secret', issuer: 'http://test.local' },
    });
    const saved = await (await request.get(`${API_URL}/admin/sso-config`)).json();
    expect(saved.provider).toBe('oidc');
    // Restore
    await request.put(`${API_URL}/admin/sso-config`, { data: orig });
  });

  // ─── Groups ────────────────────────────────────────────────────
  test('list_groups', async ({ request }) => {
    const created = await request.post(`${API_URL}/groups`, { data: { name: `CP-ListGrp-${Date.now()}` } });
    expect(created.status()).toBe(201);
    const group = await created.json();

    const res = await request.get(`${API_URL}/groups`);
    expect(res.ok()).toBe(true);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((g: any) => g.id === group.id)).toBe(true);

    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('create_group — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/groups`, { data: { name: `CP-Group-${Date.now()}` } });
    expect(res.ok()).toBe(true);
    const group = await res.json();
    expect(group.name).toContain('CP-Group');
    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('create_group — rejects duplicate name', async ({ request }) => {
    const name = `CP-Dup-${Date.now()}`;
    await request.post(`${API_URL}/groups`, { data: { name } });
    const res2 = await request.post(`${API_URL}/groups`, { data: { name } });
    expect(res2.status()).toBe(409);
  });

  test('update_group — updates name and context', async ({ request }) => {
    const res = await request.post(`${API_URL}/groups`, { data: { name: `CP-UpdG-${Date.now()}` } });
    const group = await res.json();
    const updRes = await request.put(`${API_URL}/groups/${group.id}`, { data: { name: 'CP-UpdG-New', context: 'test context' } });
    expect(updRes.ok()).toBe(true);
    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('delete_group — removes group', async ({ request }) => {
    const res = await request.post(`${API_URL}/groups`, { data: { name: `CP-DelG-${Date.now()}` } });
    const group = await res.json();
    expect((await request.delete(`${API_URL}/groups/${group.id}`)).ok()).toBe(true);
  });

  test('add_group_member + remove_group_member', async ({ request }) => {
    const groupRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-Member-${Date.now()}` } });
    const group = await groupRes.json();
    const users = await (await request.get(`${API_URL}/users`)).json();
    const target = users[0];

    const addRes = await request.post(`${API_URL}/groups/${group.id}/members`, { data: { userId: target.id } });
    expect(addRes.ok()).toBe(true);

    const delRes = await request.delete(`${API_URL}/groups/${group.id}/members/${target.id}`);
    expect(delRes.ok()).toBe(true);

    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('get_group_context — reads group context via member endpoint', async ({ request }) => {
    const groupRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-Ctx-${Date.now()}`, context: 'group hello' } });
    const group = await groupRes.json();

    const ctxRes = await request.get(`${API_URL}/groups/${group.id}/context`);
    expect(ctxRes.ok()).toBe(true);
    const ctx = await ctxRes.json();
    expect(ctx.context).toBe('group hello');

    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('update_group_context — sets and reads back group context', async ({ request }) => {
    const groupRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-UpdCtx-${Date.now()}` } });
    const group = await groupRes.json();

    const putRes = await request.put(`${API_URL}/groups/${group.id}/context`, {
      data: { context: 'Instructions for this group.' },
    });
    expect(putRes.ok()).toBe(true);
    expect((await putRes.json()).context).toBe('Instructions for this group.');

    const getRes = await request.get(`${API_URL}/groups/${group.id}/context`);
    expect((await getRes.json()).context).toBe('Instructions for this group.');

    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  // ─── Group Vault Config ────────────────────────────────────────
  test('get_group_vault + set_group_vault', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-GV-${Date.now()}` } });
    const grp = await gRes.json();

    const vaultRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: `CP-GVault-${Date.now()}`, vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', login: 'admin', apiKey: 'test-key', groupId: grp.id },
    });
    const vault = await vaultRes.json();

    // Set group vault config
    const setRes = await request.put(`${API_URL}/group-vault-config/${grp.id}`, {
      data: { vaultId: vault.id, enabled: true },
    });
    expect(setRes.ok()).toBe(true);

    // Get
    const getRes = await request.get(`${API_URL}/group-vault-config/${grp.id}`);
    expect(getRes.ok()).toBe(true);

    await request.delete(`${API_URL}/secret-vaults/${vault.id}`);
    await request.delete(`${API_URL}/groups/${grp.id}`);
  });

  // ─── Agent Contexts ────────────────────────────────────────────
  test('list_agent_contexts', async ({ request }) => {
    const res = await request.get(`${API_URL}/agent-contexts`);
    expect(res.ok()).toBe(true);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('create_agent_context — success', async ({ request }) => {
    const res = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'CP Context', description: 'test', content: 'You are helpful.' },
    });
    expect(res.ok()).toBe(true);
    const ctx = await res.json();
    expect(ctx.title).toBe('CP Context');
    await request.delete(`${API_URL}/agent-contexts/${ctx.id}`);
  });

  test('create_agent_context — rejects empty title', async ({ request }) => {
    const res = await request.post(`${API_URL}/agent-contexts`, { data: { content: 'x' } });
    expect(res.status()).toBe(400);
  });

  test('update_agent_context — updates title and content', async ({ request }) => {
    const res = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'CP UpdCtx', content: 'old content' },
    });
    const ctx = await res.json();
    const updRes = await request.put(`${API_URL}/agent-contexts/${ctx.id}`, {
      data: { title: 'CP UpdCtx New', content: 'new content' },
    });
    expect(updRes.ok()).toBe(true);
    await request.delete(`${API_URL}/agent-contexts/${ctx.id}`);
  });

  test('delete_agent_context — removes context', async ({ request }) => {
    const res = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'CP DelCtx', content: 'x' },
    });
    const ctx = await res.json();
    expect((await request.delete(`${API_URL}/agent-contexts/${ctx.id}`)).ok()).toBe(true);
  });

  // ─── Execution & Flow Control ──────────────────────────────────
  test('execute_flow — runs a flow', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPExec'),
      nodes: [{ id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } }],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();
    const res = await request.post(`${API_URL}/flows/${flow.id}/execute`, { data: { input: { _debug: true, message: 'test' }, _debug: true } });
    expect(res.ok()).toBe(true);
    await deleteFlow(request, flow.id);
  });

  test('cancel_execution — cancels execution', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPCancel'), nodes: [
      { id: 't1', type: 'trigger', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
      { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Wait', buttons: [{ label: 'Go', value: 'go' }] } } },
      { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
    ], edges: [
      { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
      { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
    ] });
    const flow = await flowRes.json();
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;
    const { executionId } = await executeUntilPaused(flow.id, { message: 'cancel' }, cookie);
    const cancelRes = await fetch(`${API_URL}/executions/${executionId}/cancel`, { method: 'POST', headers: { Cookie: cookie || '' } });
    expect(cancelRes.ok).toBe(true);
    const cancelBody = await cancelRes.json();
    expect(cancelBody.status).toBe('cancelled');
    const exec = await pollExecution(request, executionId, 15000);
    expect(exec.status).toBe('cancelled');
    await deleteFlow(request, flow.id);
  });

  test('create_flow + delete_flow — creates and deletes', async ({ request }) => {
    const name = uniqueFlowName('CPCreate');
    const createRes = await request.post(`${API_URL}/flows`, { data: { name } });
    expect(createRes.status()).toBe(201);
    const flow = await createRes.json();
    expect(flow.id).toBeDefined();
    expect(flow.name).toBe(name);
    expect((await request.delete(`${API_URL}/flows/${flow.id}`)).status()).toBe(204);

    // Deleted flow is gone
    const gone = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(gone.status()).toBe(404);
  });

  test('get_flow_by_id — returns flow', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPGet') });
    const flow = await flowRes.json();
    const getRes = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(getRes.ok()).toBe(true);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(flow.id);
    expect(fetched.name).toBe(flow.name);
    await deleteFlow(request, flow.id);
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

  // ─── LLM Endpoints (additional) ───────────────────────────────
  test('update_endpoint — updates endpoint', async ({ request }) => {
    const epRes = await request.post(`${API_URL}/llm-endpoints`, { data: { name: 'CP UpdEP', providerType: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-4' } });
    const ep = await epRes.json();
    expect((await request.put(`${API_URL}/llm-endpoints/${ep.id}`, { data: { name: 'CP UpdEP New' } })).ok()).toBe(true);
    await request.delete(`${API_URL}/llm-endpoints/${ep.id}`);
  });

  test('get_endpoint — returns single endpoint', async ({ request }) => {
    const epRes = await request.post(`${API_URL}/llm-endpoints`, { data: { name: 'CP GetEP', providerType: 'openai', apiKey: 'sk-test', defaultModel: 'gpt-4' } });
    const ep = await epRes.json();
    expect((await request.get(`${API_URL}/llm-endpoints/${ep.id}`)).ok()).toBe(true);
    await request.delete(`${API_URL}/llm-endpoints/${ep.id}`);
  });

  test('get_default_endpoint — returns default', async ({ request }) => {
    const res = await request.get(`${API_URL}/llm-endpoints/default`);
    expect([200, 404]).toContain(res.status());
  });

  // ─── MCP (additional) ─────────────────────────────────────────
  test('update_mcp_server + get_mcp_server', async ({ request }) => {
    const res = await request.post(`${API_URL}/mcp-servers`, { data: { name: 'CP UpdMCP', url: 'http://e2e-test.local/sse' } });
    const srv = await res.json();
    expect((await request.put(`${API_URL}/mcp-servers/${srv.id}`, { data: { name: 'CP UpdMCP New' } })).ok()).toBe(true);
    expect((await request.get(`${API_URL}/mcp-servers/${srv.id}`)).ok()).toBe(true);
    await request.delete(`${API_URL}/mcp-servers/${srv.id}`);
  });

  // ─── Embedding Providers (additional) ─────────────────────────
  test('update_embedding_provider + get_embedding_provider', async ({ request }) => {
    const res = await request.post(`${API_URL}/embedding-providers`, { data: { name: 'CP UpdEmb', providerType: 'openai', apiKey: 'sk-test' } });
    const ep = await res.json();
    expect((await request.put(`${API_URL}/embedding-providers/${ep.id}`, { data: { name: 'CP UpdEmb New' } })).ok()).toBe(true);
    expect((await request.get(`${API_URL}/embedding-providers/${ep.id}`)).ok()).toBe(true);
    await request.delete(`${API_URL}/embedding-providers/${ep.id}`);
  });

  // ─── Vector Stores (additional) ───────────────────────────────
  test('update_vector_store + get_vector_store', async ({ request }) => {
    const res = await request.post(`${API_URL}/vector-stores`, { data: { name: 'CP UpdVS', storeType: 'qdrant', url: 'http://qdrant-e2e:6333' } });
    const vs = await res.json();
    expect((await request.put(`${API_URL}/vector-stores/${vs.id}`, { data: { name: 'CP UpdVS New' } })).ok()).toBe(true);
    expect((await request.get(`${API_URL}/vector-stores/${vs.id}`)).ok()).toBe(true);
    await request.delete(`${API_URL}/vector-stores/${vs.id}`);
  });

  test('list_collections + refresh_collections', async ({ request }) => {
    const res = await request.post(`${API_URL}/vector-stores`, { data: { name: 'CP ColVS', storeType: 'qdrant', url: 'http://qdrant-e2e:6333' } });
    const vs = await res.json();
    expect((await request.get(`${API_URL}/vector-stores/${vs.id}/collections`)).ok()).toBe(true);
    expect((await request.post(`${API_URL}/vector-stores/${vs.id}/refresh`)).ok()).toBe(true);
    await request.delete(`${API_URL}/vector-stores/${vs.id}`);
  });

  // ─── Knowledge ────────────────────────────────────────────────
  test('list_knowledge_collections', async ({ request }) => {
    const upRes = await request.post(`${API_URL}/knowledge/upload`, {
      data: { name: 'CP ListCol', content: 'collection listing check', collectionName: 'cp-list-col' },
    });
    expect(upRes.status()).toBe(201);
    const doc = await upRes.json();

    const res = await request.get(`${API_URL}/knowledge/collections`);
    expect(res.ok()).toBe(true);
    const cols = await res.json();
    expect(Array.isArray(cols)).toBe(true);
    const col = cols.find((c: any) => c.collection_name === 'cp-list-col');
    expect(col).toBeDefined();
    expect(col.document_count).toBeGreaterThanOrEqual(1);

    await request.delete(`${API_URL}/documents/${doc.id}`);
  });

  test('get_knowledge_collection — returns collection', async ({ request }) => {
    const res = await request.post(`${API_URL}/knowledge/upload`, { data: { name: 'CP KDoc', content: 'test content', collectionName: 'cp-col' } });
    const doc = await res.json();
    expect((await request.get(`${API_URL}/knowledge/collections/cp-col`)).ok()).toBe(true);
    await request.delete(`${API_URL}/documents/${doc.id}`);
  });

  test('upload_knowledge_document — uploads to collection', async ({ request }) => {
    const res = await request.post(`${API_URL}/knowledge/upload`, { data: { name: 'CP UpDoc', content: 'knowledge upload test', collectionName: 'cp-upload' } });
    expect(res.status()).toBe(201);
    const doc = await res.json();
    expect(doc.id).toBeDefined();
    expect(doc.chunkCount).toBeGreaterThan(0);

    // The document is listed in the collection
    const colRes = await request.get(`${API_URL}/knowledge/collections/cp-upload`);
    expect(colRes.ok()).toBe(true);
    const docs = await colRes.json();
    expect(docs.some((d: any) => d.id === doc.id)).toBe(true);

    await request.delete(`${API_URL}/documents/${doc.id}`);
  });

  test('delete_knowledge_collection + delete_knowledge_document', async ({ request }) => {
    const res = await request.post(`${API_URL}/knowledge/upload`, { data: { name: 'CP DelDoc', content: 'to delete', collectionName: 'cp-del-col' } });
    const doc = await res.json();
    expect((await request.delete(`${API_URL}/knowledge/documents/${doc.id}`)).ok()).toBe(true);
    expect((await request.delete(`${API_URL}/knowledge/collections/cp-del-col`)).ok()).toBe(true);
  });

  // ─── Environment Variables ─────────────────────────────────────
  test('list_env_vars + update_env_vars', async ({ request }) => {
    expect((await request.get(`${API_URL}/env-vars`)).ok()).toBe(true);
    expect((await request.put(`${API_URL}/env-vars`, { data: { envVars: [] } })).ok()).toBe(true);
  });

  test('get_group_env_vars + set_group_env_vars', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-EnvGrp-${Date.now()}` } });
    const grp = await gRes.json();
    expect((await request.put(`${API_URL}/env-vars/groups/${grp.id}`, { data: { envVars: [] } })).ok()).toBe(true);
    expect((await request.get(`${API_URL}/env-vars/groups/${grp.id}`)).ok()).toBe(true);
    await request.delete(`${API_URL}/groups/${grp.id}`);
  });

  // ─── Admin ─────────────────────────────────────────────────────
  test('list_roles — returns roles', async ({ request }) => {
    const res = await request.get(`${API_URL}/roles`);
    expect(res.ok()).toBe(true);
    const roles = await res.json();
    expect(roles.some((r: any) => r.name === 'admin')).toBe(true);
  });

  test('set_user_groups + update_group_member_role', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CP-AdminGrp-${Date.now()}` } });
    const grp = await gRes.json();
    const users = await (await request.get(`${API_URL}/users`)).json();
    const target = users[0];
    expect((await request.put(`${API_URL}/users/${target.id}/groups`, { data: { groupIds: [grp.id] } })).ok()).toBe(true);
    expect((await request.put(`${API_URL}/groups/${grp.id}/members/${target.id}/role`, { data: { role: 'admin' } })).ok()).toBe(true);
    await request.delete(`${API_URL}/groups/${grp.id}`);
  });

  // ─── Profile / Auth ───────────────────────────────────────────
  test('change_password + get_auth_config + get_setup_status + get_my_profile', async ({ request }) => {
    expect((await request.get(`${API_URL}/auth/config`)).ok()).toBe(true);
    expect((await request.get(`${API_URL}/auth/setup-status`)).ok()).toBe(true);
    const profileRes = await request.get(`${API_URL}/auth/profile`);
    expect(profileRes.ok()).toBe(true);
    const profile = await profileRes.json();
    expect(profile.email).toBe('e2e@test.local');
    expect((await request.put(`${API_URL}/auth/password`, { data: { currentPassword: 'Test1234!', newPassword: 'NewCP5678!' } })).ok()).toBe(true);
    expect((await request.put(`${API_URL}/auth/password`, { data: { currentPassword: 'NewCP5678!', newPassword: 'Test1234!' } })).ok()).toBe(true);
  });

  // ─── Assignments ──────────────────────────────────────────────
  // Mounted at /api/assignments per backend/src/index.ts:102
  test('GET /api/assignments returns the current user\'s assignments', async ({ request }) => {
    const res = await request.get(`${API_URL}/assignments`);
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);

    const pendingRes = await request.get(`${API_URL}/assignments?status=pending`);
    expect(pendingRes.status()).toBe(200);
    const pending = await pendingRes.json();
    expect(Array.isArray(pending)).toBe(true);
    expect(pending.every((a: any) => a.status === 'pending')).toBe(true);
  });

  test('POST /api/assignments/:id/decide validates decisions and unknown ids', async ({ request }) => {
    // Invalid decision is rejected before the assignment lookup
    const badRes = await request.post(`${API_URL}/assignments/00000000-0000-0000-0000-000000000000/decide`, {
      data: { status: 'maybe' },
    });
    expect(badRes.status()).toBe(400);

    // Valid decision on a non-existent assignment -> 404
    const missingRes = await request.post(`${API_URL}/assignments/00000000-0000-0000-0000-000000000000/decide`, {
      data: { status: 'approved' },
    });
    expect(missingRes.status()).toBe(404);
  });

  test('list_assignments + decide_assignment — via HITL flow', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPAssign'), nodes: [
      { id: 't1', type: 'trigger', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
      { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Go', buttons: [{ label: 'Go', value: 'go' }] } } },
      { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
    ], edges: [
      { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
      { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
    ] });
    const flow = await flowRes.json();
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const cookie = (await import('./helpers/auth')).getAuthCookie() || undefined;
    const { executionId } = await executeUntilPaused(flow.id, { message: 'test' }, cookie);

    // The paused HITL shows up as a pending execution (assignments are
    // approved through /executions/:id/approve — see execution.ts)
    const pending = await (await request.get(`${API_URL}/executions/pending`)).json();
    expect(pending.some((e: any) => e.id === executionId)).toBe(true);

    // The HITL pause also mirrors into the assignments table — a pending
    // assignment must exist for the current user
    const assignments = await (await request.get(`${API_URL}/assignments?status=pending`)).json();
    const mine = assignments.find((a: any) => a.execution_id === executionId);
    expect(mine).toBeDefined();
    expect(mine.status).toBe('pending');
    expect(mine.hitl_node_id).toBe('h1');

    // Positive path: decide the assignment (approve)
    const decideRes = await request.post(`${API_URL}/assignments/${mine.id}/decide`, {
      data: { status: 'approved', feedback: 'looks good' },
    });
    expect(decideRes.status()).toBe(200);
    expect((await decideRes.json()).status).toBe('updated');

    // Assignment is no longer pending, feedback is persisted
    const after = await (await request.get(`${API_URL}/assignments`)).json();
    const decided = after.find((a: any) => a.id === mine.id);
    expect(decided.status).toBe('approved');
    expect(decided.feedback).toBe('looks good');
    expect(decided.decided_by_user_id).toBeTruthy();

    // Deciding again must fail (already decided)
    const againRes = await request.post(`${API_URL}/assignments/${mine.id}/decide`, {
      data: { status: 'rejected' },
    });
    expect(againRes.status()).toBe(400);

    // Reject path on a fresh assignment
    const rejectFlowRes = await createFlow(request, { name: uniqueFlowName('CPAssignReject'), nodes: [
      { id: 't1', type: 'trigger', data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
      { id: 'h1', type: 'hitl', position: { x: 300, y: 0 }, data: { label: 'Gate', type: 'hitl', config: { prompt: 'Go', buttons: [{ label: 'Go', value: 'go' }] } } },
      { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
    ], edges: [
      { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
      { id: 'e2', source: 'h1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
    ] });
    const rejectFlow = await rejectFlowRes.json();
    const { executionId: rejectExecId } = await executeUntilPaused(rejectFlow.id, { message: 'test' }, cookie);
    const assignments2 = await (await request.get(`${API_URL}/assignments?status=pending`)).json();
    const rejectAssign = assignments2.find((a: any) => a.execution_id === rejectExecId);
    expect(rejectAssign).toBeDefined();
    const rejectDecide = await request.post(`${API_URL}/assignments/${rejectAssign.id}/decide`, {
      data: { status: 'rejected' },
    });
    expect(rejectDecide.status()).toBe(200);
    const after2 = await (await request.get(`${API_URL}/assignments`)).json();
    expect(after2.find((a: any) => a.id === rejectAssign.id).status).toBe('rejected');
    await deleteFlow(request, rejectFlow.id);

    // Complete the first flow via the execution-level approve endpoint and
    // confirm the assignment was marked decided in sync
    const approveRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'go' }),
    });
    expect(approveRes.ok).toBe(true);
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
    const finalAssign = await (await request.get(`${API_URL}/assignments`)).json();
    expect(finalAssign.find((a: any) => a.id === mine.id).status).toBe('approved');
    await deleteFlow(request, flow.id);
  });

  // ─── Chat Sessions ────────────────────────────────────────────
  test('list_chat_sessions + create_chat_session + delete_chat_session', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPChat'),
      nodes: [{ id: 't1', type: 'trigger', data: { label: 'Chat', type: 'trigger', config: { triggerType: 'chat' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } }],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();
    const listRes = await request.get(`${API_URL}/chat/${flow.id}/sessions`);
    expect(listRes.ok()).toBe(true);
    const createRes = await request.post(`${API_URL}/chat/${flow.id}/sessions`, { data: { title: 'CP Session' } });
    expect(createRes.ok()).toBe(true);
    const session = await createRes.json();
    expect((await request.delete(`${API_URL}/chat/sessions/${session.id}`)).ok()).toBe(true);
    await deleteFlow(request, flow.id);
  });

  // ─── Chat API ─────────────────────────────────────────────────
  test('chat_api_deployment + keys CRUD', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPChatAPI'),
      nodes: [{ id: 't1', type: 'trigger', data: { label: 'Chat', type: 'trigger', config: { triggerType: 'chat' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } }],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();
    expect((await request.get(`${API_URL}/flows/${flow.id}/chat-api/deployment`)).ok()).toBe(true);
    expect((await request.put(`${API_URL}/flows/${flow.id}/chat-api/deployment`, { data: { enabled: true, model_name: 'test-model' } })).ok()).toBe(true);
    expect((await request.get(`${API_URL}/flows/${flow.id}/chat-api/keys`)).ok()).toBe(true);
    const keyRes = await request.post(`${API_URL}/flows/${flow.id}/chat-api/keys`, { data: { label: 'CP Key' } });
    expect(keyRes.status()).toBe(201);
    const key = await keyRes.json();
    expect(key.raw_key).toBeTruthy();
    expect(key.key_prefix).toBeTruthy();
    expect((await request.delete(`${API_URL}/flows/${flow.id}/chat-api/keys/${key.id}`)).status()).toBe(204);
    await deleteFlow(request, flow.id);
  });

  // ─── Webhook API ──────────────────────────────────────────────
  test('webhook_deployment + keys CRUD', async ({ request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('CPWebhook'),
      nodes: [{ id: 't1', type: 'trigger', data: { label: 'Webhook', type: 'trigger', config: { triggerType: 'webhook' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } }],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();
    expect((await request.get(`${API_URL}/flows/${flow.id}/deployment`)).ok()).toBe(true);
    expect((await request.put(`${API_URL}/flows/${flow.id}/deployment`, { data: { pathSlug: 'cp-webhook', rateLimit: 5, summary: 'CP test' } })).ok()).toBe(true);
    const renewRes = await request.post(`${API_URL}/flows/${flow.id}/keys/renew`);
    expect(renewRes.ok()).toBe(true);
    const renewed = await renewRes.json();
    expect(renewed.rawKey).toMatch(/^wh_/);
    expect(renewed.prefix).toMatch(/^wh_/);
    expect(renewed.createdAt).toBeDefined();
    expect((await request.delete(`${API_URL}/flows/${flow.id}/keys/revoke`)).status()).toBe(204);
    await deleteFlow(request, flow.id);
  });

  // ─── Secrets (additional) ─────────────────────────────────────
  test('reveal_secret + get_secret_audit_log + re_encrypt_secrets', async ({ request }) => {
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: 'CP Reveal', value: 'secret-val', scope: 'app' } });
    const sec = await secRes.json();
    expect((await request.post(`${API_URL}/secrets/${sec.id}/reveal`)).ok()).toBe(true);
    expect((await request.get(`${API_URL}/secrets/audit-log`)).ok()).toBe(true);
    expect((await request.post(`${API_URL}/secrets/re-encrypt`)).ok()).toBe(true);
    await request.delete(`${API_URL}/secrets/${sec.id}`);
  });
});
