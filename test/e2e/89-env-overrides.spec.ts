import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';
import { pollExecution } from './helpers/stream';
import {
  createFlowViaUi, addNode, configureNode, closeConfig, fillField, selectOption,
  connect, moveNodeToSlot, saveFlow, runFlow, debugOverlay, expandStep,
  expectCompleted, expectFinalOutput, fillJsonSchema,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const WEBHOOK_SECRET = 'test-secret';
const cookie = getAuthCookie() || undefined;

/**
 * Per-run environment variable overrides (manual debug runs, quick runs and
 * webhook runs). Flows are built through the real editor UI (nodes, wiring,
 * env vars via Flow Settings, webhook trigger config); only fixtures
 * (secrets, groups, vaults) and webhook POST triggers go through the API —
 * webhook execution has no UI by design.
 */

// ── UI flow builder ───────────────────────────────────────────────────────────
// trigger → code (reads process.env.<VAR>) → output, with the flow's env vars
// configured through the Flow Settings modal.

interface BuildOpts {
  name: string;
  envVars: Array<{ name: string; type: string; value: string }>;
  groupName?: string;
  webhookSecret?: string;
  codeBody?: string;
}

async function buildCodeFlowViaUi(page: any, opts: BuildOpts): Promise<string> {
  const flowId = await createFlowViaUi(page, opts.name);

  // Group assignment via Flow Settings (before env vars — the secret
  // dropdowns depend on the group scope).
  if (opts.groupName) {
    await page.getByTestId('flow-settings-btn').click();
    const settings = page.locator('[data-co-pilot-modal="flow-settings"]');
    await expect(settings).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Group').click();
    await page.getByRole('button', { name: opts.groupName }).click();
    await expect(page.getByLabel(`Group: ${opts.groupName}`)).toBeVisible({ timeout: 5000 });
    await settings.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'close' }) }).first().click();
    await expect(settings).not.toBeVisible({ timeout: 5000 });
  }

  // Configure the flow's env vars through the Flow Settings modal.
  if (opts.envVars.length > 0) {
    await page.getByTestId('flow-settings-btn').click();
    const settings = page.locator('[data-co-pilot-modal="flow-settings"]');
    await expect(settings).toBeVisible({ timeout: 5000 });
    for (const ev of opts.envVars) {
      await settings.getByPlaceholder('Variable name').fill(ev.name);
      await settings.locator('select').first().selectOption(ev.type);
      if (ev.type === 'static') {
        await settings.getByPlaceholder('Value').last().fill(ev.value);
      } else if (ev.type === 'core_secret') {
        await expect(settings.locator('select').nth(1)).toContainText(ev.value, { timeout: 10000 });
        await settings.locator('select').nth(1).selectOption(ev.value);
      } else {
        await settings.locator('select').nth(1).selectOption(ev.value);
      }
      await settings.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'add' }) }).last().click();
      await expect(settings.getByText(ev.name, { exact: true }).first()).toBeVisible({ timeout: 5000 });
    }
    await settings.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'close' }) }).first().click();
    await expect(settings).not.toBeVisible({ timeout: 5000 });
  }

  // Trigger node: rename + (for webhooks) switch type + set the secret.
  await configureNode(page, 'Trigger', 'Trigger');
  if (opts.webhookSecret) {
    await selectOption(page, 'Trigger Type', 'Webhook');
    await fillField(page, 'Webhook Secret', opts.webhookSecret);
  }
  await closeConfig(page);
  await moveNodeToSlot(page, 'Trigger', -1, 0);

  // Code node reading the env vars. Its output schema must be declared so the
  // downstream Output node can select the returned fields.
  const codeLabel = await addNode(page, 'code');
  await moveNodeToSlot(page, codeLabel, 0, 0);
  await configureNode(page, codeLabel, 'Inspector');
  const codeBody = opts.codeBody || 'return { value: process.env.ENV_VAR || null };';
  await fillField(page, 'JavaScript Code', codeBody);
  const codeFields = codeBody.match(/^return \{ ([\w\s,]+) \};/)?.[1].split(',').map((s: string) => s.trim()) || ['value'];
  await fillJsonSchema(page, JSON.stringify({
    type: 'object',
    properties: Object.fromEntries(codeFields.map(f => [f, { type: 'string' }])),
  }));
  await closeConfig(page);

  // Output node (rename only — field selection needs the edges below).
  const outLabel = await addNode(page, 'output');
  await moveNodeToSlot(page, outLabel, 1, 0);
  await configureNode(page, outLabel, 'Output');
  await closeConfig(page);

  await connect(page, 'Trigger', 'output-0', 'Inspector', 'input-0');
  await connect(page, 'Inspector', 'output-0', 'Output', 'input-0');

  // Now that the edges exist the upstream fields are selectable.
  await configureNode(page, 'Output', 'Output');
  const modal = page.getByTestId('node-config-modal');
  for (const field of codeFields) {
    await modal.locator('label').filter({ has: page.getByText(field, { exact: true }) }).locator('input[type="checkbox"]').check();
  }
  await closeConfig(page);

  await saveFlow(page);

  // A webhook save pops the "Personal API Key Created" modal — dismiss it.
  if (opts.webhookSecret) {
    const keyModal = page.locator('[data-co-pilot-modal="api-key"]');
    for (let i = 0; i < 10; i++) {
      if (await keyModal.isVisible().catch(() => false)) break;
      await page.waitForTimeout(200);
    }
    if (await keyModal.isVisible().catch(() => false)) {
      await keyModal.getByRole('button', { name: /copied my key/i }).click();
    }
  }
  return flowId;
}

