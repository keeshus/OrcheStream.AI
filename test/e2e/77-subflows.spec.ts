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
  // Self-heal: a click can land on a neighbouring node (drag drift), opening
  // the WRONG modal. The modal header shows a type badge — verify it matches
  // the expected node type, and re-open the right node otherwise.
  const expectedBadge: Record<string, string> = { trigger: 'Trigger', code: 'Code', subflow: 'Subflow', output: 'Output', 'llm-agent': 'LLM Agent', hitl: 'HITL' };
  const want = (expectedBadge[type] || type).toLowerCase();
  for (let attempt = 0; attempt < 4; attempt++) {
    const badge = await modal.locator('span.text-[10px]').first().textContent().catch(() => '');
    if ((badge || '').trim().toLowerCase() === want) break;
    await modal.getByRole('button', { name: /Close$/ }).click().catch(() => {});
    await page.waitForTimeout(300);
    // Click the node's label span (smaller target — the node centre can land
    // inside a neighbouring node's box when drags fall short)
    await nodeByLabel(page, label).getByText(label, { exact: true }).click({ force: true, timeout: 2500 }).catch(() => {});
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
  }
  switch (type) {
    case 'trigger':
      if (config.inputSchema) await fillJsonSchema(page, config.inputSchema);
      break;
    case 'code':
      if (config.code) await fillField(page, 'JavaScript Code', config.code);
      if (config.outputSchema) {
        await fillJsonSchema(page, config.outputSchema);
      }
      break;
    case 'hitl': {
      if (config.prompt) {
        await fillFieldByPlaceholder(page, 'Please review the generated content before proceeding...', config.prompt);
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

const TEXT_SCHEMA = '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}';
const NUMBER_SCHEMA = '{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}';

/** Build a child subflow (trigger schema {text} → code → output) via the UI. */
async function buildTextChildSubflowViaUi(page: any, code: string): Promise<{ id: string; name: string }> {
  const name = uniqueFlowName('Child-Flow');
  const id = await buildSubflowViaUi(page, name, [
    { type: 'trigger', label: 'Trigger', config: { inputSchema: TEXT_SCHEMA } },
    { type: 'code', label: 'Transform', config: { code } },
    { type: 'output', label: 'Output', config: { inputFields: ['Transform'] } },
  ], [
    { from: 'Trigger', fromHandle: 'output-0', to: 'Transform', toHandle: 'input-0' },
    { from: 'Transform', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
  ]);
  return { id, name };
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

test.describe('Subflows feature', () => {
  test.afterEach(async ({ request }, testInfo) => {
    const flowIds: string[] = (testInfo as any).flowIds || [];
    if ((testInfo as any).flowId) flowIds.push((testInfo as any).flowId);
    for (const id of flowIds) {
      await deleteFlow(request, id).catch(() => {});
    }
    await purgeDraftFlows(request);
  });

  // ─── Catalog ───────────────────────────────────────────────

  test('subflow node appears in node catalog', async ({ page }) => {
    await page.goto('/flows/new/edit');
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('add-node-btn').click();
    await expect(page.getByTestId('catalog-subflow')).toBeVisible({ timeout: 5000 });
  });

  // ─── Subflow node configuration ──────────────────────────

  test('subflow node can be added to canvas and configured', async ({ page }, testInfo) => {
    testInfo.setTimeout(120000);
    // The child subflow is created through the UI (Subflows tab → New Subflow)
    const child = await buildTextChildSubflowViaUi(page, 'return { result: (input.text || "").toUpperCase() }');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(child.id);

    const flowId = await buildUiFlow(page, uniqueFlowName('Parent-Flow'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'Subflow', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.message}}' } } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Subflow', toHandle: 'input-0' },
      { from: 'Subflow', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The configured subflow is shown on the node and in the config panel
    await openConfig(page, 'Subflow');
    await expect(page.getByTestId('subflow-config')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId(`subflow-item-${child.name.replace(/\s+/g, '-')}`)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(child.name).first()).toBeVisible({ timeout: 3000 });
  });

  // ─── Subflow execution ────────────────────────────────────

  test('subflow node executes child flow and returns result', async ({ page }, testInfo) => {
    testInfo.setTimeout(120000);
    const child = await buildTextChildSubflowViaUi(page, 'return { result: (input.text || "").toUpperCase() }');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(child.id);

    const flowId = await buildUiFlow(page, uniqueFlowName('Exec-Parent'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'Subflow', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.message}}' } } },
      { type: 'output', label: 'Output', config: { inputFields: ['Subflow'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Subflow', toHandle: 'input-0' },
      { from: 'Subflow', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'hello world');
    await expectCompleted(page);
    // The child ran as a sub-routine; its final output surfaces in the parent
    await expectFinalOutput(page, /HELLO WORLD/);
  });

  test('subflow with number transformation works', async ({ page }, testInfo) => {
    testInfo.setTimeout(120000);
    const childName = uniqueFlowName('Double-Subflow');
    const childId = await buildSubflowViaUi(page, childName, [
      { type: 'trigger', label: 'Trigger', config: { inputSchema: NUMBER_SCHEMA } },
      { type: 'code', label: 'Double', config: { code: 'return { result: (input.x || 0) * 2 }' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Double'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Double', toHandle: 'input-0' },
      { from: 'Double', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(childId);

    const flowId = await buildUiFlow(page, uniqueFlowName('Double-Parent'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'Calc', config: { subflowId: childId, subflowName: childName, inputMapping: { x: '{{input.Trigger.message}}' } } },
      { type: 'output', label: 'Output', config: { inputFields: ['Calc'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Calc', toHandle: 'input-0' },
      { from: 'Calc', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The debug overlay sends the message as a string; the child doubles it
    // ("21" * 2 → 42) and returns it through the parent's output node.
    await runFlow(page, '21');
    await expectCompleted(page);
    await expectFinalOutput(page, /42/);
  });

  // ─── Error handling ──────────────────────────────────────

  // NOTE: the invalid-subflowId test stays API-based — the subflow config
  // form only lists real subflows in its picker, so an unreachable
  // subflowId (e.g. 00000000-...) cannot be created through the editor UI.
  // The engine's "subflow not found" behavior for a stale id is a
  // UI-impossible configuration, so it is pinned via the API only.
  test('subflow with invalid subflowId fails gracefully', async ({ request }, testInfo) => {
    const res = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Bad-Subflow'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Broken', type: 'subflow', config: { subflowId: '00000000-0000-0000-0000-000000000000', inputMapping: {} } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(res.ok()).toBe(true);
    const parent = await res.json();
    (testInfo as any).flowId = parent.id;

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;

    const events = await readSSE(
      `${API_URL}/flows/${parent.id}/execute`,
      { input: { _debug: true } },
      adminCookie,
    );

    const failedEvent = events.find(e => e.type === 'execution.failed');
    expect(failedEvent).toBeDefined();
    const errorMsg = failedEvent?.data?.error || '';
    expect(errorMsg).toContain('not found');
  });

  // ─── Nested subflows (depth 2) ────────────────────────────

  test('nested subflow: parent → subflow A → subflow B (depth 2) completes with child output', async ({ page }, testInfo) => {
    testInfo.setTimeout(180000);

    // Level 2: flow B transforms text (UI-built via the Subflows tab)
    const flowB = await buildTextChildSubflowViaUi(page, 'return { result: "B:" + (input.text || "") }');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(flowB.id);

    // Level 1: flow A calls flow B, then wraps the result
    const flowAName = uniqueFlowName('Nested-A');
    const flowAId = await buildSubflowViaUi(page, flowAName, [
      { type: 'trigger', label: 'Trigger', config: { inputSchema: TEXT_SCHEMA } },
      { type: 'subflow', label: 'SubB', config: { subflowId: flowB.id, subflowName: flowB.name, inputMapping: { text: '{{input.Trigger.text}}' } } },
      { type: 'code', label: 'A-Code', config: { code: 'return { result: "A:" + JSON.stringify(input.subb) }' } },
      { type: 'output', label: 'A-Out', config: { inputFields: ['A-Code'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'SubB', toHandle: 'input-0' },
      { from: 'SubB', fromHandle: 'output-0', to: 'A-Code', toHandle: 'input-0' },
      { from: 'A-Code', fromHandle: 'output-0', to: 'A-Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds.push(flowAId);

    // Level 0: parent calls flow A
    const flowId = await buildUiFlow(page, uniqueFlowName('Nested-Parent'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'SubA', config: { subflowId: flowAId, subflowName: flowAName, inputMapping: { text: '{{input.Trigger.message}}' } } },
      { type: 'output', label: 'P-Out', config: { inputFields: ['SubA'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'SubA', toHandle: 'input-0' },
      { from: 'SubA', fromHandle: 'output-0', to: 'P-Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'hello');
    await expectCompleted(page);

    // Both child flows surfaced as their own step cards in the overlay
    // (subflowLabel = the child flow name)
    const aCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText(flowAName, { exact: true }) }).first();
    await expect(aCard).toContainText('completed', { timeout: 5000 });
    const bCard = debugOverlay(page).getByRole('button').filter({ has: page.getByText(flowB.name, { exact: true }) }).first();
    await expect(bCard).toContainText('completed', { timeout: 5000 });

    // Flow B's result is threaded back through A into the parent output.
    // NOTE: the depth counter (1/2) of each subflow execution is only visible
    // in the SSE events, not the overlay — the depth assertions from the old
    // API test are not expressible through the UI and are dropped.
    await expectFinalOutput(page, /B:hello/);
    await expectFinalOutput(page, /A:/);
  });

  // ─── Recursion guard ─────────────────────────────────────

  test('self-referencing subflow fails with clear circular-reference error', async ({ page }, testInfo) => {
    testInfo.setTimeout(120000);
    // A subflow that selects ITSELF in the subflow picker. The picker lists
    // every subflow (including the flow being edited), so this is fully
    // UI-expressible: build the flow, open the subflow node config and click
    // its own entry, then save and run.
    const name = uniqueFlowName('Self-Ref');
    const flowId = await buildSubflowViaUi(page, name, [
      { type: 'trigger', label: 'Trigger', config: { inputSchema: TEXT_SCHEMA } },
      { type: 'subflow', label: 'Self', config: {} },
      { type: 'output', label: 'Out', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Self', toHandle: 'input-0' },
      { from: 'Self', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // Select the flow itself in the subflow picker
    await openConfig(page, 'Self');
    await expect(page.getByTestId('subflow-config')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`subflow-item-${name.replace(/\s+/g, '-')}`).click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 3000 });
    await closeConfig(page);
    await saveFlow(page);

    // The runtime detects the cycle instead of recursing infinitely. NOTE: the
    // debug overlay renders no message input for subflow-triggered flows
    // (only manual/schedule show one), so the run is started without input.
    await runFlow(page);
    await expectFailed(page, /Circular subflow reference/);
  });

  // ─── HITL inside a subflow ───────────────────────────────

  // NOTE: this test builds both flows through the editor UI but executes them
  // as persisted runs via the API. The debug overlay cannot resume a paused
  // HITL: debug runs never leave the awaiting_approval state (only the worker
  // runner persists pending_hitls), so the overlay's Approve button gets
  // "Not awaiting approval" (400). HITL approval/resume is a documented UI
  // gap and stays API-based.
  test('subflow with HITL node: approval resumes inside the child and the parent completes', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(180000);

    const childName = uniqueFlowName('Hitl-Child');
    const childId = await buildSubflowViaUi(page, childName, [
      { type: 'trigger', label: 'Trigger', config: { inputSchema: TEXT_SCHEMA } },
      { type: 'code', label: 'Transform', config: { code: 'return { result: "child:" + (input.text || "") }' } },
      { type: 'hitl', label: 'Review', config: { prompt: 'Approve child step?' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Transform'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Transform', toHandle: 'input-0' },
      { from: 'Transform', fromHandle: 'output-0', to: 'Review', toHandle: 'input-0' },
      { from: 'Review', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(childId);

    const parentId = await buildUiFlow(page, uniqueFlowName('Hitl-Parent'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'Sub', config: { subflowId: childId, subflowName: childName, inputMapping: { text: '{{input.Trigger.text}}' } } },
      { type: 'output', label: 'Out', config: { inputFields: ['Sub'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Sub', toHandle: 'input-0' },
      { from: 'Sub', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = parentId;

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(parentId, { text: 'x' }, adminCookie);
    expect(executionId).toBeTruthy();

    // The pause is caused by the child's HITL node — its prompt is surfaced as pending
    const execRes = await request.get(`${API_URL}/executions/${executionId}`);
    expect(execRes.ok()).toBe(true);
    const exec = await execRes.json();
    expect(exec.status).toBe('awaiting_approval');
    const pending = Array.isArray(exec.pending_hitls) ? exec.pending_hitls : JSON.parse(exec.pending_hitls || '[]');
    expect(pending[0]?.prompt).toBe('Approve child step?');
    // The pending HITL is stored with its hierarchical node id (subflow label
    // prefix : child node id) so the replay can resume INSIDE the child
    // subflow. The node id itself is editor-generated, so only the prefix is
    // asserted ('Sub' label → 'sub:').
    expect(String(pending[0]?.nodeId || '')).toMatch(/^sub:/);

    // The child flow ran as a sub-execution of the parent
    const subExecs = await (await request.get(`${API_URL}/executions?parent_execution_id=${executionId}`)).json().catch(() => []);
    const subExec = Array.isArray(subExecs) ? subExecs[0] : undefined;
    expect(subExec?.id).toBeTruthy();
    const subId = subExec.id;

    // Approve → the replay must resume inside the child, complete it, and finish the parent
    const approveRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ decision: 'approved', hitlNodeId: pending[0]?.nodeId }),
    });
    expect(approveRes.ok).toBe(true);

    const completedExec = await pollExecution(request, executionId, 30000);
    expect(completedExec.status).toBe('completed');

    // The child's output is in the parent result
    const outStr = typeof completedExec.output === 'string' ? completedExec.output : JSON.stringify(completedExec.output);
    expect(outStr).toContain('child:x');

    // The replayed child sub-execution completed with the HITL approved
    const childListRes = await request.get(`${API_URL}/flows/${childId}/executions`);
    expect(childListRes.ok()).toBe(true);
    const childList = await childListRes.json();
    const completedSub = (childList.data || []).find((e: any) => e.id !== subId && e.status === 'completed');
    expect(completedSub).toBeDefined();
    expect(completedSub.parent_execution_id).toBe(executionId);
    expect(JSON.stringify(completedSub.output)).toContain('child:x');

    // No HITL left pending
    const pendingAfter = Array.isArray(completedExec.pending_hitls) ? completedExec.pending_hitls : JSON.parse(completedExec.pending_hitls || '[]');
    expect(pendingAfter).toHaveLength(0);
  });

  // ─── Input mapping edge cases ────────────────────────────

  test('subflow input mapping referencing a missing upstream field resolves gracefully', async ({ page }, testInfo) => {
    testInfo.setTimeout(120000);
    const child = await buildTextChildSubflowViaUi(page, 'return { result: "text=[" + input.text + "]" }');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(child.id);

    const flowId = await buildUiFlow(page, uniqueFlowName('Missing-Field-Parent'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'Sub', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.nonexistent}}' } } },
      { type: 'output', label: 'Out', config: { inputFields: ['Sub'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Sub', toHandle: 'input-0' },
      { from: 'Sub', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // Unresolved templates resolve to empty string — no error, child still runs
    await runFlow(page, 'hello');
    await expectCompleted(page);
    await expectFinalOutput(page, /text=\[\]/);
  });

  // ─── Persisted (non-debug) subflow execution ─────────────

  // NOTE: persisted-run execution records are a documented UI gap — the debug
  // overlay runs in-memory and never creates child execution records, so the
  // parent_execution_id wiring below is only observable via the API.
  test('persisted subflow execution: child flow runs as its own execution record and result is returned', async ({ page, request }, testInfo) => {
    testInfo.setTimeout(120000);
    const child = await buildTextChildSubflowViaUi(page, 'return { result: "persisted:" + (input.text || "") }');
    (testInfo as any).flowIds = (testInfo as any).flowIds || [];
    (testInfo as any).flowIds.push(child.id);

    const parentId = await buildUiFlow(page, uniqueFlowName('Persist-Parent'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'subflow', label: 'Sub', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.text}}' } } },
      { type: 'output', label: 'Out', config: { inputFields: ['Sub'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Sub', toHandle: 'input-0' },
      { from: 'Sub', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = parentId;

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;
    const { executePersisted, pollExecution } = await import('./helpers/stream');
    const { executionId: parentExecutionId } = await executePersisted(parentId, { text: 'zz' }, adminCookie);
    expect(parentExecutionId).toBeTruthy();

    const parentExec = await pollExecution(request, parentExecutionId, 30000);
    expect(parentExec.status).toBe('completed');
    const outputStr = JSON.stringify(parentExec.output || {});
    expect(outputStr).toContain('persisted:zz');

    // The child flow was persisted as its own execution record
    const subRes = await request.get(`${API_URL}/executions?parent_execution_id=${parentExecutionId}`);
    expect(subRes.ok()).toBe(true);
    const subExecs = await subRes.json();
    const subList = Array.isArray(subExecs) ? subExecs : (subExecs.data || []);
    const sub = subList.find((e: any) => e.status === 'completed') || subList[0];
    expect(sub?.id).toBeTruthy();
    expect(sub.id).not.toBe(parentExecutionId);
    expect(sub.flow_id).toBe(child.id);
    expect(sub.status).toBe('completed');
    expect(JSON.stringify(sub.output)).toContain('persisted:zz');
  });
});

// NOTE: the SSE reader is only used for the invalid-subflowId test, which
// stays API-based because the UI cannot express an unreachable subflow id.
async function readSSE(url: string, body: unknown, cookie: string): Promise<any[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Execute failed: ${res.status} ${res.statusText}`);
  const events: any[] = [];
  const reader = res.body?.getReader();
  if (!reader) return events;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch {}
      }
    }
    if (events.some(e => e.type === 'execution.completed' || e.type === 'execution.failed' || e.type === 'execution.paused')) break;
  }
  reader.releaseLock();
  return events;
}
