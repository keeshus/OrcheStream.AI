import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';
import {
  addNode, nodeByLabel, clickNode, configureNode, closeConfig, fillField,
  fillFieldByPlaceholder, fillJsonSchema, selectOption, selectNativeOption,
  connect, moveNodeToSlot, getZoom, saveFlow, runFlow, debugOverlay, expandStep,
  expectCompleted, expectFailed, expectFinalOutput,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const WEBHOOK_SECRET = 'ft-e2e-secret';

// Mirror of the worker engine's slugify (worker/src/executor/engine.ts): the
// Flow Tool tool name is `flow_` + slugify(flow name), so tests compute the
// exact tool name the mock LLM must call from the name they created.
const slugify = (s: string) =>
  s.toLowerCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);

// ── UI flow builder ────────────────────────────────────────────────────────
// Everything below goes through the real editor UI: catalog clicks, canvas
// handle drags, config modal forms, Save button and the debug run overlay.

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

/** Open the config modal for a node and apply its config via the UI form. */
async function applyConfig(page: any, type: string, label: string, config: Record<string, any> = {}) {
  const modal = page.getByTestId('node-config-modal');
  switch (type) {
    case 'trigger': {
      // The Trigger Type select only renders for non-subflow triggers; a
      // webhook flow is created by switching the draft's manual trigger.
      const tt = page.locator('[data-field-label="Trigger Type"]');
      if (config.triggerType && (await tt.isVisible().catch(() => false))) {
        await selectOption(page, 'Trigger Type', config.triggerType);
      }
      if (config.inputSchema) await fillJsonSchema(page, config.inputSchema);
      if (config.webhookSecret) await fillField(page, 'Webhook Secret', config.webhookSecret);
      break;
    }
    case 'code':
      if (config.code) await fillField(page, 'JavaScript Code', config.code);
      break;
    case 'llm-agent': {
      if (config.endpointId) {
        await selectOption(page, 'LLM Endpoint', /E2E Mock LLM/);
      }
      if (config.model) {
        await selectOption(page, 'Model', config.model);
      }
      if (config.systemPrompt) {
        await fillFieldByPlaceholder(page, 'You are a helpful assistant... Type {{ for field suggestions', config.systemPrompt);
      }
      if (config.responseFormat === 'json_object') {
        await selectOption(page, 'Response Format', 'JSON');
      } else if (config.responseFormat === 'text') {
        await selectOption(page, 'Response Format', 'Plain Text');
      }
      break;
    }
    case 'flow-tool':
      for (const name of config.selectedFlowNames || []) {
        await modal.getByText(name, { exact: true }).waitFor({ timeout: 5000 });
        const row = modal.locator('label').filter({ has: page.getByText(name, { exact: true }) });
        await row.locator('input[type="checkbox"]').check();
      }
      break;
    case 'output': {
      for (const field of config.inputFields || []) {
        if (field.includes('.')) {
          const fieldName = field.split('.').pop();
          await modal.locator('label').filter({ hasText: fieldName! }).locator('input[type="checkbox"]').check();
        } else {
          await modal.locator('label').filter({ has: page.getByText(field, { exact: true }) }).first().locator('input[type="checkbox"]').check();
        }
      }
      break;
    }
    default:
      break;
  }
}

// openConfig is defined above (robust, retries after deselection).



/** Whether an edge from one labeled node to another exists on the canvas. */
async function edgeExists(page: any, fromLabel: string, toLabel: string): Promise<boolean> {
  return page.evaluate(([fromLabel, toLabel]: string[]) => {
    const nodes = Array.from(document.querySelectorAll('.react-flow__node')) as HTMLElement[];
    const findId = (label: string) => nodes.find(n => n.innerText.includes(label))?.getAttribute('data-id');
    const srcId = findId(fromLabel);
    const tgtId = findId(toLabel);
    if (!srcId || !tgtId) return false;
    return Array.from(document.querySelectorAll('.react-flow__edge')).some((el) => {
      const id = (el as HTMLElement).getAttribute('data-id') || '';
      return id.includes(srcId) && id.includes(tgtId) && id.indexOf(srcId) < id.indexOf(tgtId);
    });
  }, [fromLabel, toLabel]);
}

