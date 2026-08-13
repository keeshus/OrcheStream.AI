import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import { pollExecution } from './helpers/stream';
import {
  createFlowViaUi, addNode, clickNode, configureNode, closeConfig, fillField,
  fillJsonSchema, selectOption, connect, moveNodeToSlot, saveFlow, debugOverlay,
  expandStep, expectCompleted,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const WEBHOOK_SECRET = 'test-secret';

// ── UI flow builder (same recipe as 90-node-types) ─────────────────────────
// Flow creation, trigger config (Trigger Type select, Webhook Secret, Input
// Schema), node wiring, save and debug-run all go through the real editor UI.

type UiNode = {
  type: string;
  label: string;
  config?: Record<string, any>;
  col?: number;
  row?: number;
};

type UiEdge = {
  from: string;
  fromHandle: string;
  to: string;
  toHandle: string;
};

/** Apply a trigger/node config through the real config-modal form. */
async function applyConfig(page: any, type: string, label: string, config: Record<string, any> = {}) {
  const modal = page.getByTestId('node-config-modal');
  switch (type) {
    case 'trigger':
      if (config.triggerType) await selectOption(page, 'Trigger Type', config.triggerType);
      if (config.webhookSecret !== undefined) await fillField(page, 'Webhook Secret', config.webhookSecret);
      if (config.cronExpression !== undefined) await fillField(page, 'Cron Expression', config.cronExpression);
      if (config.inputMessage !== undefined) await fillField(page, 'Input Message', config.inputMessage);
      if (config.inputSchema) await fillJsonSchema(page, config.inputSchema);
      break;
    case 'code':
      if (config.code) await fillField(page, 'JavaScript Code', config.code);
      if (config.outputSchema) await fillJsonSchema(page, config.outputSchema);
      break;
    case 'output': {
      for (const field of config.inputFields || []) {
        // Check the field checkbox (e.g. "result" under the upstream node).
        // The checkbox label renders as "{name}: {type}" — exact text match
        // to avoid substring collisions with other upstream fields.
        const fieldName = field.split('.').pop();
        await modal.locator('label').filter({ has: page.getByText(fieldName!, { exact: true }) }).locator('input[type="checkbox"]').check();
      }
      break;
    }
    default:
      break;
  }
}

/** Open the config modal for a node (no rename). */
async function openConfig(page: any, label: string) {
  await clickNode(page, label);
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
}

/** Dismiss the "Personal API Key Created" modal the editor shows after
 *  saving a webhook flow (the key is auto-generated on save). */
async function dismissKeyModal(page: any) {
  // The modal pops after the save response lands (async) — poll briefly for it
  // before deciding it won't appear, otherwise it intercepts the next click.
  const modal = page.locator('[data-co-pilot-modal="api-key"]');
  for (let i = 0; i < 10; i++) {
    if (await modal.isVisible().catch(() => false)) break;
    await page.waitForTimeout(200);
  }
  if (await modal.isVisible().catch(() => false)) {
    await modal.getByRole('button', { name: /copied my key/i }).click();
    await expect(modal).not.toBeVisible();
  }
}

/** Build a flow through the editor UI: nodes, layout, edges, configs, save. */
async function buildUiFlow(page: any, request: any, name: string, nodes: UiNode[], edges: UiEdge[]): Promise<string> {
  const flowId = await createFlowViaUi(page, name);
  const colShift = (nodes.length - 1) / 2;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'trigger') {
      await configureNode(page, 'Trigger', n.label);
      await closeConfig(page);
      await moveNodeToSlot(page, n.label, (n.col ?? i) - colShift, n.row ?? 0);
    } else {
      const autoLabel = await addNode(page, n.type);
      await moveNodeToSlot(page, autoLabel, (n.col ?? i) - colShift, n.row ?? 0);
      await configureNode(page, autoLabel, n.label);
      await closeConfig(page);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    for (const e of edges) {
      if (e.to === nodes[i].label) {
        await connect(page, e.from, e.fromHandle, e.to, e.toHandle);
      }
    }
    await openConfig(page, nodes[i].label);
    await applyConfig(page, nodes[i].type, nodes[i].label, nodes[i].config);
    await closeConfig(page);
  }
  await saveFlow(page);
  await dismissKeyModal(page);
  return flowId;
}

/** Run the flow from the debug overlay with a webhook payload. */
async function runWebhookFlow(page: any, payload: string) {
  const runBtn = debugOverlay(page).getByTestId('debug-run-btn');
  if (!(await runBtn.isVisible().catch(() => false))) {
    await page.getByTestId('debug-btn').click();
    await expect(runBtn).toBeVisible({ timeout: 5000 });
  }
  await debugOverlay(page).getByPlaceholder('{"event": "test", "data": {}}').fill(payload);
  await runBtn.click();
}

