import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import {
  createFlowViaUi, addNode, clickNode, configureNode, closeConfig, fillField,
  fillFieldByPlaceholder, fillJsonSchema, selectOption, selectNativeOption,
  connect, moveNodeToSlot, saveFlow, runFlow, debugOverlay, expandStep,
  expectCompleted, expectFailed, expectFinalOutput,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

// The mock CyberArk container is only reachable from the worker via its
// internal hostname; the auth endpoint (which mints tokens) is also exposed
// on the host at backendPort + 4 (see test/run-e2e-parallel.sh port table).
const MOCK_CYBERARK_INTERNAL = 'http://mock-cyberark-e2e:3005';
const CYBERARK_LOGIN = 'host%2Fmyapp';
const CYBERARK_API_KEY = 'myapp-api-key-456';

/** Mint a valid CyberArk token via the mock's auth endpoint. */
async function mintCyberArkToken(): Promise<string> {
  const backendUrl = new URL(API_URL);
  const cyberarkBase = `http://localhost:${Number(backendUrl.port) + 4}`;
  const res = await fetch(`${cyberarkBase}/api/authn/dev/${CYBERARK_LOGIN}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: CYBERARK_API_KEY,
  });
  if (!res.ok) throw new Error(`CyberArk token mint failed: ${res.status}`);
  return (await res.text()).trim();
}

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
    case 'trigger':
      if (config.inputSchema) await fillField(page, 'Input Schema', config.inputSchema);
      break;
    case 'code':
      if (config.code) await fillField(page, 'JavaScript Code', config.code);
      if (config.outputSchema) {
        await fillJsonSchema(page, config.outputSchema);
      }
      break;
    case 'condition':
      if (config.condition) await fillFieldByPlaceholder(page, 'input.score > 0.5', config.condition);
      break;
    case 'switch': {
      if (config.fieldPath) await selectNativeOption(page, config.fieldPath);
      const cases = config.cases || [];
      for (let i = 0; i < cases.length; i++) {
        await modal.getByRole('button', { name: '+ Add case' }).click();
        await modal.getByPlaceholder('Value to match').nth(i).fill(String(cases[i].value));
      }
      if (config.defaultPath) {
        await fillFieldByPlaceholder(page, 'Label for unmatched values', config.defaultPath);
      }
      break;
    }
    case 'map': {
      const fields = config.fields || [];
      for (let i = 0; i < fields.length; i++) {
        await modal.getByRole('button', { name: '+ Add field' }).click();
        await modal.getByPlaceholder('Field name').nth(i).fill(fields[i].name);
        await modal.getByPlaceholder('Upstream field path (e.g., trigger.message)').nth(i).fill(fields[i].value);
      }
      if (config.mode === 'merge') {
        await selectOption(page, 'Mode', 'Merge — add mapped fields to upstream data');
      } else if (config.mode === 'replace') {
        await selectOption(page, 'Mode', 'Replace — output only mapped fields');
      }
      break;
    }
    case 'http': {
      if (config.method && config.method !== 'GET') {
        await selectOption(page, 'Method', config.method);
      }
      if (config.url) await fillField(page, 'URL', config.url);
      if (config.headers) {
        await fillFieldByPlaceholder(page, '{"Authorization": "Bearer {{input.token}}"}', config.headers);
      }
      if (config.body) {
        await fillFieldByPlaceholder(page, '{"message": "{{input.trigger.message}}"}', config.body);
      }
      if (config.allowPrivate === true) {
        await modal.locator('div.flex.items-center.gap-2').filter({ hasText: 'Allow private/internal addresses (SSRF risk)' }).locator('input[type="checkbox"]').check();
      }
      break;
    }
    case 'delay': {
      if (config.type === 'fixed') {
        await selectOption(page, 'Delay Type', 'Fixed seconds');
        if (config.seconds !== undefined) await page.getByLabel('Seconds', { exact: true }).fill(String(config.seconds));
      } else if (config.type === 'duration') {
        await selectOption(page, 'Delay Type', 'ISO 8601 Duration');
        if (config.duration) await fillFieldByPlaceholder(page, 'PT30S, PT5M, PT1H', config.duration);
      } else if (config.type === 'timestamp') {
        await selectOption(page, 'Delay Type', 'Specific timestamp');
        if (config.timestamp) await fillFieldByPlaceholder(page, '2026-07-09T12:00:00Z or {{input.Var.field}}', config.timestamp);
      }
      break;
    }
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
    case 'ai-action': {
      if (config.endpointId) {
        await selectOption(page, 'LLM Endpoint', /E2E Mock LLM/);
      }
      if (config.model) {
        await selectOption(page, 'Model', config.model);
      }
      if (config.prompt !== undefined) {
        await fillFieldByPlaceholder(page, 'E.g. Summarize: {{input.Trigger.message}}', config.prompt);
      }
      break;
    }
    case 'note':
      if (config.content) await fillField(page, 'Content', config.content);
      break;
    case 'output': {
      for (const field of config.inputFields || []) {
        // Check the field checkbox (e.g. "result" under the upstream node).
        // The checkbox label renders as "{name}: {type}".
        const fieldName = field.split('.').pop();
        await modal.locator('label').filter({ hasText: fieldName! }).locator('input[type="checkbox"]').check();
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

/** Build a flow through the editor UI: nodes, layout, edges, configs, save. */
async function buildUiFlow(page: any, request: any, name: string, nodes: UiNode[], edges: UiEdge[]): Promise<string> {
  const flowId = await createFlowViaUi(page, name);
  // Pass 1: add/rename/move all nodes. New nodes land at the canvas centre
  // with jitter (which can overlap a neighbouring slot), so each node is
  // moved to its slot immediately after being added — before any click.
  // The grid is shifted so no slot sits at the canvas centre itself.
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
  // Pass 2: for each node in order, connect its incoming edges first, then
  // apply its config. Incoming edges must exist before config (field selects
  // and output-field checkboxes derive from upstreams) and config must run
  // before the node's outgoing edges (switch output handles appear only after
  // cases are set).
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
  return flowId;
}

test.describe('All node types', () => {
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
    const flowId = (testInfo as any).flowId;
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  // ── Trigger → Code ───────────────────────────────────────────

  test('code node transforms input', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('CodeTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Transform', config: { code: 'return { result: input.message.toUpperCase() };', outputSchema: '{"type":"object","properties":{"result":{"type":"string"}},"required":["result"]}' } },
      { type: 'output', label: 'Output', config: { inputFields: ['transform.result'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Transform', toHandle: 'input-0' },
      { from: 'Transform', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'hello world');
    await expectCompleted(page);
    await expandStep(page, 'Transform');
    await expect(debugOverlay(page).getByText(/"result": "HELLO WORLD"/).first()).toBeVisible({ timeout: 5000 });
  });

  // ── Branch (condition) ───────────────────────────────────────

  test('branch node routes based on condition', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('BranchTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'condition', label: 'Check', config: { condition: 'input.message === "yes"' } },
      { type: 'output', label: 'TruePath', config: { inputFields: ['check.verdict'] }, col: 2, row: -1 },
      { type: 'output', label: 'FalsePath', config: { inputFields: ['check.verdict'] }, col: 2, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Check', toHandle: 'input-0' },
      { from: 'Check', fromHandle: 'output-0', to: 'TruePath', toHandle: 'input-0' },
      { from: 'Check', fromHandle: 'output-1', to: 'FalsePath', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'yes');
    await expectCompleted(page);
    await expandStep(page, 'Check');
    await expect(debugOverlay(page).getByText(/"verdict": true/).first()).toBeVisible({ timeout: 5000 });
    await expect(debugOverlay(page).getByText(/"label": "true"/).first()).toBeVisible();
  });

  test('condition false label routes correctly', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('CondFalseTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'condition', label: 'Check', config: { condition: 'input.message === "no"' } },
      { type: 'output', label: 'TruePath', config: { inputFields: ['check.verdict'] }, col: 2, row: -1 },
      { type: 'output', label: 'FalsePath', config: { inputFields: ['check.verdict'] }, col: 2, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Check', toHandle: 'input-0' },
      { from: 'Check', fromHandle: 'output-0', to: 'TruePath', toHandle: 'input-0' },
      { from: 'Check', fromHandle: 'output-1', to: 'FalsePath', toHandle: 'input-0' },
    ]);

    // "no" → verdict true (condition "===" no" is true), routes handle-0
    await runFlow(page, 'no');
    await expectCompleted(page);
    await expandStep(page, 'Check');
    await expect(debugOverlay(page).getByText(/"label": "true"/).first()).toBeVisible({ timeout: 5000 });

    // "yes" → verdict false, routes handle-1
    await runFlow(page, 'yes');
    await expectCompleted(page);
    await expandStep(page, 'Check');
    await expect(debugOverlay(page).getByText(/"label": "false"/).first()).toBeVisible({ timeout: 5000 });
  });

  // ── Switch ───────────────────────────────────────────────────

  test('switch node routes to matching case', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('SwitchMatchTest'), [
      { type: 'trigger', label: 'Trigger' },
      // The debug overlay only passes {message}; parse structured JSON via a code node.
      { type: 'code', label: 'Prep', config: { code: 'return JSON.parse(input.message);', outputSchema: '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"]}' } },
      { type: 'switch', label: 'Router', config: { fieldPath: 'prep.status', cases: [{ value: 'active' }, { value: 'inactive' }] } },
      { type: 'output', label: 'Active', config: { inputFields: ['Router'] }, col: 3, row: -1 },
      { type: 'output', label: 'Inactive', config: { inputFields: ['Router'] }, col: 3, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Router', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-0', to: 'Active', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-1', to: 'Inactive', toHandle: 'input-0' },
    ]);

    await runFlow(page, '{"status":"active"}');
    await expectCompleted(page);
    await expandStep(page, 'Router');
    await expect(debugOverlay(page).getByText(/"caseIndex": 0/).first()).toBeVisible({ timeout: 5000 });
    await expect(debugOverlay(page).getByText(/"caseValue": "active"/).first()).toBeVisible();
    await expectFinalOutput(page, /"caseValue": "active"/);
  });

  test('switch node routes to default path when no case matches', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('SwitchDefaultTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'return JSON.parse(input.message);', outputSchema: '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"]}' } },
      { type: 'switch', label: 'Router', config: { fieldPath: 'prep.status', cases: [{ value: 'active' }], defaultPath: 'other' } },
      { type: 'output', label: 'Active', config: { inputFields: ['Router'] }, col: 3, row: -1 },
      { type: 'output', label: 'Default', config: { inputFields: ['Router'] }, col: 3, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Router', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-0', to: 'Active', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-1', to: 'Default', toHandle: 'input-0' },
    ]);

    await runFlow(page, '{"status":"unknown"}');
    await expectCompleted(page);
    await expandStep(page, 'Router');
    await expect(debugOverlay(page).getByText(/"caseIndex": 1/).first()).toBeVisible({ timeout: 5000 });
    await expect(debugOverlay(page).getByText(/"caseValue": "other"/).first()).toBeVisible();
  });

  test('switch node fails when no match and no default path', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('SwitchFailTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'return JSON.parse(input.message);', outputSchema: '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"]}' } },
      { type: 'switch', label: 'Router', config: { fieldPath: 'prep.status', cases: [{ value: 'active' }] } },
      { type: 'output', label: 'Output', config: { inputFields: ['Router'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Router', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, '{"status":"unknown"}');
    await expectFailed(page, /does not match any case/);
  });

  test('switch node works with code node upstream', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('SwitchCodeTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'const d = JSON.parse(input.message); const level = d.score > 50 ? "high" : "low"; return { level, raw: d.score };', outputSchema: '{"type":"object","properties":{"level":{"type":"string"},"raw":{"type":"number"}},"required":["level","raw"]}' } },
      { type: 'switch', label: 'Router', config: { fieldPath: 'prep.level', cases: [{ value: 'high' }, { value: 'low' }] } },
      { type: 'output', label: 'High', config: { inputFields: ['Router', 'prep.raw'] }, col: 3, row: -1 },
      { type: 'output', label: 'Low', config: { inputFields: ['Router', 'prep.raw'] }, col: 3, row: 1 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Router', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-0', to: 'High', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-1', to: 'Low', toHandle: 'input-0' },
    ]);

    await runFlow(page, '{"score":75}');
    await expectCompleted(page);
    await expandStep(page, 'Router');
    await expect(debugOverlay(page).getByText(/"caseValue": "high"/).first()).toBeVisible({ timeout: 5000 });
  });

  test('switch node matches numeric field values via string coercion', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('SwitchNumericTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'return JSON.parse(input.message);', outputSchema: '{"type":"object","properties":{"quantity":{"type":"number"}},"required":["quantity"]}' } },
      { type: 'switch', label: 'Router', config: { fieldPath: 'prep.quantity', cases: [{ value: '42' }, { value: '7' }] } },
      { type: 'output', label: 'Output', config: { inputFields: ['Router'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Router', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    // 42 arrives as a number; the switch stringifies it (String(42) === "42")
    // and matches the string case value — real coercion behavior.
    await runFlow(page, '{"quantity":42}');
    await expectCompleted(page);
    await expandStep(page, 'Router');
    await expect(debugOverlay(page).getByText(/"caseIndex": 0/).first()).toBeVisible({ timeout: 5000 });
    await expect(debugOverlay(page).getByText(/"caseValue": "42"/).first()).toBeVisible();
  });

  // NOTE: the old API test "switch does not match numeric case values" pinned
  // engine strict-equality behavior that cannot be expressed through the UI:
  // the switch config form only accepts string case values (text inputs), so
  // numeric case values are impossible to create in the editor. The string
  // coercion behavior IS covered by the "numeric field values via string
  // coercion" test above.

  test('switch node fails when fieldPath is empty', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('SwitchNoFieldTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'return JSON.parse(input.message);', outputSchema: '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"]}' } },
      { type: 'switch', label: 'Router', config: { cases: [{ value: 'active' }] } },
      { type: 'output', label: 'Output', config: { inputFields: ['Router'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Router', toHandle: 'input-0' },
      { from: 'Router', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, '{"status":"active"}');
    await expectFailed(page, /no fieldPath configured/);
  });

  // ── LLM Agent ────────────────────────────────────────────────

  test('llm agent returns mock text response', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('LLMTextTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: { endpointId: mockEndpointId!, model: 'mock-gpt-4', systemPrompt: 'You are helpful. MOCK_RESPONSE: "Hello from mock LLM!"', responseFormat: 'text' } },
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'test');
    await expectCompleted(page);
    await expectFinalOutput(page, /Hello from mock LLM/);
  });

  test('llm agent returns structured json output', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('LLMJsonTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: {
        endpointId: mockEndpointId!, model: 'mock-gpt-4',
        systemPrompt: 'You extract data. MOCK_RESPONSE: {"name":"E2E","score":95}',
        responseFormat: 'json_object',
        outputSchema: '{"type":"object","properties":{"name":{"type":"string"},"score":{"type":"number"}},"required":["name","score"]}',
      } },
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'extract data');
    await expectCompleted(page);
    await expectFinalOutput(page, /"E2E"/);
  });

  // ── Parallel (UI supports LLM Agent children only) ───────────

  test('parallel node runs sub-nodes concurrently', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    const flowId = await createFlowViaUi(page, uniqueFlowName('ParallelTest'));
    (testInfo as any).flowId = flowId;
    // Build manually: parallel container first, then drop LLM agents into it.
    await configureNode(page, 'Trigger', 'Trigger');
    await closeConfig(page);
    await addNode(page, 'parallel');
    await configureNode(page, 'parallel1', 'Parallel Agents');
    await closeConfig(page);
    await moveNodeToSlot(page, 'Trigger', -1, 0);
    await moveNodeToSlot(page, 'Parallel Agents', 0, 0);

    for (const [sub, prompt] of [['SubA', 'MOCK_RESPONSE: "A"'], ['SubB', 'MOCK_RESPONSE: "B"']] as const) {
      // The container sits at the canvas centre where new nodes land; after
      // the first agent is dropped inside, move the container away so the
      // next agent lands on empty canvas (no overlap with the child).
      if (sub === 'SubB') {
        await clickNode(page, 'Trigger');
        await closeConfig(page);
        // Drag the container by its top edge — its centre is covered by the
        // dropped child, which would otherwise grab the drag.
        const container = page.locator('.react-flow__node').filter({ hasText: 'Parallel Agents' }).first();
        const cbox = await container.boundingBox();
        if (!cbox) throw new Error('Cannot bound parallel container');
        await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + 15);
        await page.mouse.down();
        await page.mouse.move(cbox.x + cbox.width / 2 + 560, cbox.y + 15, { steps: 12 });
        await page.mouse.up();
      }
      // Deselect the container (drag/configure leaves it selected, which
      // would intercept the newly added agent) by selecting the trigger.
      await clickNode(page, 'Trigger');
      await closeConfig(page);
      const autoLabel = await addNode(page, 'llm-agent');
      await configureNode(page, autoLabel, sub);
      await applyConfig(page, 'llm-agent', sub, { endpointId: mockEndpointId!, model: 'mock-gpt-4', systemPrompt: `You are ${sub}. ${prompt}`, responseFormat: 'text' });
      await closeConfig(page);
      // Drop the node into the Parallel Agents container
      const parallelBox = await page.locator('.react-flow__node').filter({ hasText: 'Parallel Agents' }).boundingBox();
      const subBox = await page.locator('.react-flow__node').filter({ hasText: sub }).boundingBox();
      if (!parallelBox || !subBox) throw new Error('Cannot bound parallel/sub node');
      await page.mouse.move(subBox.x + subBox.width / 2, subBox.y + subBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(parallelBox.x + parallelBox.width / 2, parallelBox.y + parallelBox.height / 2, { steps: 12 });
      await page.mouse.up();
    }

    await addNode(page, 'output');
    await configureNode(page, 'output1', 'Output');
    await closeConfig(page);
    await moveNodeToSlot(page, 'Output', 3, 0);
    await connect(page, 'Parallel Agents', 'output-0', 'Output', 'input-0');
    await connect(page, 'Trigger', 'output-0', 'Parallel Agents', 'input-0');
    await saveFlow(page);

    await runFlow(page, 'hello');
    await expectCompleted(page, 30000);
    // Sub-agents render as their own step cards inside the parallel group
    await expandStep(page, 'SubA');
    await expect(debugOverlay(page).getByText(/A"/).first()).toBeVisible({ timeout: 5000 });
    await expandStep(page, 'SubB');
    await expect(debugOverlay(page).getByText(/B"/).first()).toBeVisible({ timeout: 5000 });
  });

  // NOTE: the concurrency-overlap test (busy-wait code sub-nodes with in-band
  // start timestamps) stays API-based: the UI only allows LLM Agent children
  // inside Parallel containers, and code children are the only way to observe
  // overlapping execution timing in-band.

  // ── Map ──────────────────────────────────────────────────────

  test('map node transforms fields', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('MapTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'map', label: 'Mapper', config: { fields: [{ name: 'greeting', value: 'trigger.message' }], mode: 'replace' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Mapper'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Mapper', toHandle: 'input-0' },
      { from: 'Mapper', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'world');
    await expectCompleted(page);
    await expectFinalOutput(page, /"greeting": "world"/);
  });

  test('map node merge mode preserves upstream fields', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('MapMergeTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'code', label: 'Prep', config: { code: 'return { score: 42 };' } },
      { type: 'map', label: 'Mapper', config: { fields: [{ name: 'label', value: 'trigger.message' }], mode: 'merge' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Prep', toHandle: 'input-0' },
      { from: 'Prep', fromHandle: 'output-0', to: 'Mapper', toHandle: 'input-0' },
      { from: 'Mapper', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'hello');
    await expectCompleted(page);
    await expandStep(page, 'Mapper');
    await expect(debugOverlay(page).getByText(/"label": "hello"/).first()).toBeVisible({ timeout: 5000 });
  });

  // ── Loop (children) ──────────────────────────────────────────
  // NOTE: loop iteration tests with sub-nodes stay API-based — the editor UI
  // has no way to add children to a Loop node (no drop-into-container
  // handler and no sub-node editor in the config modal). Surfacing that gap
  // is part of the refactor goal.

  // ── HTTP ─────────────────────────────────────────────────────

  test('http node fetches from an endpoint', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('HttpTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'http', label: 'Fetcher', config: { method: 'GET', url: 'http://backend-e2e:3001/api/health', allowPrivate: true } },
      { type: 'output', label: 'Output', config: { inputFields: ['Fetcher'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Fetcher', toHandle: 'input-0' },
      { from: 'Fetcher', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page);
    await expandStep(page, 'Fetcher');
    await expect(debugOverlay(page).getByText(/"status": 200/).first()).toBeVisible({ timeout: 10000 });
  });

  test('http node POST with JSON body', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('HttpPostTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'http', label: 'H', config: {
        method: 'POST', url: 'http://mock-llm-e2e:3002/v1/chat/completions',
        body: '{"model":"mock","messages":[{"role":"user","content":"hi"}]}',
        headers: '{"Content-Type":"application/json"}',
        allowPrivate: true,
      } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'H', toHandle: 'input-0' },
      { from: 'H', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page);
    await expandStep(page, 'H');
    await expect(debugOverlay(page).getByText(/"status": 200/).first()).toBeVisible({ timeout: 10000 });
  });

  test('http node blocks private addresses without allowPrivate (SSRF guard)', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('HttpSsfrTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'http', label: 'H', config: { method: 'GET', url: 'http://backend-e2e:3001/api/health', allowPrivate: false } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'H', toHandle: 'input-0' },
      { from: 'H', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectFailed(page, /resolves to a private or restricted address — blocked/);
  });

  test('http node returns error for unreachable host', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('HttpErrTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'http', label: 'H', config: { method: 'GET', url: 'http://nonexistent.invalid/' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'H', toHandle: 'input-0' },
      { from: 'H', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectFailed(page);
  });

  test('http node expands upstream field templates in request headers', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('HttpHeaderUpstreamTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'http', label: 'Token', config: {
        method: 'POST', url: `${MOCK_CYBERARK_INTERNAL}/api/authn/dev/${CYBERARK_LOGIN}/authenticate`,
        headers: '{"Content-Type":"text/plain"}', body: CYBERARK_API_KEY, allowPrivate: true,
      } },
      { type: 'http', label: 'Fetch', config: {
        method: 'GET', url: `${MOCK_CYBERARK_INTERNAL}/api/secrets/dev/variable/prod%2Fdb%2Fpassword`,
        headers: '{"Authorization":"Token token=\\"{{input.Token.body}}\\""}', allowPrivate: true,
      } },
      { type: 'output', label: 'Output', config: { inputFields: ['Fetch'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Token', toHandle: 'input-0' },
      { from: 'Token', fromHandle: 'output-0', to: 'Fetch', toHandle: 'input-0' },
      { from: 'Fetch', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /sup3r-s3cr3t-db-pass!/, 15000);
  });

  test('http node expands {{env.*}} templates in request headers', async ({ page, request }, testInfo) => {
    const token = await mintCyberArkToken();
    const flowId = await createFlowViaUi(page, uniqueFlowName('HttpHeaderEnvTest'));
    (testInfo as any).flowId = flowId;
    // Add the flow env var via the flow settings UI
    await page.getByTestId('flow-settings-btn').click();
    const settingsModal = page.locator('[data-co-pilot-modal="flow-settings"]');
    await expect(settingsModal).toBeVisible({ timeout: 5000 });
    await settingsModal.getByPlaceholder('Variable name').fill('CYB_TOKEN');
    await settingsModal.getByPlaceholder('Value').last().fill(token);
    await settingsModal.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'add' }) }).last().click();
    await expect(settingsModal.getByText('CYB_TOKEN')).toBeVisible({ timeout: 5000 });
    await settingsModal.getByRole('button').filter({ has: page.locator('.material-symbols-outlined', { hasText: 'close' }) }).first().click();
    await expect(settingsModal).not.toBeVisible();

    await configureNode(page, 'Trigger', 'Trigger');
    await closeConfig(page);
    await moveNodeToSlot(page, 'Trigger', -1, 0);
    const h1 = await addNode(page, 'http');
    await moveNodeToSlot(page, h1, 0, 0);
    await configureNode(page, h1, 'Fetch');
    await applyConfig(page, 'http', 'Fetch', {
      method: 'GET', url: `${MOCK_CYBERARK_INTERNAL}/api/secrets/dev/variable/prod%2Fdb%2Fpassword`,
      headers: '{"Authorization":"Token token=\\"{{env.CYB_TOKEN}}\\""}', allowPrivate: true,
    });
    await closeConfig(page);
    const o1 = await addNode(page, 'output');
    await moveNodeToSlot(page, o1, 1, 0);
    await configureNode(page, o1, 'Output');
    await closeConfig(page);
    await connect(page, 'Trigger', 'output-0', 'Fetch', 'input-0');
    await connect(page, 'Fetch', 'output-0', 'Output', 'input-0');
    await saveFlow(page);

    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /sup3r-s3cr3t-db-pass!/, 15000);
  });

  // ── Delay ────────────────────────────────────────────────────

  test('delay node with zero seconds passes through', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('DelayTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'delay', label: 'Pause', config: { type: 'fixed', seconds: 0 } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Pause', toHandle: 'input-0' },
      { from: 'Pause', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page);
  });

  test('delay node with ISO 8601 duration', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('DelayDurTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'delay', label: 'D', config: { type: 'duration', duration: 'PT0S' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'D', toHandle: 'input-0' },
      { from: 'D', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page);
  });

  test('delay node with past timestamp passes through', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('DelayTsTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'delay', label: 'D', config: { type: 'timestamp', timestamp: '2020-01-01T00:00:00Z' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'D', toHandle: 'input-0' },
      { from: 'D', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page);
  });

  // NOTE: the persisted-execution delay test (executePersisted + poll) stays
  // API-based — the debug overlay executes in-memory and does not persist
  // execution records, so the delay-resume behavior is only observable via
  // the persisted execution API.

  // ── AI Action ────────────────────────────────────────────────

  test('ai-action node calls LLM and returns response', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    const flowId = await buildUiFlow(page, request, uniqueFlowName('AIActionTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'ai-action', label: 'AI', config: { endpointId: mockEndpointId!, model: 'mock-gpt-4', prompt: 'MOCK_RESPONSE: "Hello from AI Action"' } },
      { type: 'output', label: 'Output', config: { inputFields: ['AI'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'AI', toHandle: 'input-0' },
      { from: 'AI', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;
    testInfo.setTimeout(60000);

    await runFlow(page);
    await expectCompleted(page, 30000);
    await expectFinalOutput(page, /Hello from AI Action/, 15000);
  });

  test('ai-action node fails when endpointId is missing', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('AIActionNoEp'), [
      { type: 'trigger', label: 'Trigger' },
      // No endpoint selected on purpose — the form stays empty
      { type: 'ai-action', label: 'AI', config: { prompt: 'test' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'AI', toHandle: 'input-0' },
      { from: 'AI', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectFailed(page, /endpointId is required/);
  });

  test('ai-action node fails when prompt is missing', async ({ page, request }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('AIActionNoPrompt'), [
      { type: 'trigger', label: 'Trigger' },
      // Endpoint and model set via the form, prompt left empty
      { type: 'ai-action', label: 'AI', config: { endpointId: mockEndpointId!, model: 'mock-gpt-4', prompt: '' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'AI', toHandle: 'input-0' },
      { from: 'AI', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectFailed(page, /prompt is required/);
  });

  // ── Note ─────────────────────────────────────────────────────

  test('note node passes through without error', async ({ page, request }, testInfo) => {
    // The Note node is a sticky note with no connection handles — it cannot be
    // wired into a flow on the canvas, so it is placed alongside a working
    // trigger → output flow and must not break execution.
    const flowId = await buildUiFlow(page, request, uniqueFlowName('NoteTest'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'note', label: 'Note', config: { content: 'important note' }, col: 3 },
      { type: 'output', label: 'Output', config: { inputFields: [] }, col: 2 },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    await runFlow(page, 'hello');
    await expectCompleted(page);
  });

  // ── Advanced multi-node ──────────────────────────────────────

  test('advanced: trigger → http → map → output', async ({ page, request }, testInfo) => {
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('AdvHttpMap'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'http', label: 'Fetcher', config: { method: 'GET', url: 'http://backend-e2e:3001/api/health', allowPrivate: true } },
      { type: 'map', label: 'Mapper', config: { fields: [{ name: 'httpStatus', value: 'fetcher.status' }, { name: 'healthy', value: 'fetcher.ok' }], mode: 'replace' } },
      { type: 'output', label: 'Output', config: { inputFields: [] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'Fetcher', toHandle: 'input-0' },
      { from: 'Fetcher', fromHandle: 'output-0', to: 'Mapper', toHandle: 'input-0' },
      { from: 'Mapper', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page);
    await expectCompleted(page);
    await expandStep(page, 'Mapper');
    await expect(debugOverlay(page).getByText(/"httpStatus": 200/).first()).toBeVisible({ timeout: 10000 });
  });

  // NOTE: the map nested-path / null / type-passthrough tests and the
  // advanced code → map → loop test stay API-based (map nested paths are
  // covered by the UI map test above; loop sub-nodes have no UI). The
  // remaining API-based cases below pin engine-level behavior that the
  // debug overlay renders equivalently.
});