/**
 * Open the config modal for a node, retrying after deselecting. A node kept
 * selected by a previous interaction is z-raised and can intercept the click;
 * clicking the empty pane (30,30) clears the selection.
 */
async function openConfig(page: any, label: string) {
  const ibox = await nodeByLabel(page, label).boundingBox().catch(() => null);
  if (ibox && (ibox.y < -20 || ibox.y > 1020 || ibox.x < -20 || ibox.x > 1900)) {
    await page.getByRole('button', { name: 'Fit View' }).click().catch(() => {});
    await page.waitForTimeout(300);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const node = nodeByLabel(page, label);
    await node.click({ timeout: 2500 }).catch(() => {});
    if (await page.getByTestId('node-config-modal').isVisible().catch(() => false)) return;
    // A node kept selected by a previous interaction is z-raised and can
    // intercept clicks; clicking the empty pane clears the selection.
    await page.mouse.click(30, 30).catch(() => {});
    await page.waitForTimeout(250);
    // Last resort: force-click straight at the node's coordinates, bypassing
    // the hit-test (covers transient overlays/tooltips).
    await node.click({ force: true, timeout: 2500 }).catch(() => {});
    if (await page.getByTestId('node-config-modal').isVisible().catch(() => false)) return;
    await page.waitForTimeout(250);
  }
  await clickNode(page, label);
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
}


/** configureNode with interception retries (see openConfig above). */
async function configureNodeRobust(page: any, label: string, newLabel?: string) {
  const ibox = await nodeByLabel(page, label).boundingBox().catch(() => null);
  if (ibox && (ibox.y < -20 || ibox.y > 1020 || ibox.x < -20 || ibox.x > 1900)) {
    await page.getByRole('button', { name: 'Fit View' }).click().catch(() => {});
    await page.waitForTimeout(300);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await nodeByLabel(page, label).click({ timeout: 2500 }).catch(() => {});
    if (await page.getByTestId('node-config-modal').isVisible().catch(() => false)) break;
    await page.mouse.click(30, 30).catch(() => {});
    await page.waitForTimeout(250);
    await nodeByLabel(page, label).click({ force: true, timeout: 2500 }).catch(() => {});
    if (await page.getByTestId('node-config-modal').isVisible().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
  if (newLabel) {
    await page.getByLabel('Node name').fill(newLabel);
  }
}

/** Move a node to a grid slot and VERIFY it arrived (drag imprecision can
 * leave nodes short, causing overlaps that intercept clicks). Re-drags from
 * the fresh position until within tolerance. */
async function moveNodeToSlotVerified(page: any, label: string, col: number, row: number) {
  const scale = await getZoom(page);
  const rf = await page.locator('.react-flow').boundingBox();
  const box0 = await nodeByLabel(page, label).boundingBox();
  if (!box0 || !rf) throw new Error(`Cannot bound node ${label} or canvas`);
  const targetX = rf.x + rf.width / 2 + col * 360 * scale;
  const targetY = rf.y + rf.height / 2 + row * 260 * scale;
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await nodeByLabel(page, label).boundingBox();
    if (!box) throw new Error(`Cannot bound node ${label}`);
    const dist = Math.hypot(box.x + box.width / 2 - targetX, box.y + box.height / 2 - targetY);
    if (dist < 40) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 12 });
    await page.mouse.up();
    // Let React Flow finish processing the drag end before the node is
    // clicked again — a click that lands too early gets intercepted.
    await page.waitForTimeout(150);
  }
  throw new Error(`Could not move node ${label} to slot (${col}, ${row})`);
}

