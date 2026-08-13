import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';
import {
  createFlowViaUi, addNode, configureNode, closeConfig, selectOption,
  fillFieldByPlaceholder, connect, moveNodeToSlot, saveFlow, runFlow,
  debugOverlay, expandStep, expectCompleted,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const cookie = getAuthCookie() || undefined;

test.describe('Flow env vars and secret types', () => {
  const cleanupFlowIds: string[] = [];
  const cleanupSecretIds: string[] = [];
  const cleanupVaultIds: string[] = [];
  const cleanupGroupIds: string[] = [];
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const llmRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Mock LLM Flow Env', providerType: 'openai', baseUrl: 'http://mock-llm-e2e:3002/v1', apiKey: 'mock-key', defaultModel: 'mock-gpt-4', models: ['mock-gpt-4'] },
    });
    if (llmRes.ok()) { const ep = await llmRes.json(); mockEndpointId = ep.id; }
  });

  test.afterAll(async ({ request }) => {
    if (mockEndpointId) await request.delete(`${API_URL}/llm-endpoints/${mockEndpointId}`);
  });

  test.afterEach(async ({ request }) => {
    for (const id of cleanupFlowIds) { await deleteFlow(request, id).catch(() => {}); }
    for (const id of cleanupSecretIds) { await request.delete(`${API_URL}/secrets/${id}`).catch(() => {}); }
    for (const id of cleanupVaultIds) { await request.delete(`${API_URL}/secret-vaults/${id}`).catch(() => {}); }
    for (const id of cleanupGroupIds) { await request.delete(`${API_URL}/groups/${id}`).catch(() => {}); }
    cleanupFlowIds.length = cleanupSecretIds.length = cleanupVaultIds.length = cleanupGroupIds.length = 0;
  });

  /**
   * Build a trigger → llm-agent → output flow via the editor UI, setting the
   * flow's env var (and optional group) through the Flow Settings modal.
   */
  async function buildEnvLLMFlow(page: any, request: any, name: string, envVar: { name: string; value: string; type: 'static' | 'core_secret' | 'cyberark' }, groupId?: string, groupName?: string, prompt?: string) {
    const flowId = await createFlowViaUi(page, name);
    await page.getByTestId('flow-settings-btn').click();
    const settings = page.locator('[data-co-pilot-modal="flow-settings"]');
    await expect(settings).toBeVisible({ timeout: 5000 });
    if (groupId) {
      await page.getByLabel('Group').click();
      await page.getByRole('button', { name: groupName }).click();
      await expect(page.getByLabel(`Group: ${groupName}`)).toBeVisible({ timeout: 5000 });
    }
    await settings.getByPlaceholder('Variable name').fill(envVar.name);
    await settings.locator('select').filter({ hasText: 'Static' }).selectOption(envVar.type);
    if (envVar.type === 'static') {
      await settings.getByPlaceholder('Value').last().fill(envVar.value);
    } else {
      // The secret options load asynchronously once the group scope is known
      await expect(settings.locator('select').nth(1)).toContainText(envVar.value, { timeout: 10000 });
      await settings.locator('select').nth(1).selectOption(envVar.value);
    }
    await settings.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'add' }) }).last().click();
    await expect(settings.getByText(envVar.name, { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await settings.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'close' }) }).first().click();
    await expect(settings).not.toBeVisible();

    await configureNode(page, 'Trigger', 'Trigger');
    await closeConfig(page);
    await moveNodeToSlot(page, 'Trigger', -1, 0);
    const l = await addNode(page, 'llm-agent');
    await moveNodeToSlot(page, l, 0, 0);
    await configureNode(page, l, 'Assistant');
    await selectOption(page, 'LLM Endpoint', /E2E Mock LLM Flow Env/);
    await selectOption(page, 'Model', 'mock-gpt-4');
    await fillFieldByPlaceholder(page, 'You are a helpful assistant... Type {{ for field suggestions', prompt || 'ECHO_SYSTEM_PROMPT');
    await selectOption(page, 'Response Format', 'Plain Text');
    await closeConfig(page);
    const o = await addNode(page, 'output');
    await moveNodeToSlot(page, o, 1, 0);
    await configureNode(page, o, 'Output');
    await closeConfig(page);
    await connect(page, 'Trigger', 'output-0', 'Assistant', 'input-0');
    await connect(page, 'Assistant', 'output-0', 'Output', 'input-0');
    await saveFlow(page);
    return flowId;
  }

  // ═══════════════════════════════════════════════════════════════
  // ─── Flow env vars in Flow Settings modal ─────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('flow env vars appear in Flow Settings modal', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('Env-Flow') });
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    // Add a flow-level env var via flow update
    const updateRes = await request.put(`${API_URL}/flows/${flow.id}`, {
      data: { envVars: [{ name: 'FLOW_TOKEN', value: 'flow-val', type: 'static' }] },
    });
    expect(updateRes.ok()).toBe(true);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings modal
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // The Environment Variables section should show FLOW_TOKEN
    await expect(page.getByText('Environment Variables', { exact: true })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);
    await expect(page.getByText('FLOW_TOKEN').first()).toBeVisible({ timeout: 5000 });
    // Use the Static badge rendered inside the env var item
    await expect(page.getByText('Static').first()).toBeVisible({ timeout: 5000 });
  });

  test('add a flow env var via UI', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('Env-Add') });
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings modal
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Scroll down to env vars section
    const envSection = page.getByText('Environment Variables', { exact: true });
    await expect(envSection).toBeVisible();

    // Fill in the new env var form
    await page.getByPlaceholder('Variable name').fill('DB_URL');
    await page.getByPlaceholder('Variable name').locator('..').locator('select').selectOption('static');
    await page.getByPlaceholder('Variable name').locator('..').getByPlaceholder('Value').fill('postgres://localhost:5432/mydb');

    // Click the add button
    await page.getByPlaceholder('Variable name').locator('..').locator('button').click();

    // The var should appear in the list
    await expect(page.getByText('DB_URL')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Static').first()).toBeVisible();

    // Close the modal (auto-save — no Save button needed)
    await page.getByRole('button', { name: 'close' }).click();
    await expect(page.getByText('Flow Settings')).not.toBeVisible({ timeout: 5000 });

    // Verify persistence — reload and check
    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('DB_URL')).toBeVisible({ timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Flow env var resolution during execution ─────────────────
  // ═══════════════════════════════════════════════════════════════

  test('{{env.FLOW_VAR}} resolves during execution', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    const flowId = await buildEnvLLMFlow(page, request, uniqueFlowName('Flow-Env-Resolve'), {
      name: 'DB_HOST', value: 'db.internal', type: 'static',
    }, undefined, undefined, 'ECHO_SYSTEM_PROMPT\nThe DB is at: {{env.DB_HOST}}');
    cleanupFlowIds.push(flowId);

    await runFlow(page, 'test');
    await expectCompleted(page, 30000);
    await expandStep(page, 'Assistant');
    await expect(debugOverlay(page).getByText('db.internal').first()).toBeVisible({ timeout: 10000 });
    await expect(debugOverlay(page).getByText('{{env.DB_HOST}}')).toHaveCount(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── core_secret env var resolution ───────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('core_secret env var references a Core secret during execution', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Create an app-level Core secret (fixture)
    const secRes = await request.post(`${API_URL}/secrets`, {
      data: { name: 'MY_API_KEY', value: 'sk-12345', scope: 'app' },
    });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    const flowId = await buildEnvLLMFlow(page, request, uniqueFlowName('CoreSecret-Resolve'), {
      name: 'API_KEY', value: 'MY_API_KEY', type: 'core_secret',
    }, undefined, undefined, 'ECHO_SYSTEM_PROMPT\nThe API key is: {{env.API_KEY}}');
    cleanupFlowIds.push(flowId);

    await runFlow(page, 'test');
    await expectCompleted(page, 30000);
    await expandStep(page, 'Assistant');
    await expect(debugOverlay(page).getByText('sk-12345').first()).toBeVisible({ timeout: 10000 });
    await expect(debugOverlay(page).getByText('{{env.API_KEY}}')).toHaveCount(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── cyberark env var resolution ──────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('cyberark env var references a CyberArk vault', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Group + vault fixtures (vaults are bound to groups via API)
    const groupRes = await request.post(`${API_URL}/groups`, { data: { name: `CyberArk-Env-Group-${Date.now()}` } });
    expect(groupRes.status()).toBe(201);
    const group = await groupRes.json();
    cleanupGroupIds.push(group.id);

    const vRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'E2E CyberArk Env', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'myapp-api-key-456', groupId: group.id },
    });
    expect(vRes.status()).toBe(201);
    const vault = await vRes.json();
    cleanupVaultIds.push(vault.id);

    await request.post(`${API_URL}/secret-vaults/${vault.id}/test`);
    await request.put(`${API_URL}/group-vault-config/${group.id}`, {
      data: { vaultId: vault.id, enabled: true },
    });

    // The editor's CyberArk dropdown lists group-scoped cyberark SECRET rows —
    // create the reference row (fixture) so the UI can select it.
    const secRowRes = await request.post(`${API_URL}/secrets`, {
      data: { name: 'DB_PASS', value: '', scope: 'group', scopeId: group.id, secretType: 'cyberark', referencePath: 'prod/db/password' },
    });
    expect(secRowRes.ok()).toBe(true);
    const secRow = await secRowRes.json();
    cleanupSecretIds.push(secRow.id);

    const flowId = await buildEnvLLMFlow(page, request, uniqueFlowName('CyberArk-Env-Resolve'), {
      name: 'DB_PASS', value: 'prod/db/password', type: 'cyberark',
    }, group.id, group.name, 'ECHO_SYSTEM_PROMPT\nThe DB password is: {{env.DB_PASS}}');
    cleanupFlowIds.push(flowId);

    await runFlow(page, 'test');
    await expectCompleted(page, 30000);
    await expandStep(page, 'Assistant');
    // The mock CyberArk returns "sup3r-s3cr3t-db-pass!" for prod/db/password
    await expect(debugOverlay(page).getByText('sup3r-s3cr3t-db-pass!').first()).toBeVisible({ timeout: 15000 });
    await expect(debugOverlay(page).getByText('{{env.DB_PASS}}')).toHaveCount(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Inherited Secrets & Env Vars in Flow Settings ────────────
  // ═══════════════════════════════════════════════════════════════

  test('inherited secrets and env vars appear in Flow Settings modal', async ({ page, request }) => {
    // Create an app-level secret and env var
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: 'app-db-password', value: 'app-secret-val', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const appSecret = await secRes.json();
    cleanupSecretIds.push(appSecret.id);

    await request.put(`${API_URL}/env-vars`, { data: { envVars: [{ name: 'APP_VAR', value: 'app-val', type: 'static' }] } });

    // Create a group and add group-level items
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Inherited-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    await request.put(`${API_URL}/env-vars/groups/${group.id}`, { data: { envVars: [{ name: 'GROUP_VAR', value: 'group-val', type: 'static' }] } });

    // Create a flow in the group
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: { name: uniqueFlowName('Inherited-Test'), group_id: group.id },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings modal
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Inherited Secrets section should show the app-level secret
    await expect(page.getByText('Inherited Secrets')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('app-db-password')).toBeVisible({ timeout: 5000 });

    // Inherited Environment Variables section should show app and group vars
    await expect(page.getByText('Inherited Environment Variables')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('APP_VAR').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('GROUP_VAR').first()).toBeVisible({ timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Core Secret dropdown in Flow Settings env vars ──────────
  // ═══════════════════════════════════════════════════════════════

  test('core_secret dropdown shows available secrets in Flow Settings', async ({ page, request }) => {
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: 'MY_API_SECRET', value: 'sk-abc', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    const flowRes = await request.post(`${API_URL}/flows`, { data: { name: uniqueFlowName('CoreSecret-Dropdown') } });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Scroll to env vars section and switch type to Core Secret
    await page.getByText('Environment Variables', { exact: true }).click();
    await page.locator('select').filter({ hasText: 'Static' }).selectOption('core_secret');

    // The Core Secret dropdown should contain our secret as an option
    const coreSelect = page.locator('select').nth(1);
    await expect(coreSelect).toContainText('MY_API_SECRET');
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── CyberArk dropdown in Flow Settings env vars ─────────────
  // ═══════════════════════════════════════════════════════════════

  test('cyberark dropdown shows select element in Flow Settings', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `CyberArk-Dropdown-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    const flowRes = await request.post(`${API_URL}/flows`, {
      data: { name: uniqueFlowName('CyberArk-Dropdown'), group_id: group.id },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Switch to CyberArk type
    await page.getByText('Environment Variables', { exact: true }).click();
    await page.locator('select').filter({ hasText: 'Static' }).selectOption('cyberark');

    // A select element with the CyberArk placeholder should be visible
    const cyberSelect = page.locator('select').nth(1);
    await expect(cyberSelect).toBeVisible({ timeout: 5000 });
    await expect(cyberSelect).toContainText('Select a CyberArk secret');
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Secret type toggle in Flow Settings modal ───────────────
  // ═══════════════════════════════════════════════════════════════

  test('secret type toggle switches between Core and CyberArk in Flow Settings', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('Secret-Type-Toggle') });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // Scroll to Flow Secrets section
    await expect(page.getByText('Flow Secrets')).toBeVisible({ timeout: 5000 });

    // The Core/CyberArk toggle buttons should be visible
    const coreBtn = page.getByRole('button', { name: 'Core' });
    const cyberBtn = page.getByRole('button', { name: 'CyberArk' });
    await expect(coreBtn).toBeVisible();
    await expect(cyberBtn).toBeVisible();

    // Core should be selected by default
    await expect(coreBtn).toHaveClass(/bg-primary/);

    // Click CyberArk — should show reference path input instead of password
    await cyberBtn.click();
    await page.waitForTimeout(300);
    await expect(cyberBtn).toHaveClass(/bg-primary/);
    await expect(page.getByPlaceholder('Reference path')).toBeVisible();

    // Click Core again — should show value input
    await coreBtn.click();
    await page.waitForTimeout(300);
    await expect(coreBtn).toHaveClass(/bg-primary/);
    await expect(page.getByTestId('flow-secret-value')).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Flow-scoped secret runtime resolution (documented) ───────
  // ═══════════════════════════════════════════════════════════════
  // Flow-scoped secrets (scope: flow) CANNOT be resolved at runtime:
  //  - {{secrets.core.flow:NAME}} templates resolve to EMPTY — the sync
  //    regex in resolveTemplateSync (engine.ts) handles group:/app: but
  //    not flow:, so the captured name keeps the "flow:" prefix and the
  //    lookup misses.
  //  - core_secret flow env vars resolve against app scope only, so a
  //    flow-scoped reference is dropped from the sandbox entirely.
  // These tests pin that behavior so a fix is caught explicitly.

  test('flow-scoped secret does not resolve via {{secrets.core.flow:NAME}} — template replaced with empty (documented gap)', async ({ request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    const flowRes = await request.post(`${API_URL}/flows`, {
      data: { name: uniqueFlowName('FlowSecret-Resolve') },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    // Create a FLOW-scoped secret (scope: flow) bound to this flow
    const secRes = await request.post(`${API_URL}/secrets`, {
      data: { name: 'FLOW_ONLY_SECRET', value: 'flow-secret-value-99', scope: 'flow', scopeId: flow.id },
    });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    // Add an LLM node referencing the flow-scoped secret template
    const updateRes = await request.put(`${API_URL}/flows/${flow.id}`, {
      data: {
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 }, data: { label: 'Assistant', type: 'llm-agent', config: { endpointId: mockEndpointId, model: 'mock-gpt-4', systemPrompt: 'ECHO_SYSTEM_PROMPT\nThe flow secret is: {{secrets.core.flow:FLOW_ONLY_SECRET}}', temperature: 0.7, maxTokens: 1024, responseFormat: 'text' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Assistant.content'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
          { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(updateRes.ok()).toBe(true);

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    // Template is replaced with an empty string — the secret VALUE never
    // appears, but neither does the value resolve (current app behavior)
    expect(outputStr).toContain('The flow secret is:');
    expect(outputStr).not.toContain('flow-secret-value-99');
    expect(outputStr).not.toContain('{{secrets.core.flow:FLOW_ONLY_SECRET}}');
  });

  test('core_secret flow env var referencing a flow-scoped secret is dropped from the sandbox (app-scope runtime lookup)', async ({ request }) => {
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('FlowSecret-EnvVar'),
        envVars: [{ name: 'FLOW_SECRET_VAR', value: 'FLOW_ONLY_SECRET', type: 'core_secret' }],
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Inspector', type: 'code', config: { code: 'return { value: process.env.FLOW_SECRET_VAR || null };' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Inspector.value'] } } },
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

    // Create the flow-scoped secret this env var references
    const secRes = await request.post(`${API_URL}/secrets`, {
      data: { name: 'FLOW_ONLY_SECRET', value: 'flow-secret-value-99', scope: 'flow', scopeId: flow.id },
    });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const output = completed?.data?.output || {};

    const c1out = output?.c1 || output?.inspector || {};
    // Runtime core_secret lookup defaults to app scope — the flow-scoped
    // secret is not found, so the var is dropped from the sandbox env.
    // The secret VALUE must never leak in its place.
    expect(c1out.value).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Edit / delete flow env vars via Flow Settings modal ──────
  // ═══════════════════════════════════════════════════════════════

  test('edit a flow env var value via the modal — persists when settings are saved', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('Env-Edit'),
      envVars: [{ name: 'FLOW_EDIT_VAR', value: 'old-value', type: 'static' }],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // The env var row: name span → name wrapper → row (flex justify-between)
    const row = page.getByText('FLOW_EDIT_VAR', { exact: true }).locator('..').locator('..');
    await expect(row).toBeVisible({ timeout: 5000 });

    // Edit via the row's edit button (window.prompt)
    page.once('dialog', dialog => dialog.accept('new-value'));
    await row.getByRole('button').first().click();

    // The modal edit only updates local state — it persists when any
    // settings field triggers a save (flow_context here)
    await page.getByPlaceholder('Context for this specific flow...').fill('edit-save-trigger');
    await page.waitForTimeout(1500);

    const getRes = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(getRes.ok()).toBe(true);
    const updated = await getRes.json();
    const envVars = updated.env_vars || [];
    expect(envVars.find((v: any) => v.name === 'FLOW_EDIT_VAR')?.value).toBe('new-value');
  });

  test('delete a flow env var via the modal — persists', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('Env-Delete'),
      envVars: [{ name: 'FLOW_DEL_VAR', value: 'delete-me', type: 'static' }],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    const row = page.getByText('FLOW_DEL_VAR', { exact: true }).locator('..').locator('..');
    await expect(row).toBeVisible({ timeout: 5000 });

    await row.getByRole('button').last().click();
    await expect(page.getByText('FLOW_DEL_VAR', { exact: true })).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(1500);

    // Persisted to the backend immediately
    const getRes = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(getRes.ok()).toBe(true);
    const updated = await getRes.json();
    const envVars = updated.env_vars || [];
    expect(envVars.find((v: any) => v.name === 'FLOW_DEL_VAR')).toBeUndefined();

    // Still gone after a reload
    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('FLOW_DEL_VAR', { exact: true })).toHaveCount(0, { timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Duplicate env var names ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════════
  // The modal's add handler does not validate uniqueness — duplicates are
  // allowed and stored. Pin that behavior (no inline error, both rows kept).

  test('duplicate flow env var names are accepted — no dedupe validation, both rows persist', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('Env-Dupe') });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    const addRow = page.getByPlaceholder('Variable name').locator('..');
    await page.getByPlaceholder('Variable name').fill('DUP_VAR');
    await addRow.getByPlaceholder('Value').fill('first');
    await addRow.locator('button').click();
    await page.waitForTimeout(500);

    await page.getByPlaceholder('Variable name').fill('DUP_VAR');
    await addRow.getByPlaceholder('Value').fill('second');
    await addRow.locator('button').click();
    await page.waitForTimeout(500);

    // Both rows show the same name — no inline error
    await expect(page.getByText('DUP_VAR', { exact: true })).toHaveCount(2, { timeout: 5000 });

    // Both entries persist
    const getRes = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(getRes.ok()).toBe(true);
    const updated = await getRes.json();
    const dupes = (updated.env_vars || []).filter((v: any) => v.name === 'DUP_VAR');
    expect(dupes).toHaveLength(2);
  });
});