// ── Env overrides section helpers ─────────────────────────────────────────────

function overridesSection(page: any) {
  return page.getByTestId('env-overrides-section');
}

async function expandOverrides(page: any) {
  await page.getByTestId('env-overrides-toggle').click();
  await expect(overridesSection(page).getByTestId(/^env-override-row-/).first()).toBeVisible({ timeout: 10000 });
}

async function setOverrideValue(page: any, varName: string, value: string) {
  const row = overridesSection(page).getByTestId(`env-override-row-${varName}`);
  await row.getByLabel('Value').fill(value);
}

async function setOverrideType(page: any, varName: string, typeLabel: string) {
  const row = overridesSection(page).getByTestId(`env-override-row-${varName}`);
  await row.locator('[data-field-label="Type"]').click();
  await page.getByRole('option', { name: typeLabel }).click();
}

async function setOverrideSecret(page: any, varName: string, secretName: string) {
  const row = overridesSection(page).getByTestId(`env-override-row-${varName}`);
  await row.locator('[data-field-label="Secret"]').click();
  await page.getByRole('option', { name: secretName }).click();
}

test.describe('Per-run env var overrides', () => {
  test.describe.configure({ timeout: 240000 });

  const cleanupFlowIds: string[] = [];
  const cleanupSecretIds: string[] = [];
  const cleanupVaultIds: string[] = [];
  const cleanupGroupIds: string[] = [];
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const llmRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Mock LLM Overrides', providerType: 'openai', baseUrl: 'http://mock-llm-e2e:3002/v1', apiKey: 'mock-key', defaultModel: 'mock-gpt-4', models: ['mock-gpt-4'] },
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

  // ═══════════════════════════════════════════════════════════════
  // ─── Debug overlay (editor) ────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('debug overlay: plaintext override wins, empty keeps the configured value, reset restores', async ({ page }) => {
    const flowId = await buildCodeFlowViaUi(page, {
      name: uniqueFlowName('Override-Debug-Plain'),
      envVars: [{ name: 'DB_HOST', type: 'static', value: 'db.internal' }],
      codeBody: 'return { value: process.env.DB_HOST || null };',
    });
    cleanupFlowIds.push(flowId);

    // The section lists exactly the flow's configured vars (allowlist).
    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /db.internal/, 15000);

    // Plaintext override wins for this run only.
    await expandOverrides(page);
    await expect(overridesSection(page).locator('[data-testid^="env-override-row-"]')).toHaveCount(1);
    await setOverrideValue(page, 'DB_HOST', 'override-host');
    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /override-host/, 15000);
    await expect(debugOverlay(page).getByText('db.internal')).toHaveCount(0);

    // Empty field keeps the flow's configured value.
    await setOverrideValue(page, 'DB_HOST', '');
    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /db.internal/, 15000);
    await expect(debugOverlay(page).getByText('override-host')).toHaveCount(0);

    // Reset restores the prefilled configured value.
    await setOverrideValue(page, 'DB_HOST', 'temporary');
    await page.getByTestId('env-overrides-reset').click();
    await expect(overridesSection(page).getByTestId('env-override-row-DB_HOST').getByLabel('Value')).toHaveValue('db.internal');
  });

  test('debug overlay: core secret override via the secret dropdown', async ({ page, request }) => {
    // Two app secrets — the flow var points at A, the override switches to B.
    const secA = await (await request.post(`${API_URL}/secrets`, { data: { name: `OVR_A_${Date.now()}`, value: 'value-a', scope: 'app' } })).json();
    const secB = await (await request.post(`${API_URL}/secrets`, { data: { name: `OVR_B_${Date.now()}`, value: 'value-b', scope: 'app' } })).json();
    cleanupSecretIds.push(secA.id, secB.id);

    const flowId = await buildCodeFlowViaUi(page, {
      name: uniqueFlowName('Override-Debug-Secret'),
      envVars: [{ name: 'DB_PASS', type: 'core_secret', value: secA.name }],
      codeBody: 'return { value: process.env.DB_PASS || null };',
    });
    cleanupFlowIds.push(flowId);

    // Configured value (secret A) resolves as-is.
    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /value-a/, 15000);

    // Override switches the reference to secret B.
    await expandOverrides(page);
    await setOverrideSecret(page, 'DB_PASS', secB.name);
    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /value-b/, 15000);
    await expect(debugOverlay(page).getByText('value-a')).toHaveCount(0);
  });

  test('debug overlay: cyberark override resolves from the group vault', async ({ page, request }) => {
    // Fixtures: a group with a bound CyberArk vault (mock server).
    const groupRes = await request.post(`${API_URL}/groups`, { data: { name: `Override-CyberArk-Group-${Date.now()}` } });
    expect(groupRes.status()).toBe(201);
    const group = await groupRes.json();
    cleanupGroupIds.push(group.id);

    const vRes = await request.post(`${API_URL}/secret-vaults`, {
      data: { name: 'E2E Override Vault', vaultType: 'cyberark', baseUrl: 'http://mock-cyberark-e2e:3005', account: 'conjur', login: 'host/myapp', apiKey: 'myapp-api-key-456', groupId: group.id },
    });
    expect(vRes.status()).toBe(201);
    const vault = await vRes.json();
    cleanupVaultIds.push(vault.id);
    await request.post(`${API_URL}/secret-vaults/${vault.id}/test`);
    await request.put(`${API_URL}/group-vault-config/${group.id}`, { data: { vaultId: vault.id, enabled: true } });

    const flowId = await buildCodeFlowViaUi(page, {
      name: uniqueFlowName('Override-Debug-CyberArk'),
      groupName: group.name,
      envVars: [{ name: 'CONJUR_VAR', type: 'static', value: 'static-value' }],
      codeBody: 'return { value: process.env.CONJUR_VAR || null };',
    });
    cleanupFlowIds.push(flowId);

    // Configured static value resolves as-is.
    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /static-value/, 15000);

    // Switch the override type to CyberArk and point at the mock vault path.
    await expandOverrides(page);
    await setOverrideType(page, 'CONJUR_VAR', 'CyberArk');
    await setOverrideValue(page, 'CONJUR_VAR', 'prod/db/password');
    await runFlow(page);
    await expectCompleted(page, 30000);
    // The mock CyberArk returns this for prod/db/password.
    await expectFinalOutput(page, /sup3r-s3cr3t-db-pass!/, 20000);
    await expect(debugOverlay(page).getByText('static-value')).toHaveCount(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Quick run (RunModal on the flow card) ─────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('quick run: RunModal env overrides run the flow and persist to run history', async ({ page, request }) => {
    const flowName = uniqueFlowName('Override-QuickRun');
    const flowId = await buildCodeFlowViaUi(page, {
      name: flowName,
      envVars: [{ name: 'DB_HOST', type: 'static', value: 'db.internal' }],
      codeBody: 'return { value: process.env.DB_HOST || null };',
    });
    cleanupFlowIds.push(flowId);

    // Open the Run dialog from the flow card.
    await page.goto('/');
    const card = page.locator('div.rounded-lg.border.p-4').filter({ has: page.getByText(flowName, { exact: true }) }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.getByRole('button', { name: 'Run' }).click();
    const modal = page.getByTestId('run-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Configure a plaintext override and run.
    await modal.getByTestId('env-overrides-toggle').click();
    await expect(modal.getByTestId('env-override-row-DB_HOST')).toBeVisible({ timeout: 10000 });
    await modal.getByTestId('env-override-row-DB_HOST').getByLabel('Value').fill('quick-override');
    await modal.getByRole('button', { name: 'Run' }).click();
    await expect(card.getByText('Completed')).toBeVisible({ timeout: 25000 });

    // The persisted execution carries exactly what was supplied.
    const execsRes = await request.get(`${API_URL}/flows/${flowId}/executions`);
    expect(execsRes.ok()).toBe(true);
    const { data } = await execsRes.json();
    const latest = data?.[0];
    expect(latest).toBeTruthy();
    expect((latest.input as any)?.__envOverrides).toEqual({ DB_HOST: 'quick-override' });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Webhook runs (worker-executed; POST is the only trigger) ──
  // ═══════════════════════════════════════════════════════════════

  test('webhook: plaintext override, core_secret override, invalid shape and no-override regression', async ({ page, request }) => {
    const secRes = await request.post(`${API_URL}/secrets`, { data: { name: `OVR_WH_${Date.now()}`, value: 'app-secret-val', scope: 'app' } });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    const flowId = await buildCodeFlowViaUi(page, {
      name: uniqueFlowName('Override-Webhook'),
      webhookSecret: WEBHOOK_SECRET,
      envVars: [
        { name: 'DB_HOST', type: 'static', value: 'db.internal' },
        { name: 'DB_PASS', type: 'core_secret', value: secret.name },
      ],
      codeBody: 'return { api: process.env.DB_HOST || null, db: process.env.DB_PASS || null };',
    });
    cleanupFlowIds.push(flowId);

    // ── Plaintext override ──
    const plainRes = await request.post(`${API_URL}/webhook/${flowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 'hello', envOverrides: { DB_HOST: 'webhook-plain-override' } },
    });
    expect(plainRes.ok()).toBe(true);
    let exec = await pollExecution(request, (await plainRes.json()).executionId, 45000);
    expect(exec.status).toBe('completed');
    const plainOut = JSON.stringify(exec.output || {});
    expect(plainOut).toContain('webhook-plain-override');
    expect(plainOut).not.toContain('db.internal');

    // ── core_secret override ──
    const secRes2 = await request.post(`${API_URL}/webhook/${flowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 'hello', envOverrides: { DB_PASS: { type: 'core_secret', value: secret.name } } },
    });
    expect(secRes2.ok()).toBe(true);
    exec = await pollExecution(request, (await secRes2.json()).executionId, 45000);
    expect(exec.status).toBe('completed');
    expect(JSON.stringify(exec.output || {})).toContain('app-secret-val');

    // ── Invalid override shape → 400 ──
    const badRes = await request.post(`${API_URL}/webhook/${flowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 'hello', envOverrides: { DB_HOST: { type: 'bogus', value: 'x' } } },
    });
    expect(badRes.status()).toBe(400);
    expect((await badRes.json()).error).toContain('Invalid envOverride');

    // ── Without overrides the flow env vars still resolve (flowDef.envVars regression) ──
    const noRes = await request.post(`${API_URL}/webhook/${flowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 'hello' },
    });
    expect(noRes.ok()).toBe(true);
    exec = await pollExecution(request, (await noRes.json()).executionId, 45000);
    expect(exec.status).toBe('completed');
    const noOut = JSON.stringify(exec.output || {});
    expect(noOut).toContain('db.internal');
    expect(noOut).toContain('app-secret-val');
  });

  test('webhook: reference to a secret outside the flow group is ignored', async ({ request }) => {
    // Fixtures only — this exercises server-side scope isolation.
    const groupARes = await request.post(`${API_URL}/groups`, { data: { name: `Override-GroupA-${Date.now()}` } });
    expect(groupARes.status()).toBe(201);
    const groupA = await groupARes.json();
    cleanupGroupIds.push(groupA.id);
    const groupBRes = await request.post(`${API_URL}/groups`, { data: { name: `Override-GroupB-${Date.now()}` } });
    expect(groupBRes.status()).toBe(201);
    const groupB = await groupBRes.json();
    cleanupGroupIds.push(groupB.id);

    const secRes = await request.post(`${API_URL}/secrets`, {
      data: { name: `CROSS_${Date.now()}`, value: 'group-b-value', scope: 'group', scopeId: groupB.id },
    });
    expect(secRes.status()).toBe(201);
    const secret = await secRes.json();
    cleanupSecretIds.push(secret.id);

    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Override-CrossGroup'),
        group_id: groupA.id,
        envVars: [{ name: 'GROUP_VAR', type: 'static', value: 'configured-value' }],
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Inspector', type: 'code', config: { code: 'return { value: process.env.GROUP_VAR || null };' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
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

    const res = await request.post(`${API_URL}/webhook/${flow.id}?secret=${WEBHOOK_SECRET}`, {
      data: {
        message: 'hello',
        envOverrides: { GROUP_VAR: { type: 'core_secret', value: secret.name } },
      },
    });
    expect(res.ok()).toBe(true);
    const exec = await pollExecution(request, (await res.json()).executionId, 45000);
    expect(exec.status).toBe('completed');
    const outputStr = JSON.stringify(exec.output || {});
    // The out-of-group secret must never resolve; the configured value stands.
    expect(outputStr).toContain('configured-value');
    expect(outputStr).not.toContain('group-b-value');
  });

  test('debug overlay: secret-named env vars stay blocked from the code sandbox even when overridden', async ({ page }) => {
    // The sandbox sanitizer strips secret-looking names (API_KEY, *_TOKEN,
    // *_SECRET, *_PASSWORD) from code-node environments — overrides must not
    // bypass that security boundary.
    const flowId = await buildCodeFlowViaUi(page, {
      name: uniqueFlowName('Override-Blocklist'),
      envVars: [{ name: 'API_KEY', type: 'static', value: 'configured-key-value' }],
      codeBody: 'return { value: process.env.API_KEY || null };',
    });
    cleanupFlowIds.push(flowId);

    const assertBlocked = async () => {
      // No Final Output block when the value is null — assert via the step card.
      await expectCompleted(page, 30000);
      await expandStep(page, 'Inspector');
      await expect(debugOverlay(page).locator('pre').filter({ hasText: '"value": null' }).first()).toBeVisible({ timeout: 10000 });
      await expect(debugOverlay(page).getByText('configured-key-value')).toHaveCount(0);
      await expect(debugOverlay(page).getByText('override-key-value')).toHaveCount(0);
    };

    // The configured secret-named var never reaches the code sandbox.
    await runFlow(page);
    await assertBlocked();

    // An override does not bypass the blocklist either.
    await expandOverrides(page);
    await setOverrideValue(page, 'API_KEY', 'override-key-value');
    await runFlow(page);
    await assertBlocked();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Hardening: template secret resolution scoped to the flow ──
  // ═══════════════════════════════════════════════════════════════

  test('template {{secrets.core.group:NAME}} resolves only the flow own group secret (scope_id hardening)', async ({ request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Two groups with the SAME secret name. The other group's row is created
    // FIRST so an unscoped lookup would resolve the wrong value.
    const groupBRes = await request.post(`${API_URL}/groups`, { data: { name: `Tpl-GroupB-${Date.now()}` } });
    expect(groupBRes.status()).toBe(201);
    const groupB = await groupBRes.json();
    cleanupGroupIds.push(groupB.id);
    const secB = await (await request.post(`${API_URL}/secrets`, { data: { name: 'shared-db-pass', value: 'value-from-b', scope: 'group', scopeId: groupB.id } })).json();
    cleanupSecretIds.push(secB.id);

    const groupARes = await request.post(`${API_URL}/groups`, { data: { name: `Tpl-GroupA-${Date.now()}` } });
    expect(groupARes.status()).toBe(201);
    const groupA = await groupARes.json();
    cleanupGroupIds.push(groupA.id);
    const secA = await (await request.post(`${API_URL}/secrets`, { data: { name: 'shared-db-pass', value: 'value-from-a', scope: 'group', scopeId: groupA.id } })).json();
    cleanupSecretIds.push(secA.id);

    // Flow in group A whose system prompt templates the shared secret name.
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Tpl-Scope'),
        group_id: groupA.id,
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 }, data: { label: 'Assistant', type: 'llm-agent', config: { endpointId: mockEndpointId, model: 'mock-gpt-4', systemPrompt: 'ECHO_SYSTEM_PROMPT\nThe db pass is: {{secrets.core.group:shared-db-pass}}', temperature: 0.7, maxTokens: 1024, responseFormat: 'text' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
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
    const outputStr = JSON.stringify(completed?.data?.output || {});
    // The flow's OWN group secret resolves — the other group's never does.
    expect(outputStr).toContain('value-from-a');
    expect(outputStr).not.toContain('value-from-b');
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── OpenAPI documentation ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('openapi.json documents the envOverrides request field', async ({ page, request }) => {
    const flowId = await buildCodeFlowViaUi(page, {
      name: uniqueFlowName('Override-OpenAPI'),
      webhookSecret: WEBHOOK_SECRET,
      envVars: [{ name: 'DB_HOST', type: 'static', value: 'db.internal' }],
      codeBody: 'return { value: process.env.DB_HOST || null };',
    });
    cleanupFlowIds.push(flowId);

    // The editor auto-deploys webhook flows on save — the slug is generated.
    const depRes = await request.get(`${API_URL}/flows/${flowId}/deployment`);
    expect(depRes.ok()).toBe(true);
    const { pathSlug } = await depRes.json();
    expect(pathSlug).toBeTruthy();

    const specRes = await request.get(`${API_URL}/openapi.json`);
    expect(specRes.ok()).toBe(true);
    const spec = await specRes.json();
    const schema = spec.paths[`/api/webhook/${pathSlug}`].post.requestBody.content['application/json'].schema;
    expect(schema.properties.envOverrides).toBeDefined();
    expect(schema.properties.envOverrides.additionalProperties.anyOf).toHaveLength(2);
    expect(schema.properties.envOverrides.additionalProperties.anyOf[1].properties.type.enum).toEqual(['core_secret', 'cyberark']);
  });
});