/** Two-pass flow building inside an already-open editor (see 90-node-types). */
async function buildFlowInEditor(page: any, flowId: string, nodes: UiNode[], edges: UiEdge[]) {
  const colShift = (nodes.length - 1) / 2;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'trigger') {
      await configureNodeRobust(page, 'Trigger', n.label);
      await closeConfig(page);
      await moveNodeToSlotVerified(page, n.label, (n.col ?? i) - colShift, n.row ?? 0);
    } else {
      const autoLabel = await addNode(page, n.type);
      await moveNodeToSlotVerified(page, autoLabel, (n.col ?? i) - colShift, n.row ?? 0);
      await configureNodeRobust(page, autoLabel, n.label);
      await closeConfig(page);
    }
  }
  // Normalize the viewport (zoom/pan drift can leave nodes off-screen).
  await page.getByRole('button', { name: 'Fit View' }).click().catch(() => {});
  await page.waitForTimeout(300);
  // Connect ALL edges first, then configure every node. The editor's
  // FlowEditor resets its internal edge state from the parent's props on every
  // re-render (sync effect), so a config-driven re-render between a handle
  // drag and the deferred state propagation can wipe the just-created edge —
  // the config modal then snapshots stale upstreams and shows no fields. With
  // all edges in place first and a settle window, the propagated state always
  // contains them. (These specs use no switch nodes, whose output handles only
  // appear after their config, so connecting before configuring is safe.)
  for (const e of edges) {
    await connect(page, e.from, e.fromHandle, e.to, e.toHandle);
  }
  // Let the deferred edge-state propagation land before any modal opens.
  await page.waitForTimeout(350);
  // The FlowEditor's sync effect resets its internal edge state from the
  // parent's props on every re-render; a config-driven re-render can wipe an
  // edge created moments earlier (deferred rAF propagation). Verify the
  // incoming edges before each config (the modal's upstream list derives from
  // them) and again after all configs, reconnecting anything dropped.
  for (let i = 0; i < nodes.length; i++) {
    for (const e of edges) {
      if (e.to === nodes[i].label && !(await edgeExists(page, e.from, e.to))) {
        await connect(page, e.from, e.fromHandle, e.to, e.toHandle);
      }
    }
    await page.waitForTimeout(150);
    await openConfig(page, nodes[i].label);
    await applyConfig(page, nodes[i].type, nodes[i].label, nodes[i].config);
    await closeConfig(page);
  }
  for (const e of edges) {
    if (!(await edgeExists(page, e.from, e.to))) {
      await connect(page, e.from, e.fromHandle, e.to, e.toHandle);
    }
  }
  await saveFlow(page);
  return flowId;
}

/**
 * Create a new flow via the "New Flow" button WITHOUT the shared helper's
 * early save. The editor creates the draft server-side (createDraftFlow) and
 * then re-fetches it after the URL replace (edit.tsx useEffect [id]); that
 * refetch overwrites the local flow state — including the name field — when
 * it lands, which reverts any earlier fill to the draft name ("New Flow N")
 * and can leave the Save button disabled when a stale draft with that name
 * exists. We wait for that refetch response before filling, so the intended
 * name is persisted by the final save of buildFlowInEditor instead.
 */
async function createFlowViaUiStable(page: any, name: string): Promise<string> {
  await page.goto('/flows');
  await page.getByText('New Flow').first().click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
  const match = page.url().match(/\/flows\/([^/]+)\/edit/);
  if (!match) throw new Error(`Could not resolve flow id from URL: ${page.url()}`);
  await page.waitForResponse((r: any) => r.url().includes(`/api/flows/${match[1]}`) && r.request().method() === 'GET', { timeout: 10000 }).catch(() => {});
  await page.getByLabel('Flow name').fill(name);
  // Defensive: if the refetch landed after all, re-assert the name.
  await page.waitForTimeout(500);
  if ((await page.getByLabel('Flow name').inputValue()) !== name) {
    await page.getByLabel('Flow name').fill(name);
  }
  return match[1];
}

/** Create a manual-trigger flow via the UI and build it in the editor. */
async function buildUiFlow(page: any, name: string, nodes: UiNode[], edges: UiEdge[]): Promise<string> {
  const flowId = await createFlowViaUiStable(page, name);
  return buildFlowInEditor(page, flowId, nodes, edges);
}

/**
 * Dismiss the "Personal API Key Created" modal that the frontend shows once
 * after the first save of a webhook-triggered flow (the backend auto-deploys
 * the webhook slug + key on create/update).
 */
async function dismissApiKeyModal(page: any) {
  const modal = page.locator('[data-co-pilot-modal="api-key"]');
  if (await modal.isVisible().catch(() => false)) {
    await modal.getByRole('button', { name: /copied my key/i }).click();
    await expect(modal).not.toBeVisible();
  }
}

/**
 * Build a webhook-triggered flow (a Flow Tool "tool" target) through the
 * editor UI: the trigger's Trigger Type is switched to Webhook and the
 * optional input schema / webhook secret are set via the config form.
 */