test.describe('Webhook trigger', () => {
  test.afterEach(async ({ request }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('webhook flow executes via POST to webhook endpoint', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookTest'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET, inputSchema: '{"message":"string"}' } },
      { type: 'code', label: 'Echo', config: { code: 'return { result: input.message };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Echo'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Echo', toHandle: 'input-0' },
      { from: 'Echo', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The trigger config UI shows the webhook URL (with the secret masked)
    await openConfig(page, 'Webhook');
    const modal = page.getByTestId('node-config-modal');
    await expect(modal.getByText(/\/webhook\//).first()).toBeVisible({ timeout: 5000 });
    await closeConfig(page);

    // Flow correctness is verified in the UI: debug run with a webhook payload
    await runWebhookFlow(page, '{"message":"hello webhook"}');
    await expectCompleted(page);
    await expandStep(page, 'Echo');
    await expect(debugOverlay(page).getByText(/"result": "hello webhook"/).first()).toBeVisible({ timeout: 5000 });

    // The webhook endpoint has no UI — POSTing to it is the only way to
    // trigger a real (worker-enqueued) webhook run. The flow config above and
    // the payload->result behavior above are asserted through the UI.
    const webhookRes = await request.post(`${API_URL}/webhook/${flowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 'hello webhook' },
    });
    expect(webhookRes.ok()).toBe(true);
    const webhookData = await webhookRes.json();
    expect(webhookData.executionId).toBeDefined();
    expect(webhookData.status).toBe('queued');

    // NOTE: worker-executed webhook runs are persisted executions with no UI
    // (the debug overlay runs in-memory) — polling the record is a documented
    // UI gap (see refactor guide: persisted executions stay API-based).
    const exec = await pollExecution(request, webhookData.executionId, 45000);
    expect(exec.status).toBe('completed');
  });

  test('rejects POST with a wrong secret', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookWrongSecret'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const res = await request.post(`${API_URL}/webhook/${flowId}?secret=wrong-secret`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Invalid webhook secret');
  });

  test('accepts POST with the X-Webhook-Secret header (preferred over ?secret=)', async ({ page, request }, testInfo) => {
    // Security hardening: the secret can be supplied via the X-Webhook-Secret
    // request header instead of the ?secret= query param, which leaks the
    // secret into logs/history. Endpoint behavior — no UI surface.
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookHeader'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const webhookRes = await request.post(`${API_URL}/webhook/${flowId}`, {
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
      data: { message: 'hello header' },
    });
    expect(webhookRes.status()).toBe(202);
    const body = await webhookRes.json();
    expect(body.executionId).toBeDefined();
    expect(body.status).toBe('queued');

    // Persisted worker run — documented UI gap (no execution-record UI).
    const exec = await pollExecution(request, body.executionId, 45000);
    expect(exec.status).toBe('completed');
  });

  test('rejects POST with a wrong X-Webhook-Secret header', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookWrongHeader'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const res = await request.post(`${API_URL}/webhook/${flowId}`, {
      headers: { 'X-Webhook-Secret': 'wrong-secret' },
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Invalid webhook secret');
  });

  test('rejects POST without a secret when the flow requires one', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookNoSecret'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const res = await request.post(`${API_URL}/webhook/${flowId}`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Authentication required');
  });

  test('rejects anonymous POST even when the flow has no secret (auto-created API key still gates it)', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookAnon'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // Webhook flows auto-generate a personal API key on save; the openapi
    // gateway requires a key or secret even when no webhookSecret is set.
    const res = await request.post(`${API_URL}/webhook/${flowId}`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Authentication required');
  });

  test('accepts POST with a personal API key when no secret is configured', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookKeyTest'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The raw key is only ever shown once, right after Renew Key, inside the
    // trigger config modal — read it from there (the UI way to obtain it).
    await openConfig(page, 'Webhook');
    const modal = page.getByTestId('node-config-modal');
    await modal.getByRole('button', { name: 'Renew Key' }).click();
    const keyEl = modal.locator('code').filter({ hasText: /^wh_/ }).first();
    await expect(keyEl).toBeVisible({ timeout: 5000 });
    const rawKey = (await keyEl.textContent())?.trim();
    expect(rawKey).toMatch(/^wh_/);
    await closeConfig(page);

    const webhookRes = await request.post(`${API_URL}/webhook/${flowId}`, {
      headers: { Authorization: `Bearer ${rawKey}` },
      data: { message: 'key-auth' },
    });
    expect(webhookRes.status()).toBe(202);
    const body = await webhookRes.json();
    expect(body.executionId).toBeDefined();

    const exec = await pollExecution(request, body.executionId, 45000);
    expect(exec.status).toBe('completed');
  });

  test('rejects POST for a non-webhook flow', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookManual'), [
      { type: 'trigger', label: 'Manual', config: { triggerType: 'manual' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Manual', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // Security hardening: authentication runs before the trigger-type check and
    // flows without credentials are never publicly triggerable — a manual flow
    // with no webhook secret or API key is rejected with 401 before the
    // trigger-type check can return 400.
    const res = await request.post(`${API_URL}/webhook/${flowId}`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Authentication required');
  });

  test('rejects POST for a non-existent flow', async ({ request }) => {
    // No flow exists and none can be created for this — pure endpoint
    // behavior with no UI surface at all.
    const res = await request.post(`${API_URL}/webhook/00000000-0000-4000-8000-000000000000`, {
      data: { message: 'hello' },
    });
    expect(res.status()).toBe(404);
  });

  test('rejects invalid input payload against the trigger input schema', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('WebhookSchema'), [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', webhookSecret: WEBHOOK_SECRET, inputSchema: '{"message":"string"}' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The input schema was configured through the UI; the endpoint-side
    // validation of POSTed payloads is the only way to exercise it.
    const res = await request.post(`${API_URL}/webhook/${flowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 42 },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Input validation failed');
  });
});
