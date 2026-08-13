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
const cookie = getAuthCookie() || undefined;

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
      break;
    }
    case 'code':
      if (config.code) await fillField(page, 'JavaScript Code', config.code);
      if (config.outputSchema) {
        await fillJsonSchema(page, config.outputSchema);
      }
      break;
    case 'condition':
      if (config.condition) await fillFieldByPlaceholder(page, 'input.score > 0.5', config.condition);
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
      if (config.outputSchema) {
        await fillJsonSchema(page, config.outputSchema);
      }
      break;
    }
    case 'hitl': {
      if (config.prompt) {
        await fillFieldByPlaceholder(page, 'Please review the generated content before proceeding...', config.prompt);
      }
      if (config.mode === 'custom') {
        await modal.getByRole('button', { name: 'Custom' }).click();
        const buttons = config.buttons || [];
        for (let i = 0; i < buttons.length; i++) {
          await modal.getByRole('button', { name: '+ Add Button' }).click();
        }
        for (let i = 0; i < buttons.length; i++) {
          await page.getByLabel('Label').nth(i).fill(buttons[i].label);
          await page.getByLabel('Value').nth(i).fill(buttons[i].value);
        }
      }
      break;
    }
    case 'subflow': {
      if (config.subflowName) {
        const testId = `subflow-item-${config.subflowName.replace(/\s+/g, '-')}`;
        await modal.getByTestId(testId).click();
      }
      for (const [field, value] of Object.entries(config.inputMapping || {})) {
        await fillFieldByPlaceholder(page, `{{input.Label.${field}}}`, String(value));
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

/**
 

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

/** Two-pass flow building inside an already-open editor (flow already created).
 * Pass 1: add/rename/move all nodes. New nodes land at the canvas centre with
 * jitter, so each node is moved to its slot immediately after being added —
 * before any click. The grid is shifted so no slot sits at the canvas centre.
 * Pass 2: for each node in order, connect incoming edges first, then apply the
 * config (field selects derive from upstreams; switch output handles appear
 * only after cases are set), then close. Finally save.
 */
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
 * Create a SUBFLOW flow via the UI: the home page has a dedicated Subflows
 * tab with a "New Subflow" button that opens the editor with a
 * triggerType=subflow draft (see frontend/pages/index.tsx + edit.tsx
 * createDraftFlow). is_subflow is derived from the trigger on save.
 */
async function createSubflowViaUi(page: any, name: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Subflows' }).click();
  await page.getByRole('button', { name: 'New Subflow' }).click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
  const match = page.url().match(/\/flows\/([^/]+)\/edit/);
  if (!match) throw new Error(`Could not resolve flow id from URL: ${page.url()}`);
  // Wait for the editor's post-creation refetch (see createFlowViaUiStable)
  // so the rename below cannot be reverted to the draft name.
  await page.waitForResponse((r: any) => r.url().includes(`/api/flows/${match[1]}`) && r.request().method() === 'GET', { timeout: 10000 }).catch(() => {});
  await page.getByLabel('Flow name').fill(name);
  await page.waitForTimeout(500);
  if ((await page.getByLabel('Flow name').inputValue()) !== name) {
    await page.getByLabel('Flow name').fill(name);
  }
  // NOTE: no save here — subflow flows require an Output node before the Save
  // button enables ("Subflow: requires an Output node"); the flow is persisted
  // by buildFlowInEditor's final save.
  return match[1];
}

/** Create a subflow flow via the Subflows tab and build it in the editor. */
async function buildSubflowViaUi(page: any, name: string, nodes: UiNode[], edges: UiEdge[]): Promise<string> {
  const flowId = await createSubflowViaUi(page, name);
  return buildFlowInEditor(page, flowId, nodes, edges);
}

test.describe('Advanced multi-node flows', () => {
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const llmRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Mock LLM', providerType: 'openai', baseUrl: 'http://mock-llm-e2e:3002/v1', apiKey: 'mock-key', defaultModel: 'mock-gpt-4', models: ['mock-gpt-4'] },
    });
    if (llmRes.ok()) { const ep = await llmRes.json(); mockEndpointId = ep.id; }
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

  /**
   * Safety net: purge draft-named flows ("New Flow", "New Subflow" + numbered
   * retries from edit.tsx createDraftFlow). If a test dies before registering
   * its flow id, the draft leaks under its draft name; piled-up drafts make
   * the next draft creation retry slower (409 loop) and can exhaust the
   * 20-attempt budget. This stack is dedicated to this spec, so the purge is
   * safe here.
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

  /** Build the "Enrich" subflow via the Subflows tab UI. */
  async function buildEnrichSubflowViaUi(page: any): Promise<{ id: string; name: string }> {
    const name = uniqueFlowName('Enrich-Subflow');
    const id = await buildSubflowViaUi(page, name, [
      { type: 'trigger', label: 'Trigger', config: { inputSchema: '{"type":"object","properties":{"data":{"type":"string"},"score":{"type":"number"}},"required":["data"]}' } },
      { type: 'code', label: 'Enrich', config: { code: 'return { enriched: (input.data || "") + " (enriched)", originalScore: input.score || 0, doubledScore: (input.score || 0) * 2 }' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Enrich'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Enrich', toHandle: 'input-0' },
      { from: 'Enrich', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    return { id, name };
  }

  // ─── Debug: full flow with feedback loop ──────────────────────────

  test('debug: LLM, code, branch, feedback HITL loop, subflow, second HITL, output, Flow Tool', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    const subflow = await buildEnrichSubflowViaUi(page);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(subflow.id);

    // A webhook flow to feed the Flow Tool node (tool-callable target).
    const toolName = uniqueFlowName('FlowTool-Webhook');
    const toolFlowId = await buildUiFlow(page, toolName, [
      { type: 'trigger', label: 'Webhook', config: { triggerType: 'webhook', inputSchema: '{"query":"string"}' } },
      { type: 'code', label: 'Lookup', config: { code: 'return { result: `Looked up: ${input.query || "nothing"}` };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Lookup'] } },
    ], [
      { from: 'Webhook', fromHandle: 'output-0', to: 'Lookup', toHandle: 'input-0' },
      { from: 'Lookup', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds.push(toolFlowId);

    // The full feedback-loop flow, built through the editor UI. The HITL
    // "Retry" decision loops back into the Prep code node; "Approve" routes
    // to the subflow; the Flow Tool node feeds tools into the LLM Agent.
    // Cols/rows keep every node within ~±3 grid slots so handles stay
    // hit-testable in the 1920px viewport (see pitfall: nodes beyond ~1280px).
    const flowId = await buildUiFlow(page, uniqueFlowName('Adv-Feedback'), [
      { type: 'trigger', label: 'Trigger', col: 2, row: 0 },
      { type: 'llm-agent', label: 'Analyzer', col: 3, row: 0, config: {
        endpointId: mockEndpointId!, model: 'mock-gpt-4',
        systemPrompt: 'Analyze. MOCK_RESPONSE: {"verdict":"approve"}',
        responseFormat: 'json_object',
        outputSchema: '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}',
      } },
      { type: 'code', label: 'Prep', col: 4, row: -1, config: { code: 'const raw = input.analyzer?.content || input.l1?.content || ""; let verdict = ""; try { const idx = raw.indexOf("\\n"); const js = idx > 0 ? raw.substring(0, idx) : raw; verdict = JSON.parse(js.trim()).verdict || ""; } catch(e) {} return { decision: verdict }' } },
      { type: 'condition', label: 'Route', col: 4, row: 1, config: { condition: 'input.prep.decision === "approve"' } },
      { type: 'hitl', label: 'Review', col: 5, row: -1, config: { mode: 'custom', prompt: 'Approve?', buttons: [{ label: 'Retry', value: 'retry' }, { label: 'Approve', value: 'approved' }] } },
      { type: 'subflow', label: 'Enricher', col: 5, row: 1, config: { subflowId: subflow.id, subflowName: subflow.name, inputMapping: { data: '{{input.Trigger.message}}', score: '{{input.Trigger.score}}' } } },
      { type: 'hitl', label: 'Final', col: 6, row: 1, config: { prompt: 'Final approval?' } },
      { type: 'output', label: 'Output', col: 5, row: -2, config: { inputFields: ['Prep', 'Enricher'] } },
      { type: 'flow-tool', label: 'Flow Tool', col: 2, row: 2, config: { selectedFlowNames: [toolName] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Analyzer', toHandle: 'input-0' },
      { from: 'Analyzer', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Route', toHandle: 'input-0' },
      { from: 'Route', fromHandle: 'output-0', to: 'Review', toHandle: 'input-0' },
      // Feedback loop: Retry (output-0) → back into Prep
      { from: 'Review', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Review', fromHandle: 'output-1', to: 'Enricher', toHandle: 'input-0' },
      { from: 'Enricher', fromHandle: 'output-0', to: 'Final', toHandle: 'input-0' },
      { from: 'Final', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
      // Condition false path → Output directly
      { from: 'Route', fromHandle: 'output-1', to: 'Output', toHandle: 'input-0' },
      // Flow Tool feeds the LLM Agent's tool input
      { from: 'Flow Tool', fromHandle: 'tool-output', to: 'Analyzer', toHandle: 'tool-input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'test');

    // The mock LLM answers "approve" → condition routes true → HITL 1 pauses.
    // The debug overlay surfaces the pause as an approval card (prompt + the
    // custom Retry/Approve buttons) instead of completing.
    await expect(debugOverlay(page).getByText('Completed').first()).toBeVisible({ timeout: 30000 });
    await expect(debugOverlay(page).getByText(/Human-in-the-Loop/).first()).toBeVisible({ timeout: 5000 });
    await expect(debugOverlay(page).getByText('Approve?', { exact: true })).toBeVisible({ timeout: 5000 });
    // exact: the LLM step card preview ("{verdict: approve}") contains "approve"
    await expect(debugOverlay(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(debugOverlay(page).getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    // Only the FIRST HITL pauses — the second one is downstream and never reached
    await expect(debugOverlay(page).getByText('Final approval?', { exact: true })).toHaveCount(0);

    // The executed upstream steps completed: LLM agent, code and condition
    await expandStep(page, 'Analyzer');
    await expect(debugOverlay(page).getByText(/"verdict":"approve"/).first()).toBeVisible({ timeout: 5000 });
    await expandStep(page, 'Prep');
    await expect(debugOverlay(page).getByText(/"decision": "approve"/).first()).toBeVisible({ timeout: 5000 });
    await expandStep(page, 'Route');
    await expect(debugOverlay(page).getByText(/"label": "true"/).first()).toBeVisible({ timeout: 5000 });

    // The Flow Tool node is skipped as a DAG node — its card never leaves pending
    const ftCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText('Flow Tool', { exact: true }) }).first();
    await expect(ftCard).toContainText('pending');

    // NOTE: approving the paused HITL is NOT exercised here — see the
    // HITL-routing tests below for why the resume path stays API-based.
  });

  // ─── Condition false branch ─────────────────────────────────────

  test('condition routes to the FALSE branch when the condition does not match', async ({ page }, testInfo) => {
    // Mirror of the big flow's condition config, but driven by the debug
    // input (the overlay only sends {message}) so the false path is reachable:
    // a Prep code node parses the JSON message into {decision}.
    const flowId = await buildUiFlow(page, uniqueFlowName('Cond-False-Branch'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'return JSON.parse(input.message);', outputSchema: '{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"]}' } },
      { type: 'condition', label: 'Route', config: { condition: 'input.prep.decision === "approve"' } },
      { type: 'output', label: 'Approved', config: { inputFields: ['prep.decision'] }, col: 3, row: -1 },
      { type: 'output', label: 'Rejected', config: { inputFields: ['prep.decision'] }, col: 3, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Route', toHandle: 'input-0' },
      { from: 'Route', fromHandle: 'output-0', to: 'Approved', toHandle: 'input-0' },
      { from: 'Route', fromHandle: 'output-1', to: 'Rejected', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    await runFlow(page, '{"decision":"reject"}');
    await expectCompleted(page);

    // The condition evaluated to the false output label
    await expandStep(page, 'Route');
    await expect(debugOverlay(page).getByText(/"label": "false"/).first()).toBeVisible({ timeout: 5000 });

    // The false-path output node executed and carried the input
    await expandStep(page, 'Rejected');
    await expect(debugOverlay(page).getByText(/"decision": "reject"/).first()).toBeVisible({ timeout: 5000 });

    // The true-path output node never executed — the engine skips it
    const trueCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText('Approved', { exact: true }) }).first();
    await expect(trueCard).toContainText('skipped');
  });

  // ─── HITL output routing: approve → forward path ─────────────────

  // NOTE: the two HITL-routing tests below build the flows through the editor
  // UI but run them via the persisted-execution API. The debug overlay CANNOT
  // resume a paused run: for debug runs the engine throws HitlPauseError
  // without updating the execution record (only the worker runner sets
  // awaiting_approval + pending_hitls — backend/src/routes/execution.ts vs
  // worker/src/executor/runner.ts), so the overlay's Approve button posts to
  // /executions/:id/approve and gets "Not awaiting approval" (400). HITL
  // resume/approval is therefore a documented UI gap and stays API-based.

  test('hitl output routing: approve takes forward edge to subflow', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(120000);
    const subflow = await buildEnrichSubflowViaUi(page);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(subflow.id);

    // Flow: Trigger → HITL(Retry/Approve) → Subflow → Output
    // HITL output-0 = Skip → nowhere (dead end); output-1 = Process → Subflow
    const flowId = await buildUiFlow(page, uniqueFlowName('HITL-Routing'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'hitl', label: 'Gate', config: { mode: 'custom', prompt: 'Go?', buttons: [{ label: 'Skip', value: 'skip' }, { label: 'Process', value: 'process' }] } },
      { type: 'output', label: 'Direct', config: { inputFields: [] }, col: 2, row: -1 },
      { type: 'subflow', label: 'Sub', config: { subflowId: subflow.id, subflowName: subflow.name, inputMapping: { data: '{{input.Trigger.message}}', score: '{{input.Trigger.score}}' } } },
      { type: 'output', label: 'Enriched', config: { inputFields: ['Sub'] }, col: 4, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Gate', toHandle: 'input-0' },
      { from: 'Gate', fromHandle: 'output-0', to: 'Direct', toHandle: 'input-0' },
      { from: 'Gate', fromHandle: 'output-1', to: 'Sub', toHandle: 'input-0' },
      { from: 'Sub', fromHandle: 'output-0', to: 'Enriched', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');

    // Test 1: approve with 'process' → takes output-1 → subflow → output
    let { executionId } = await executeUntilPaused(flowId, { message: 'hello', score: 5 }, cookie);
    expect(executionId).toBeTruthy();

    const processRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'process' }),
    });
    expect(processRes.ok).toBe(true);

    let exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
    const outStr = typeof exec.output === 'string' ? exec.output : JSON.stringify(exec.output);
    expect(outStr).toContain('enriched');
  });

  test('hitl output routing: skip takes direct path to output', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(120000);
    const subflow = await buildEnrichSubflowViaUi(page);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(subflow.id);

    const flowId = await buildUiFlow(page, uniqueFlowName('HITL-Skip'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'hitl', label: 'Gate', config: { mode: 'custom', prompt: 'Go?', buttons: [{ label: 'Skip', value: 'skip' }, { label: 'Process', value: 'process' }] } },
      { type: 'output', label: 'Direct', config: { inputFields: [] }, col: 3, row: -1 },
      { type: 'subflow', label: 'Sub', config: { subflowId: subflow.id, subflowName: subflow.name, inputMapping: { data: '{{input.Trigger.message}}', score: '{{input.Trigger.score}}' } } },
      { type: 'output', label: 'Enriched', config: { inputFields: ['Sub'] }, col: 4, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Gate', toHandle: 'input-0' },
      // Skip → Direct output (output-0)
      { from: 'Gate', fromHandle: 'output-0', to: 'Direct', toHandle: 'input-0' },
      // Process → Subflow → Enriched output (output-1)
      { from: 'Gate', fromHandle: 'output-1', to: 'Sub', toHandle: 'input-0' },
      { from: 'Sub', fromHandle: 'output-0', to: 'Enriched', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');

    // Test: approve with 'skip' → takes output-0 → Direct output
    let { executionId } = await executeUntilPaused(flowId, { message: 'hello', score: 5 }, cookie);
    expect(executionId).toBeTruthy();

    const skipRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'skip' }),
    });
    expect(skipRes.ok).toBe(true);

    let exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
    // Direct path was taken — subflow was never reached
    const outStr = typeof exec.output === 'string' ? exec.output : JSON.stringify(exec.output);
    expect(outStr).not.toContain('enriched');
  });

  // ─── Persisted: dual HITL + subflow ──────────────────────────────

  test('persisted: dual-HITL big flow runs end-to-end to completed via API approval', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(180000);

    const subflow = await buildEnrichSubflowViaUi(page);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(subflow.id);

    // Flow: Trigger → LLM → Code → Branch → HITL1 → Subflow → HITL2 → Output.
    // Built through the editor UI; executed as a persisted run because the
    // debug overlay cannot resume HITL pauses (see note above).
    const flowId = await buildUiFlow(page, uniqueFlowName('Adv-Dual-HITL'), [
      { type: 'trigger', label: 'Trigger', col: 2, row: 0 },
      { type: 'llm-agent', label: 'Analyzer', col: 3, row: 0, config: {
        endpointId: mockEndpointId!, model: 'mock-gpt-4',
        systemPrompt: 'Analyze. MOCK_RESPONSE: {"verdict":"approve"}',
        responseFormat: 'json_object',
        outputSchema: '{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}',
      } },
      { type: 'code', label: 'Check', col: 4, row: -1, config: { code: 'const raw = input.analyzer?.content || input.l1?.content || ""; let v = ""; try { const idx = raw.indexOf("\\n"); const js = idx > 0 ? raw.substring(0, idx) : raw; v = JSON.parse(js.trim()).verdict || ""; } catch(e) {} return { decision: v, status: "ok" }' } },
      { type: 'condition', label: 'Route', col: 4, row: 1, config: { condition: 'input.check.decision === "approve"' } },
      { type: 'hitl', label: 'First Review', col: 5, row: -1, config: { prompt: 'First approval?' } },
      { type: 'subflow', label: 'Enricher', col: 5, row: 1, config: { subflowId: subflow.id, subflowName: subflow.name, inputMapping: { data: '{{input.Trigger.message}}', score: '{{input.analyzer.confidence}}' } } },
      { type: 'hitl', label: 'Second Review', col: 6, row: 1, config: { prompt: 'Final approval?' } },
      { type: 'output', label: 'Output', col: 5, row: -2, config: { inputFields: ['Check', 'Enricher'] } },
      { type: 'output', label: 'Rejected', col: 3, row: 2, config: { inputFields: ['Check'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Analyzer', toHandle: 'input-0' },
      { from: 'Analyzer', fromHandle: 'output-0', to: 'Check', toHandle: 'input-0' },
      { from: 'Check', fromHandle: 'output-0', to: 'Route', toHandle: 'input-0' },
      { from: 'Route', fromHandle: 'output-0', to: 'First Review', toHandle: 'input-0' },
      { from: 'First Review', fromHandle: 'output-0', to: 'Enricher', toHandle: 'input-0' },
      { from: 'Enricher', fromHandle: 'output-0', to: 'Second Review', toHandle: 'input-0' },
      { from: 'Second Review', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
      { from: 'Route', fromHandle: 'output-1', to: 'Rejected', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');

    const waitForStatus = async (executionId: string, status: string, timeoutMs = 30000): Promise<any> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const res = await request.get(`${API_URL}/executions/${executionId}`);
        const exec = await res.json();
        if (exec.status === status) return exec;
        await new Promise(r => setTimeout(r, 1000));
      }
      throw new Error(`Execution ${executionId} did not reach status "${status}" within ${timeoutMs}ms`);
    };

    const parsePending = (exec: any): any[] => Array.isArray(exec.pending_hitls) ? exec.pending_hitls : JSON.parse(exec.pending_hitls || '[]');

    // Pause at HITL 1 → approve → the flow must pause again at HITL 2 (strict:
    // the second HITL must NOT be auto-approved by the first approval).
    // NOTE: HITL nodes are identified by their prompts — the editor generates
    // opaque node ids, so id-based assertions are not possible.
    let { executionId } = await executeUntilPaused(flowId, { message: 'test' }, cookie);
    expect(executionId).toBeTruthy();

    const approveRes1 = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approveRes1.ok).toBe(true);

    // The first approval must leave the execution awaiting the SECOND HITL
    const execAfterFirst = await waitForStatus(executionId, 'awaiting_approval');
    const pendingAfterFirst = parsePending(execAfterFirst);
    expect(pendingAfterFirst).toHaveLength(1);
    expect(pendingAfterFirst[0]?.prompt).toBe('Final approval?');

    // Approve the second HITL → the flow completes
    const approveRes2 = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'approved', hitlNodeId: pendingAfterFirst[0]?.nodeId }),
    });
    expect(approveRes2.ok).toBe(true);

    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');

    // No HITL left pending
    const pending = parsePending(exec);
    expect(pending).toHaveLength(0);

    // The subflow executed (its steps are recorded with the subflow label prefix)
    const subflowSteps = exec.steps?.filter((s: any) => String(s.node_id || '').startsWith('enricher:'));
    expect(subflowSteps.length).toBeGreaterThan(0);
    expect(subflowSteps.every((s: any) => s.status === 'completed')).toBe(true);

    // Both HITL nodes completed with the approved decision
    const hitlSteps = exec.steps?.filter((s: any) => s.node_type === 'hitl') || [];
    expect(hitlSteps.length).toBeGreaterThan(0);
    expect(hitlSteps.some((s: any) => s.status === 'completed' && s.output?.decision === 'approved')).toBe(true);

    // Subflow enrichment data reached the final output
    const outStr = typeof exec.output === 'string' ? exec.output : JSON.stringify(exec.output);
    expect(outStr).toContain('enriched');
  });
});