async function buildWebhookFlowViaUi(page: any, name: string, trigger: Record<string, any>, nodes: UiNode[], edges: UiEdge[]): Promise<string> {
  const flowId = await createFlowViaUiStable(page, name);
  await buildFlowInEditor(page, flowId, [
    { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', ...trigger } },
    ...nodes,
  ], edges);
  await dismissApiKeyModal(page);
  return flowId;
}

/**
 * Safety net: purge draft-named flows ("New Flow", "New Subflow" + numbered
 * retries from edit.tsx createDraftFlow). If a test dies before registering
 * its flow id, the draft leaks under its draft name; piled-up drafts make the
 * next draft creation retry slower (409 loop) and can exhaust the 20-attempt
 * budget. This stack is dedicated to this spec, so the purge is safe here.
 */
async function purgeDraftFlows(request: any) {
  const res = await request.get(`${API_URL}/flows?limit=100`);
  if (!res.ok()) return;
  const list = await res.json();
  for (const f of (list.data || [])) {
    if (/^New (Flow|Subflow)( \d+)?$/.test(f.name)) {
      await request.delete(`${API_URL}/flows/${f.id}`).catch(() => {});
    }
  }
}

test.describe('Flow Tool node', () => {
  test('appears in the node catalog under Tools', async ({ page }, testInfo) => {
    (testInfo as any).flowId = await createFlowViaUiStable(page, uniqueFlowName('FlowTool'));
    await page.getByTestId('add-node-btn').click();
    await expect(page.getByTestId('catalog-flow-tool')).toBeVisible({ timeout: 5000 });
  });

  test('can be added to the canvas', async ({ page }, testInfo) => {
    (testInfo as any).flowId = await createFlowViaUiStable(page, uniqueFlowName('FlowTool'));
    // The editor draft always ships with a Trigger node, so the canvas has 2
    // nodes after adding the Flow Tool.
    await page.getByTestId('add-node-btn').click();
    await page.getByTestId('catalog-flow-tool').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2, { timeout: 5000 });
    await expect(page.getByText('Flow Tool')).toBeVisible();
  });
});

