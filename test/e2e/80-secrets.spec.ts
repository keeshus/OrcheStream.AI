import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const cookie = getAuthCookie() || undefined;

test.describe('Secrets management', () => {
  const cleanupSecretIds: string[] = [];
  const cleanupVaultIds: string[] = [];
  const cleanupGroupIds: string[] = [];
  const cleanupFlowIds: string[] = [];
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const llmRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Mock LLM Secrets', providerType: 'openai', baseUrl: 'http://mock-llm-e2e:3002/v1', apiKey: 'mock-key', defaultModel: 'mock-gpt-4', models: ['mock-gpt-4'] },
    });
    if (llmRes.ok()) { const ep = await llmRes.json(); mockEndpointId = ep.id; }
  });

  test.afterAll(async ({ request }) => {
    if (mockEndpointId) await request.delete(`${API_URL}/llm-endpoints/${mockEndpointId}`);
  });

  test.afterEach(async ({ request }) => {
    for (const id of cleanupSecretIds) { await request.delete(`${API_URL}/secrets/${id}`).catch(() => {}); }
    for (const id of cleanupVaultIds) { await request.delete(`${API_URL}/secret-vaults/${id}`).catch(() => {}); }
    for (const id of cleanupGroupIds) { await request.delete(`${API_URL}/groups/${id}`).catch(() => {}); }
    for (const id of cleanupFlowIds) { await deleteFlow(request, id).catch(() => {}); }
    cleanupSecretIds.length = cleanupVaultIds.length = cleanupGroupIds.length = cleanupFlowIds.length = 0;
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── App-scoped secrets ─────────────────────────────────────
  // NOTE: happy-path create/reveal/delete via API were removed — the
  // secrets settings page covers them through the UI below. Only
  // contracts (no-leak, validation) remain.
  // ═══════════════════════════════════════════════════════════════

  test('list secrets returns metadata only (no values)', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, { data: { name: 'db-pass', value: 'secret123', scope: 'app' } });
    const secret = await res.json();
    cleanupSecretIds.push(secret.id);

    // List should not contain the value
    const listRes = await request.get(`${API_URL}/secrets?scope=app`);
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    const found = list.find((s: any) => s.id === secret.id);
    expect(found).toBeDefined();
    expect(found.encrypted_value).toBeUndefined();
  });

  // NOTE: the API-level reveal/delete happy-path tests were removed — they
  // are covered through the secrets page UI below ('reveal a secret via UI…',
  // 'delete a secret via UI…').

  test('rejects duplicate secret name in same scope', async ({ request }) => {
    const res = await request.post(`${API_URL}/secrets`, { data: { name: 'dup-test', value: 'first', scope: 'app' } });
    expect(res.status()).toBe(201);
    const secret = await res.json();
    cleanupSecretIds.push(secret.id);

    const dupRes = await request.post(`${API_URL}/secrets`, { data: { name: 'dup-test', value: 'second', scope: 'app' } });
    expect(dupRes.status()).toBe(409);
  });

  test('rejects empty name or value', async ({ request }) => {
    const res1 = await request.post(`${API_URL}/secrets`, { data: { name: '', value: 'x', scope: 'app' } });
    expect(res1.status()).toBe(400);

    const res2 = await request.post(`${API_URL}/secrets`, { data: { name: 'x', value: '', scope: 'app' } });
    expect(res2.status()).toBe(400);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Flow-scoped secrets in Flow Settings modal ─────────────
  // ═══════════════════════════════════════════════════════════════

  test('flow-level secrets appear in Flow Settings modal', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('Secret-Flow') });
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    // Add a flow-level secret via API
    const secRes = await request.post(`${API_URL}/secrets`, {
      data: { name: 'flow-token', value: 'flow-secret-value', scope: 'flow', scopeId: flow.id },
    });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings modal
    await page.locator('button').filter({ hasText: 'settings' }).click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Flow Secrets section should be visible with the secret
    await expect(page.getByText('Flow Secrets')).toBeVisible();
    await expect(page.getByText('flow-token')).toBeVisible();
  });

  test('create flow-level secret from Flow Settings modal', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('Secret-Create') });
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings (settings icon in the top bar)
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Fill in new secret fields
    await page.getByTestId('flow-secret-name').fill('db-password');
    await page.getByTestId('flow-secret-value').fill('s3cr3t');

    // Click the add button (the one with the add icon, last in the secrets row)
    await page.getByTestId('flow-secret-value').locator('..').locator('button[class*="m3-button"]').click();

    // The secret should appear in the list
    await expect(page.getByText('db-password')).toBeVisible({ timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── CyberArk vault ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('create a Conjur vault config', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Group-${Date.now()}` } });
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: {
        name: 'Test Conjur',
        vaultType: 'cyberark',
        baseUrl: 'http://mock-cyberark-e2e:3005',
        account: 'conjur',
        login: 'host/myapp',
        apiKey: 'myapp-api-key-456',
        groupId: group.id,
      },
    });
    expect(res.status()).toBe(201);
    const vault = await res.json();
    expect(vault.name).toBe('Test Conjur');
    expect(vault.hasApiKey).toBe(true);
    // The actual api_key should NOT be in the response
    expect(vault.api_key).toBeUndefined();
    cleanupVaultIds.push(vault.id);
  });

  test('test connection to Conjur vault', async ({ request }) => {
    // NOTE: the UI path (create vault + Test button + check_circle) is
    // covered by 'create a vault via the UI and test the connection'.
    // This contract pins the API response shape.
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Group-${Date.now()}` } });
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);
    const res = await request.post(`${API_URL}/secret-vaults`, {
      data: {
        name: 'Connectable Vault',
        vaultType: 'cyberark',
        baseUrl: 'http://mock-cyberark-e2e:3005',
        account: 'conjur',
        login: 'host/myapp',
        apiKey: 'myapp-api-key-456',
        groupId: group.id,
      },
    });
    expect(res.status()).toBe(201);
    const vault = await res.json();
    expect(vault.name).toBe('Connectable Vault');

    const testRes = await request.post(`${API_URL}/secret-vaults/${vault.id}/test`);
    expect(testRes.status()).toBe(200);
    const testResult = await testRes.json();
    expect(testResult.success).toBe(true);
  });

  test('bind a vault to a group via group-vault-config (admin contract)', async ({ request }) => {
    // Creating a vault with a groupId auto-binds it (see routes/secret-vaults.ts);
    // this endpoint is for repointing the group's active vault. Kept as an
    // admin contract — no UI exists for the active-vault picker.
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Group-${Date.now()}` } });
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);
    const vRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'Group Vault', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'myapp-api-key-456', groupId: group.id },
    });
    const vault = await vRes.json();
    cleanupVaultIds.push(vault.id);

    await request.post(`${API_URL}/secret-vaults/${vault.id}/test`);

    const bindRes = await request.put(`${API_URL}/group-vault-config/${group.id}`, {
      data: { vaultId: vault.id, enabled: true },
    });
    expect(bindRes.status()).toBe(200);
    const bindResult = await bindRes.json();
    expect(bindResult.status).toBe('updated');

    const getBindRes = await request.get(`${API_URL}/group-vault-config/${group.id}`);
    expect(getBindRes.status()).toBe(200);
    const binding = await getBindRes.json();
    expect(binding.vaultId).toBe(vault.id);
    expect(binding.enabled).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Secrets in template resolution ─────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('{{secrets.core.app:NAME}} resolves in LLM system prompt', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Create an app-level secret
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: 'app-greeting', value: 'Hello from app secret!', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    // Create a flow that references the secret in the system prompt
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Secret-Resolve'),
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 }, data: { label: 'Assistant', type: 'llm-agent', config: { endpointId: mockEndpointId, model: 'mock-gpt-4', systemPrompt: 'ECHO_SYSTEM_PROMPT\nThe greeting is: {{secrets.core.app:app-greeting}}', temperature: 0.7, maxTokens: 1024, responseFormat: 'text' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Assistant.content'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
          { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    // The mock LLM echoed the full system prompt — the secret should be resolved
    expect(outputStr).toContain('Hello from app secret!');
    // The template tag should be replaced, not present as-is
    expect(outputStr).not.toContain('{{secrets.core.app:app-greeting}}');
  });

  test('{{secrets.cyberark.PATH}} resolves from bound Conjur vault', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Create a group first (vaults require a group)
    const groupName = `Conjur-Group-${Date.now()}`;
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: groupName } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    // Create a Conjur vault bound to the group
    const vRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'E2E Conjur', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'myapp-api-key-456', groupId: group.id },
    });
    expect(vRes.status()).toBe(201);
    const vault = await vRes.json();
    cleanupVaultIds.push(vault.id);

    // Connect it
    await request.post(`${API_URL}/secret-vaults/${vault.id}/test`);

    // Bind the vault to the group via group-vault-config
    await request.put(`${API_URL}/group-vault-config/${group.id}`, {
      data: { vaultId: vault.id, enabled: true },
    });

    // Create a flow in this group with a system prompt referencing a Conjur secret
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Conjur-Resolve'),
        group_id: group.id,
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 }, data: { label: 'Assistant', type: 'llm-agent', config: { endpointId: mockEndpointId, model: 'mock-gpt-4', systemPrompt: 'ECHO_SYSTEM_PROMPT\nThe DB password is: {{secrets.cyberark.prod/db/password}}', temperature: 0.7, maxTokens: 1024, responseFormat: 'text' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Assistant.content'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
          { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    // The Conjur secret should be resolved in the prompt
    expect(outputStr).toContain('sup3r-s3cr3t-db-pass!');
    expect(outputStr).not.toContain('{{secrets.cyberark.prod/db/password}}');
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Secrets settings page ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('secrets settings page loads', async ({ page }) => {
    await page.goto('/settings/secrets');
    await expect(page.locator('h1').filter({ hasText: 'Secrets' }).first()).toBeVisible({ timeout: 10000 });
  });

  test('secrets vault settings page loads and shows vault list', async ({ page, request }) => {
    await page.goto('/settings/secret-vaults');
    // Wait for the actual page content to render (not just the shell)
    await expect(page.getByText('Add Vault')).toBeVisible({ timeout: 10000 });
    // Verify the React component rendered without crashing
    const hasCrashed = await page.getByText('Secret Vaults').isVisible().catch(() => false);
    expect(hasCrashed).toBe(true);
    // Verify API access works
    const listRes = await request.get(`${API_URL}/secret-vaults`);
    expect(listRes.status()).toBe(200);
  });

  test('settings navigation shows secrets links', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Secrets').first()).toBeVisible();
    await expect(page.getByText('Secret Vaults').first()).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Vault creation: "Bind to group (required)" selector ─────
  // ═══════════════════════════════════════════════════════════════

  test('vault creation form shows Bind to group (required) selector', async ({ page, request }) => {
    // Create a group
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Bind-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    await page.goto('/settings/secret-vaults');
    await page.waitForTimeout(1000);

    // Click "Add Vault"
    await page.getByRole('button', { name: 'Add Vault' }).click();
    await page.waitForTimeout(500);

    // The "Bind to group (required)" selector should be visible
    await expect(page.getByText('Bind to group (required)')).toBeVisible({ timeout: 5000 });

    // The Create button should be disabled until a group is selected
    const createBtn = page.getByRole('button', { name: 'Create Vault' });
    await expect(createBtn).toBeDisabled();

    // Select the group in the form (the trigger exposes its label as accessible name)
    await page.getByRole('button', { name: 'Bind to group (required)' }).click();
    await page.getByText(group.name).first().click();
    await page.waitForTimeout(300);

    // Fill in required fields
    await page.getByLabel('Name').fill('Test Vault');
    await page.getByLabel('URL').fill('http://mock-cyberark-e2e:3005');
    await page.getByLabel('Login').fill('host/myapp');
    await page.getByLabel('API Key').fill('myapp-api-key-456');

    // Now Create Vault should be enabled
    await expect(createBtn).toBeEnabled();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Secrets page group filter ───────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('secrets page group filter works', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Sec-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    await page.goto('/settings/secrets');
    await page.waitForTimeout(1000);
    await expect(page.getByText('Filter by group')).toBeVisible({ timeout: 5000 });

    await page.getByText('All items').first().click();
    await page.getByText(group.name).first().click();
    await page.waitForTimeout(500);
    await expect(page.getByText(group.name).first()).toBeVisible({ timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Group-scoped secrets: CRUD + list scope filter ──────────
  // ═══════════════════════════════════════════════════════════════

  test('group-scoped secret: full lifecycle via the secrets page UI', async ({ page, request }) => {
    const appName = `app-scoped-${Date.now()}`;
    const grpName = `group-scoped-${Date.now()}`;
    // Create a group
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Scoped-Sec-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    // ── Create both secrets via the UI form ──
    await page.goto('/settings/secrets');
    await page.getByRole('button', { name: 'Add Secret' }).click();
    await expect(page.getByRole('heading', { name: 'New Secret' })).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Secret name').fill(appName);
    await page.getByLabel('Value').fill('app-value');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(appName)).toBeVisible({ timeout: 5000 });
    cleanupSecretIds.push((await (await request.get(`${API_URL}/secrets?scope=app`)).json()).find((s: any) => s.name === appName)?.id);

    await page.getByRole('button', { name: 'Add Secret' }).click();
    await expect(page.getByRole('heading', { name: 'New Secret' })).toBeVisible({ timeout: 5000 });
    const form = page.getByRole('heading', { name: 'New Secret' }).locator('..');
    await form.getByRole('button', { name: /App-wide/ }).click();
    await page.getByRole('button', { name: group.name, exact: true }).last().click();
    await expect(page.getByRole('button', { name: 'CyberArk', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Secret name').fill(grpName);
    await page.getByLabel('Value').fill('group-value');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(grpName)).toBeVisible({ timeout: 5000 });
    cleanupSecretIds.push((await (await request.get(`${API_URL}/secrets?scope=group&scopeId=${group.id}`)).json()).find((s: any) => s.name === grpName)?.id);

    // ── The page shows both secrets with their scope labels ──
    await expect(page.getByText('app-wide', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(group.name).first()).toBeVisible();

    // ── Filter by the group — only the group-scoped secret remains ──
    await page.getByText('All items').first().click();
    await page.getByText(group.name, { exact: true }).first().click();
    await expect(page.getByText(grpName)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(appName)).not.toBeVisible({ timeout: 5000 });

    // ── Edit the group-scoped secret value via the UI ──
    const grpRow = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: grpName }).first();
    await grpRow.getByTestId('edit-secret-btn').click();
    await expect(page.getByTestId('edit-secret-value')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('edit-secret-value').fill('updated-group-value');
    await page.getByTestId('save-secret-value').click();
    await expect(page.getByTestId('save-secret-value')).toHaveCount(0, { timeout: 5000 });

    // ── Reveal via the UI shows the updated value ──
    const row2 = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: grpName }).first();
    await row2
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'visibility' }) })
      .click();
    await expect(page.getByText('Reveal secret?')).toBeVisible();
    await page.getByRole('button', { name: 'Reveal' }).click();
    await expect(page.getByText(/updated-group-value/)).toBeVisible({ timeout: 5000 });

    // ── Delete via the UI ──
    const row3 = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: grpName }).first();
    await row3
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'delete' }) })
      .click();
    await expect(page.getByText('Delete secret?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(grpName)).not.toBeVisible({ timeout: 5000 });

    // Backend reflects the deletion
    const grpSecret = (await (await request.get(`${API_URL}/secrets?scope=group&scopeId=${group.id}`)).json()).find((s: any) => s.name === grpName);
    expect(grpSecret).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Reveal / delete via UI on the secrets page ─────────────
  // ═══════════════════════════════════════════════════════════════

  test('reveal a secret via UI shows plaintext for 10 seconds', async ({ page, request }) => {
    const secName = `reveal-me-${Date.now()}`;
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: secName, value: 'revealed-plaintext-xyz', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    await page.goto('/settings/secrets');
    await expect(page.getByText(secName)).toBeVisible({ timeout: 5000 });

    // Click the reveal (visibility) button on the secret row
    const row = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: secName }).first();
    await row
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'visibility' }) })
      .click();

    // The UI asks for confirmation before revealing
    await expect(page.getByText('Reveal secret?')).toBeVisible();
    await page.getByRole('button', { name: 'Reveal' }).click();

    // The plaintext value appears on screen
    await expect(page.getByText(/revealed-plaintext-xyz/)).toBeVisible({ timeout: 5000 });
  });

  test('delete a secret via UI with confirm dialog', async ({ page, request }) => {
    const secName = `delete-via-ui-${Date.now()}`;
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: secName, value: 'delete-me', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();

    await page.goto('/settings/secrets');
    await expect(page.getByText(secName)).toBeVisible({ timeout: 5000 });

    // Click the delete button on the secret row
    const row = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: secName }).first();
    await row
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'delete' }) })
      .click();

    // Confirm in the dialog
    await expect(page.getByText('Delete secret?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();

    // The secret disappears from the list
    await expect(page.getByText(secName)).not.toBeVisible({ timeout: 5000 });

    // Backend reflects the deletion
    const getRes = await request.get(`${API_URL}/secrets/${secret.id}`);
    expect(getRes.status()).toBe(404);
  });

  test('create an app secret via the UI form', async ({ page, request }) => {
    const secName = `ui-app-secret-${Date.now()}`;

    await page.goto('/settings/secrets');
    await expect(page.getByText('Secrets', { exact: true }).first()).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Add Secret' }).click();
    await expect(page.getByRole('heading', { name: 'New Secret' })).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Secret name').fill(secName);
    await page.getByLabel('Value').fill('ui-value-123');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(page.getByText(secName)).toBeVisible({ timeout: 5000 });

    const listRes = await request.get(`${API_URL}/secrets?scope=app`);
    const list = await listRes.json();
    const created = list.find((s: any) => s.name === secName);
    expect(created).toBeDefined();
    expect(created.scope).toBe('app');
    cleanupSecretIds.push(created.id);
  });

  test('create a group secret via the UI with the Core/CyberArk type toggle', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Sec-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    await page.goto('/settings/secrets');
    await expect(page.getByText('Secrets', { exact: true }).first()).toBeVisible({ timeout: 10000 });

    // ── Helper: select a group in the Add Secret form's Group select ──
    const selectFormGroup = async () => {
      // The form's Group select button shows "App-wide" (its allLabel) when
      // no group is chosen. The icon text is concatenated into the accessible
      // name, so match by substring. Scope to the form via its heading.
      const form = page.getByRole('heading', { name: 'New Secret' }).locator('..');
      await form.getByRole('button', { name: /App-wide/ }).click();
      // Pick the group from the open dropdown (last match is inside the popover)
      await page.getByRole('button', { name: group.name, exact: true }).last().click();
      await page.waitForTimeout(300);
      // Verify the toggle appeared (group selected)
      await expect(page.getByRole('button', { name: 'CyberArk', exact: true })).toBeVisible({ timeout: 5000 });
    };

    // ── Core group secret ──
    await page.getByRole('button', { name: 'Add Secret' }).click();
    await expect(page.getByRole('heading', { name: 'New Secret' })).toBeVisible({ timeout: 5000 });
    await selectFormGroup();
    await expect(page.getByRole('button', { name: 'Core', exact: true })).toBeVisible({ timeout: 5000 });

    const coreName = `ui-group-core-${Date.now()}`;
    await page.getByLabel('Secret name').fill(coreName);
    await page.getByLabel('Value').fill('group-value-123');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(coreName)).toBeVisible({ timeout: 5000 });

    const listRes = await request.get(`${API_URL}/secrets?scope=group&scopeId=${group.id}`);
    const list = await listRes.json();
    const coreSecret = list.find((s: any) => s.name === coreName);
    expect(coreSecret).toBeDefined();
    expect(coreSecret.scope).toBe('group');
    cleanupSecretIds.push(coreSecret.id);

    // ── CyberArk group secret (reference path) ──
    await page.getByRole('button', { name: 'Add Secret' }).click();
    await expect(page.getByRole('heading', { name: 'New Secret' })).toBeVisible({ timeout: 5000 });
    await selectFormGroup();
    await page.getByRole('button', { name: 'CyberArk', exact: true }).click();

    const arkName = `ui-group-ark-${Date.now()}`;
    await page.getByLabel('Secret name').fill(arkName);
    await page.getByLabel('Reference path').fill('prod/db/password');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText(arkName)).toBeVisible({ timeout: 5000 });

    const listRes2 = await request.get(`${API_URL}/secrets?scope=group&scopeId=${group.id}`);
    const arkSecret = (await listRes2.json()).find((s: any) => s.name === arkName);
    expect(arkSecret).toBeDefined();
    expect(arkSecret.secretType || arkSecret.secret_type).toBe('cyberark');
    cleanupSecretIds.push(arkSecret.id);
  });

  test('rotate key and re-encrypt via the UI (admin panel)', async ({ page, request }) => {
    // Seed a secret so rotate/re-encrypt have something to operate on
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: `rot-${Date.now()}`, value: 'rotate-me', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    await page.goto('/settings/secrets');
    await expect(page.getByText('Secrets', { exact: true }).first()).toBeVisible({ timeout: 10000 });

    // ── Rotate key ──
    await page.getByRole('button', { name: 'Rotate Key' }).click();
    await expect(page.getByText('Rotate encryption key?')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Rotate' }).click();
    // Success: no error banner, panel still present
    await expect(page.getByRole('button', { name: 'Rotate Key' })).toBeVisible({ timeout: 5000 });

    // ── Re-encrypt all ──
    await page.getByRole('button', { name: 'Re-encrypt All' }).click();
    await expect(page.getByText('Re-encrypt all secrets with the current key?')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Re-encrypt' }).click();
    await expect(page.getByRole('button', { name: 'Re-encrypt All' })).toBeVisible({ timeout: 5000 });

    // The secret still resolves after the rotation
    const revealRes = await request.post(`${API_URL}/secrets/${secret.id}/reveal`);
    expect(revealRes.status()).toBe(200);
    expect((await revealRes.json()).value).toBe('rotate-me');
  });

  test('delete a vault via UI with confirm dialog', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Delete-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    const vaultName = `Vault-Delete-Me-${Date.now()}`;
    const vRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: vaultName, vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'myapp-api-key-456', groupId: group.id },
    });
    expect(vRes.status()).toBe(201);
    const vault = await vRes.json();

    await page.goto('/settings/secret-vaults');
    await expect(page.getByText(vaultName)).toBeVisible({ timeout: 10000 });

    // Click the Delete button on the vault card
    const card = page.locator('div.bg-surface.rounded-lg.border.border-outline-variant.p-4').filter({ hasText: vaultName }).first();
    await card.getByRole('button', { name: 'Delete' }).click();

    // Confirm in the dialog
    await expect(page.getByText('Delete vault?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();

    // The vault disappears from the list
    await expect(page.getByText(vaultName)).not.toBeVisible({ timeout: 5000 });

    // Backend reflects the deletion — the vault is gone from the list
    const listRes = await request.get(`${API_URL}/secret-vaults`);
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    const stillPresent = list.some((v: any) => v.id === vault.id);
    expect(stillPresent).toBe(false);
  });

  test('secret vaults page group filter filters the list', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Filter-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    // Create a vault bound to the group + one unbound (app-wide)
    const boundRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: `Vault-Bound-${Date.now()}`, vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'k', groupId: group.id },
    });
    const bound = await boundRes.json();
    cleanupVaultIds.push(bound.id);

    await page.goto('/settings/secret-vaults');
    await expect(page.getByRole('heading', { name: 'Secret Vaults' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(bound.name)).toBeVisible({ timeout: 5000 });

    // Select the group in the filter → only the bound vault remains
    await page.getByText('All items').first().click();
    await page.getByText(group.name).first().click();
    await page.waitForTimeout(500);

    await expect(page.getByText(bound.name)).toBeVisible({ timeout: 5000 });

    // Backend filtering matches (GET with group_id returns only the bound vault)
    const filtered = await (await request.get(`${API_URL}/secret-vaults?group_id=${group.id}`)).json();
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe(bound.id);
  });

  test('edit a vault via the UI', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Edit-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    const vaultName = `Vault-Edit-Me-${Date.now()}`;
    const vRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: vaultName, vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'myapp-api-key-456', groupId: group.id },
    });
    expect(vRes.status()).toBe(201);
    const vault = await vRes.json();
    cleanupVaultIds.push(vault.id);

    await page.goto('/settings/secret-vaults');
    const card = page.locator('div.bg-surface.rounded-lg.border.border-outline-variant.p-4').filter({ hasText: vaultName }).first();
    await expect(card).toBeVisible({ timeout: 10000 });

    const editedName = `${vaultName}-Renamed`;
    await card.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Vault' })).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Name').fill(editedName);
    await page.getByRole('button', { name: 'Update Vault' }).click();
    await expect(page.getByText(editedName)).toBeVisible({ timeout: 5000 });

    const after = await (await request.get(`${API_URL}/secret-vaults/${vault.id}`)).json();
    expect(after.name).toBe(editedName);
  });

  test('create a vault via the UI and test the connection', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Vault-Create-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    const vaultName = `Vault-UI-Created-${Date.now()}`;
    await page.goto('/settings/secret-vaults');
    await expect(page.getByRole('heading', { name: 'Secret Vaults' })).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Add Vault' }).click();
    await expect(page.getByLabel('Name')).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Name').fill(vaultName);
    await page.getByLabel('URL').fill('http://mock-cyberark-e2e:3005');
    await page.getByLabel('Login').fill('host/myapp');
    await page.getByLabel('API Key').fill('myapp-api-key-456');
    // Bind to group (the vault form's group select trigger exposes its label as accessible name)
    await page.getByRole('button', { name: 'Bind to group (required)' }).click();
    await page.getByText(group.name, { exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Create Vault' }).click();

    await expect(page.getByText(vaultName)).toBeVisible({ timeout: 5000 });

    const listRes = await request.get(`${API_URL}/secret-vaults`);
    const vault = (await listRes.json()).find((v: any) => v.name === vaultName);
    expect(vault).toBeDefined();
    cleanupVaultIds.push(vault.id);

    // ── Test connection via the UI (mock CyberArk returns success) ──
    const card = page.locator('div.bg-surface.rounded-lg.border.border-outline-variant.p-4').filter({ hasText: vaultName }).first();
    await card.getByRole('button', { name: /Test/i }).click();
    await expect(card.locator('span.material-symbols-outlined', { hasText: 'check_circle' })).toBeVisible({ timeout: 10000 });

    const after = await (await request.get(`${API_URL}/secret-vaults/${vault.id}`)).json();
    expect(after.connected).toBe(true);
  });

  test('secret vaults page shows access denied for non-permitted roles', async ({ page, request }) => {
    // Register an editor (no vaults:write) and log in as them
    const email = `vault-denied-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Vault Denied', email, password: 'Test1234!' }),
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

      // Verify the browser session is the editor, not the storage-state admin
      await expect.poll(async () => {
        const meRes = await page.request.get(`${API_URL}/auth/me`);
        if (!meRes.ok()) return 'ERR';
        return (await meRes.json()).user?.role;
      }, { timeout: 10000 }).toBe('editor');

      await page.goto('/settings/secret-vaults');
      await expect(page.getByText('Access denied')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('You do not have permission to view this page.')).toBeVisible();
    } finally {
      await request.delete(`${API_URL}/users/${regData.user.id}`).catch(() => {});
    }
  });

  test('secrets page for non-admin users: app secrets hidden, group secrets manageable', async ({ page, request }) => {
    // Seed an app-wide secret and a group the editor belongs to
    const secName = `hidden-app-${Date.now()}`;
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: secName, value: 'hidden-value', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Sec-RO-Group-${Date.now()}` } });
    expect(gRes.ok()).toBe(true);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    // Register an editor (non-admin) and add them to the group as a group admin
    const email = `secread-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Secret Read Only', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    const rolesRes = await request.get(`${API_URL}/roles`);
    const roles = await rolesRes.json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${regData.user.id}/role`, { data: { role_id: editorRole.id } });
    await request.post(`${API_URL}/groups/${group.id}/members`, { data: { userId: regData.user.id } });
    await request.put(`${API_URL}/groups/${group.id}/members/${regData.user.id}/role`, { data: { role: 'admin' } });

    // Create a group secret the editor will manage
    const grpSecName = `group-visible-${Date.now()}`;
    const grpSecRes = await request.post(`${API_URL}/secrets`, { data: { name: grpSecName, value: 'group-val', scope: 'group', scopeId: group.id } });
    expect(grpSecRes.status()).toBe(201);
    const grpSecret = await grpSecRes.json();
    cleanupSecretIds.push(grpSecret.id);

    try {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill('Test1234!');
      await page.getByRole('button', { name: /sign.?in/i }).click();
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });

      // Verify the browser session is the editor, not the storage-state admin
      await expect.poll(async () => {
        const meRes = await page.request.get(`${API_URL}/auth/me`);
        if (!meRes.ok()) return 'ERR';
        return (await meRes.json()).user?.role;
      }, { timeout: 10000 }).toBe('editor');

      await page.goto('/settings/secrets');
      await expect(page.getByText('Secrets', { exact: true }).first()).toBeVisible({ timeout: 10000 });

      // App secrets are not visible to non-admins — only the group secret shows
      await expect(page.getByText(secName)).toHaveCount(0);
      await expect(page.getByText(grpSecName)).toBeVisible({ timeout: 5000 });

      // Selecting their group still shows the group secret, and the group
      // admin can add secrets (Add Secret button visible with a group selected)
      await page.getByText('All items').first().click();
      await page.getByText(group.name).first().click();
      await page.waitForTimeout(500);
      await expect(page.getByText(grpSecName)).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('button', { name: 'Add Secret' })).toBeVisible({ timeout: 5000 });
      // Group secrets are manageable (not read-only) for the group's admins
      const grpRow = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: grpSecName }).first();
      await expect(grpRow.locator('button')).not.toHaveCount(0, { timeout: 5000 });
    } finally {
      await request.delete(`${API_URL}/users/${regData.user.id}`).catch(() => {});
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Secrets in code node environment ───────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('app secret resolves into code node env via core_secret env var', async ({ page, request }) => {
    const secName = `CODE_NODE_SECRET_${Date.now()}`;
    // Create an app-level secret
    const secRes = await request.post(`${API_URL}/secrets`, {
      data: { name: secName, value: 'code-node-secret-42', scope: 'app' },
    });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    // Flow with a core_secret env var and a code node reading process.env
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Code-Secret-Env'),
        envVars: [{ name: 'CUSTOM_CRED', value: secName, type: 'core_secret' }],
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Transform', type: 'code', config: { code: 'return { resolved: process.env.CUSTOM_CRED || "MISSING" }' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Transform.resolved'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
          { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    // The code node saw the secret value in process.env
    expect(outputStr).toContain('code-node-secret-42');
    expect(outputStr).not.toContain('MISSING');
  });

  test('unresolved secret reference degrades gracefully instead of failing', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Flow referencing a secret that does not exist
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Unresolved-Secret'),
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 }, data: { label: 'Assistant', type: 'llm-agent', config: { endpointId: mockEndpointId, model: 'mock-gpt-4', systemPrompt: 'ECHO_SYSTEM_PROMPT\nThe token is: {{secrets.core.app:does-not-exist-xyz}}', temperature: 0.7, maxTokens: 1024, responseFormat: 'text' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Assistant.content'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
          { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    // The execution completes — an unresolved secret must not crash the flow
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const failed = events.find(e => e.type === 'execution.failed');
    expect(failed).toBeUndefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    // The unresolved template is replaced with an empty string, never passed through raw
    expect(outputStr).toContain('The token is:');
    expect(outputStr).not.toContain('{{secrets.core.app:does-not-exist-xyz}}');
  });
});