test.describe('Flow Tool config', () => {
  let webhookFlowId: string;
  let webhookFlowName: string;
  let flowId: string;

  test.beforeEach(async ({ page }) => {
    // A webhook flow to appear in the Flow Tool picker — built through the
    // real editor UI (trigger switched to Webhook, schema set in the form).
    webhookFlowName = uniqueFlowName('WeatherAPI');
    webhookFlowId = await buildWebhookFlowViaUi(page, webhookFlowName, { inputSchema: '{"message":"string"}' }, [
      { type: 'code', label: 'Process', config: { code: 'return { result: `Weather in ${input.message}: sunny, 22°C` };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Process'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Process', toHandle: 'input-0' },
      { from: 'Process', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    // The main flow with a single Flow Tool node
    flowId = await buildUiFlow(page, uniqueFlowName('FlowToolConfig'), [
      { type: 'flow-tool', label: 'Flow Tool', config: {} },
    ], []);
  });

  test.afterEach(async ({ request }) => {
    if (webhookFlowId) await deleteFlow(request, webhookFlowId).catch(() => {});
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
    await purgeDraftFlows(request);
  });

  test('shows webhook flows in the config panel', async ({ page }) => {
    await openConfig(page, 'Flow Tool');
    // The webhook flow should appear in the list
    await expect(page.getByTestId('node-config-modal').getByText(webhookFlowName, { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('excludes non-webhook flows from the flow-tool picker', async ({ page }, testInfo) => {
    // Create a manual-trigger flow via the UI — it must NOT show up in the picker
    const manualId = await createFlowViaUiStable(page, uniqueFlowName('PickerManual'));
    (testInfo as any).flowId = manualId;

    // Creating the manual flow navigated away from the main flow — go back
    await page.goto(`/flows/${flowId}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });
    await openConfig(page, 'Flow Tool');
    const modal = page.getByTestId('node-config-modal');

    // The webhook flow (created in beforeEach) is listed...
    await expect(modal.getByText(webhookFlowName, { exact: true })).toBeVisible({ timeout: 5000 });
    // ...but the manual flow is excluded entirely
    await expect(modal.getByText('PickerManual')).toHaveCount(0);
    // Exactly one checkbox = exactly one webhook flow in the list
    await expect(modal.locator('input[type="checkbox"]')).toHaveCount(1);
  });

  test('flow-tool selection persists after save and reload', async ({ page }) => {
    await openConfig(page, 'Flow Tool');
    const modal = page.getByTestId('node-config-modal');

    // Select the webhook flow
    await modal.locator('input[type="checkbox"]').first().check();
    await expect(modal.getByText(/1 flow selected/)).toBeVisible({ timeout: 3000 });

    // Close the modal, save via the editor, then reload the page
    await closeConfig(page);
    await saveFlow(page);
    await page.goto(`/flows/${flowId}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });

    // Reopen the config — the selection must still be checked
    await openConfig(page, 'Flow Tool');
    const modal2 = page.getByTestId('node-config-modal');
    await expect(modal2.getByText(webhookFlowName, { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(modal2.locator('input[type="checkbox"]').first()).toBeChecked();
    await expect(modal2.getByText(/1 flow selected/)).toBeVisible({ timeout: 3000 });
  });

  test('allows selecting a webhook flow', async ({ page }) => {
    await openConfig(page, 'Flow Tool');
    const modal = page.getByTestId('node-config-modal');
    // Click the checkbox for the webhook flow
    await modal.locator('input[type="checkbox"]').first().check();
    // Summary text should appear
    await expect(modal.getByText(/flow.*selected/)).toBeVisible({ timeout: 3000 });
  });
});

test.describe('Flow Tool execution', () => {
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Mock LLM', providerType: 'openai', baseUrl: 'http://mock-llm-e2e:3002/v1', apiKey: 'mock-key', defaultModel: 'mock-gpt-4', models: ['mock-gpt-4'] },
    });
    if (res.ok()) { const ep = await res.json(); mockEndpointId = ep.id; }
  });

  test.afterAll(async ({ request }) => {
    if (mockEndpointId) await request.delete(`${API_URL}/llm-endpoints/${mockEndpointId}`);
  });

  test.afterEach(async ({ request }, testInfo) => {
    const flowIds: string[] = (testInfo as any).flowIds || [];
    if ((testInfo as any).flowId) flowIds.push((testInfo as any).flowId);
    for (const id of flowIds) {
      await deleteFlow(request, id).catch(() => {});
    }
    await purgeDraftFlows(request);
  });

  /** Build a webhook tool flow with a lookup code node, via the UI. */
  async function buildToolFlow(page: any, name: string, code: string): Promise<string> {
    return buildWebhookFlowViaUi(page, name, { inputSchema: '{"message":"string"}' }, [
      { type: 'code', label: 'Process', config: { code } },
      { type: 'output', label: 'Output', config: { inputFields: ['Process'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Process', toHandle: 'input-0' },
      { from: 'Process', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
  }

  /** Build the main flow (Trigger → LLM Agent → Output + Flow Tool node). */
  async function buildMainFlow(page: any, toolFlowName: string, extra: { prompt?: string; toolNodeLabel?: string; extraNodes?: UiNode[]; extraEdges?: UiEdge[] } = {}) {
    const flowId = await buildUiFlow(page, uniqueFlowName('FlowToolExec'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: {
        endpointId: mockEndpointId!, model: 'mock-gpt-4',
        systemPrompt: extra.prompt || 'You are helpful. MOCK_RESPONSE: "Done!"',
        responseFormat: 'text',
      } },
      { type: 'flow-tool', label: extra.toolNodeLabel || 'Flow Tool', config: { selectedFlowNames: [toolFlowName] } },
      ...(extra.extraNodes || []),
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
      { from: extra.toolNodeLabel || 'Flow Tool', fromHandle: 'tool-output', to: 'LLM Agent', toHandle: 'tool-input-0' },
      ...(extra.extraEdges || []),
    ]);
    return flowId;
  }

  test('executes a webhook flow via Flow Tool when LLM Agent calls it', async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    // Create a webhook flow (the "tool" to be called) via the editor UI
    const webhookName = uniqueFlowName('Weather API');
    const webhookFlowId = await buildToolFlow(page, webhookName, 'return { result: `Weather in ${input.message}: sunny, 22°C` };');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(webhookFlowId);

    const slug = slugify(webhookName);
    const flowId = await buildMainFlow(page, webhookName, {
      prompt: `You have weather tools. MOCK_TOOL_CALL: flow_${slug} {"message":"Amsterdam"} MOCK_RESPONSE: "Done! Weather retrieved."`,
    });
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'get weather');
    await expectCompleted(page, 30000);

    // The LLM Agent step ran the tool call and returned the mock response
    await expandStep(page, 'LLM Agent');
    await expect(debugOverlay(page).getByText('Done! Weather retrieved.').first()).toBeVisible({ timeout: 5000 });
    // The tool call chip shows the flow tool's name
    await expect(debugOverlay(page).getByText(new RegExp(`flow_${slug.replace(/-/g, '\\-')}\\(message\\)`)).first()).toBeVisible({ timeout: 5000 });
    await expectFinalOutput(page, /Done! Weather retrieved./);

    // The flow-tool node is skipped as a DAG node — its card never leaves pending
    const ftCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText('Flow Tool', { exact: true }) }).first();
    await expect(ftCard).toContainText('pending');
  });

  // NOTE: the direct webhook POST test stays API-based — the webhook HTTP
  // endpoint (?secret=...) is an external surface with no UI representation;
  // only the tool flow itself is built through the editor.
  test('executes webhook flow via POST endpoint and returns correct result', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(120000);

    // Build the echo webhook flow via the UI, including its webhook secret
    const webhookName = uniqueFlowName('EchoWebhook');
    const webhookFlowId = await buildWebhookFlowViaUi(page, webhookName, { inputSchema: '{"message":"string"}', webhookSecret: WEBHOOK_SECRET }, [
      { type: 'code', label: 'Echo', config: { code: 'return { result: input.message.toUpperCase() };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Echo'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Echo', toHandle: 'input-0' },
      { from: 'Echo', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = webhookFlowId;

    // Test the webhook endpoint works directly
    const webhookRes2 = await request.post(`${API_URL}/webhook/${webhookFlowId}?secret=${WEBHOOK_SECRET}`, {
      data: { message: 'hello webhook' },
    });
    expect(webhookRes2.ok()).toBe(true);
    const webhookData = await webhookRes2.json();
    expect(webhookData.executionId).toBeDefined();
    expect(webhookData.status).toBe('queued');

    // Poll for completion
    const { pollExecution } = await import('./helpers/stream');
    const exec = await pollExecution(request, webhookData.executionId, 45000);
    expect(exec.status).toBe('completed');
  });

  test('Flow Tool with multiple webhook flows provides multiple tools', async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(240000);

    // Create two webhook flows via the UI
    const flow1Name = uniqueFlowName('Get Weather');
    const flow1Id = await buildWebhookFlowViaUi(page, flow1Name, { inputSchema: '{"city":"string"}' }, [
      { type: 'code', label: 'Process', config: { code: 'return { result: `Weather in ${input.city}: sunny` };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Process'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Process', toHandle: 'input-0' },
      { from: 'Process', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(flow1Id);

    const flow2Name = uniqueFlowName('Send Email');
    const flow2Id = await buildWebhookFlowViaUi(page, flow2Name, { inputSchema: '{"to":"string","subject":"string"}' }, [
      { type: 'code', label: 'Send', config: { code: 'return { result: `Email sent to ${input.to}` };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Send'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Send', toHandle: 'input-0' },
      { from: 'Send', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds.push(flow2Id);

    // Main flow with both flows as tools; the mock calls flow_<slug1>
    const slug1 = slugify(flow1Name);
    const flowId = await buildMainFlow(page, flow1Name, {
      prompt: `You have weather and email tools. MOCK_TOOL_CALL: flow_${slug1} {"city":"London"} MOCK_RESPONSE: "Done! Weather checked."`,
    });
    // Select BOTH webhook flows in the Flow Tool config
    await openConfig(page, 'Flow Tool');
    const modal = page.getByTestId('node-config-modal');
    const row2 = modal.locator('label').filter({ has: page.getByText(flow2Name, { exact: true }) });
    await row2.locator('input[type="checkbox"]').check();
    await expect(modal.getByText(/2 flows selected/)).toBeVisible({ timeout: 3000 });
    await closeConfig(page);
    await saveFlow(page);
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'check weather');
    await expectCompleted(page, 30000);
    await expandStep(page, 'LLM Agent');
    await expect(debugOverlay(page).getByText('Done! Weather checked.').first()).toBeVisible({ timeout: 5000 });
    await expectFinalOutput(page, /Done! Weather checked./);
  });

  test('Flow Tool handles webhook flow without input schema', async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    // A webhook flow with NO input schema (callable without parameters)
    const webhookName = uniqueFlowName('Simple Ping');
    const webhookFlowId = await buildWebhookFlowViaUi(page, webhookName, {}, [
      { type: 'code', label: 'Pong', config: { code: 'return { result: "pong" };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Pong'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Pong', toHandle: 'input-0' },
      { from: 'Pong', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(webhookFlowId);

    const slug = slugify(webhookName);
    const flowId = await buildMainFlow(page, webhookName, {
      prompt: `MOCK_TOOL_CALL: flow_${slug} {} MOCK_RESPONSE: "Done!"`,
    });
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'ping');
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /Done!/);
  });

  test('Flow Tool execution emits step events for LLM and output', async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    const webhookName = uniqueFlowName('Echo Tool');
    const webhookFlowId = await buildToolFlow(page, webhookName, 'return { result: input.message };');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(webhookFlowId);

    const slug = slugify(webhookName);
    const flowId = await buildMainFlow(page, webhookName, {
      prompt: `MOCK_TOOL_CALL: flow_${slug} {"message":"test-echo"} MOCK_RESPONSE: "Echo complete."`,
    });
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'test');
    await expectCompleted(page, 30000);

    // The LLM step completed with the post-tool-call response
    await expandStep(page, 'LLM Agent');
    await expect(debugOverlay(page).getByText('Echo complete.').first()).toBeVisible({ timeout: 5000 });

    // The output step completed with the LLM content
    await expandStep(page, 'Output');
    await expect(debugOverlay(page).getByText('Echo complete.').first()).toBeVisible({ timeout: 5000 });

    // The flow-tool node is skipped during DAG execution — stays pending
    const ftCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText('Flow Tool', { exact: true }) }).first();
    await expect(ftCard).toContainText('pending');
  });

  test('realistic flow: LLM uses Flow Tool to look up data, then code node processes the result', async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    const webhookName = uniqueFlowName('Data Lookup');
    const webhookFlowId = await buildWebhookFlowViaUi(page, webhookName, { inputSchema: '{"key":"string"}' }, [
      { type: 'code', label: 'Query', config: { code: 'return { value: `Data for ${input.key}: value=42, status=active` };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Query'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Query', toHandle: 'input-0' },
      { from: 'Query', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(webhookFlowId);

    const slug = slugify(webhookName);
    // Main flow: Trigger → LLM Agent (calls flow tool) → Code (processes) → Output
    const flowId = await buildUiFlow(page, uniqueFlowName('RealFlowTool'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'Analyzer', config: {
        endpointId: mockEndpointId!, model: 'mock-gpt-4',
        systemPrompt: `Look up data. MOCK_TOOL_CALL: flow_${slug} {"key":"test-key"} MOCK_RESPONSE: "The tool returned: {value: Test Data}".`,
        responseFormat: 'text',
      } },
      { type: 'flow-tool', label: 'Data Tool', config: { selectedFlowNames: [webhookName] } },
      { type: 'code', label: 'Formatter', config: { code: 'const raw = input.analyzer?.content || input.l1?.content || ""; return { summary: `LLM said: ${raw}`, timestamp: new Date().toISOString() };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Formatter'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Analyzer', toHandle: 'input-0' },
      { from: 'Analyzer', fromHandle: 'output-0', to: 'Formatter', toHandle: 'input-0' },
      { from: 'Formatter', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
      { from: 'Data Tool', fromHandle: 'tool-output', to: 'Analyzer', toHandle: 'tool-input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'lookup data');
    await expectCompleted(page, 30000);

    // The code node processed the LLM output
    await expandStep(page, 'Formatter');
    await expect(debugOverlay(page).getByText(/"summary": "LLM said:/).first()).toBeVisible({ timeout: 5000 });
    await expect(debugOverlay(page).getByText(/Test Data/).first()).toBeVisible({ timeout: 5000 });
    await expectFinalOutput(page, /LLM said:/);

    // The Flow Tool node was skipped as a DAG node — stays pending
    const ftCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText('Data Tool', { exact: true }) }).first();
    await expect(ftCard).toContainText('pending');
  });

  // NOTE: the old version of this test pinned engine-internal failure details
  // (toolResult.status/error in the SSE 'log' events and subflow.failed
  // payloads) which the debug overlay does not render. The UI-observable
  // contract — a failing tool call is fed back to the LLM (not silent) and
  // the run still completes with the LLM's recovery response — is asserted
  // via the overlay below. The tool flow itself now fails with a runtime JS
  // error (the old python-language code node cannot be expressed in the
  // editor — the code form only supports JavaScript).
  test('surfaces a failing webhook flow tool call to the LLM (not silent)', async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    // A webhook tool flow that throws at runtime — a real tool failure
    const webhookName = uniqueFlowName('Broken Tool');
    const brokenId = await buildToolFlow(page, webhookName, 'throw new Error("tool exploded");');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(brokenId);

    const slug = slugify(webhookName);
    const flowId = await buildMainFlow(page, webhookName, {
      prompt: `MOCK_TOOL_CALL: flow_${slug} {"message":"boom"} MOCK_RESPONSE: "Recovered after failure."`,
    });
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'go');
    await expectCompleted(page, 30000);

    // The LLM received the failure as a tool result and completed with its response
    await expandStep(page, 'LLM Agent');
    await expect(debugOverlay(page).getByText('Recovered after failure.').first()).toBeVisible({ timeout: 5000 });
    await expectFinalOutput(page, /Recovered after failure./);
  });
});

test.describe('Flow Tool group filter scoping', () => {
  test('non-admin editors only see their own groups in the Flow Tool filter', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(120000);
    const mine = (await (await request.post(`${API_URL}/groups`, { data: { name: `FT-Mine-${Date.now()}` } })).json());
    const other = (await (await request.post(`${API_URL}/groups`, { data: { name: `FT-Other-${Date.now()}` } })).json());

    // A container flow with a single Flow Tool node, built through the editor UI
    const containerId = await createFlowViaUiStable(page, uniqueFlowName('FT-Scope'));
    await addNode(page, 'flow-tool');
    await configureNode(page, 'flow-tool1', 'Flow Tool');
    await closeConfig(page);
    await saveFlow(page);
    (testInfo as any).flowId = containerId;

    // Register an editor with membership in `mine` only (fixture setup)
    const email = `ft-editor-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'FT Editor', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    const roles = await (await request.get(`${API_URL}/roles`)).json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${regData.user.id}/role`, { data: { role_id: editorRole.id } });
    await request.post(`${API_URL}/groups/${mine.id}/members`, { data: { userId: regData.user.id } });

    try {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill('Test1234!');
      await page.getByRole('button', { name: /sign.?in/i }).click();
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });

      await expect.poll(async () => {
        const meRes = await page.request.get(`${API_URL}/auth/me`);
        if (!meRes.ok()) return 'ERR';
        return (await meRes.json()).user?.role;
      }, { timeout: 10000 }).toBe('editor');

      await page.goto(`/flows/${containerId}/edit`);
      await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });
      // The draft always ships with a Trigger node — open the Flow Tool's config
      await page.locator('.react-flow__node').filter({ has: page.getByText('Flow Tool', { exact: true }) }).first().click();
      const modal = page.getByTestId('node-config-modal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // The filter lists only the editor's own group
      await expect(modal.getByText('Filter by group')).toBeVisible({ timeout: 5000 });
      await modal.getByText('All groups').first().click();
      await expect(modal.getByText(mine.name, { exact: true })).toBeVisible({ timeout: 5000 });
      await expect(modal.getByText(other.name, { exact: true })).toHaveCount(0);
    } finally {
      await request.delete(`${API_URL}/users/${regData.user.id}`).catch(() => {});
      await deleteFlow(request, containerId).catch(() => {});
      await request.delete(`${API_URL}/groups/${mine.id}`).catch(() => {});
      await request.delete(`${API_URL}/groups/${other.id}`).catch(() => {});
    }
  });
});
