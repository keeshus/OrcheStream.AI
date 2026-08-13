import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import {
  createFlowViaUi, addNode, configureNode, closeConfig, fillField,
  fillFieldByPlaceholder, selectOption, connect, moveNodeToSlot, saveFlow,
  runFlow, debugOverlay, expandStep, expectCompleted, clickNode,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

// ── UI flow builder ────────────────────────────────────────────────────────
// Everything below goes through the real editor UI: catalog clicks, canvas
// handle drags, config modal forms, Save button and the debug run overlay.
// The API is used only for fixtures (creating/deleting the mock LLM endpoint
// in beforeAll/afterAll and deleting flows in afterEach).

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
    case 'llm-agent': {
      if (config.endpointId) {
        await selectOption(page, 'LLM Endpoint', /E2E Mock LLM/);
      }
      if (config.model) {
        await selectOption(page, 'Model', config.model);
      }
      if (config.systemPrompt !== undefined) {
        await fillFieldByPlaceholder(page, 'You are a helpful assistant... Type {{ for field suggestions', config.systemPrompt);
      }
      if (config.thinkingMode === 'disabled') {
        await selectOption(page, 'Thinking Mode', 'Disabled');
      } else if (config.thinkingMode === 'enabled') {
        await selectOption(page, 'Thinking Mode', 'Enabled (default effort)');
      } else if (config.thinkingMode === 'xhigh') {
        await selectOption(page, 'Thinking Mode', 'Enabled — x-high effort');
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
      if (config.thinkingMode === 'disabled') {
        await selectOption(page, 'Thinking Mode', 'Disabled');
      } else if (config.thinkingMode === 'enabled') {
        await selectOption(page, 'Thinking Mode', 'Enabled (default effort)');
      }
      break;
    }
    case 'output': {
      for (const field of config.inputFields || []) {
        // Check the field checkbox (e.g. "content" under the LLM Agent node).
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
  // with jitter, so each node is moved to its slot immediately after being
  // added — before any click. The grid is shifted so no slot sits at the
  // canvas centre itself.
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
  // derive from upstreams) and config must run before the node's outgoing
  // edges (output field checkboxes need upstream data).
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

test.describe('LLM Agent thinking mode', () => {
  let deepseekEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Remove any stale mock endpoints left over from interrupted runs so the
    // Radix select options stay unambiguous (strict option matching).
    const listRes = await request.get(`${API_URL}/llm-endpoints`);
    if (listRes.ok()) {
      const existing = await listRes.json();
      for (const ep of Array.isArray(existing) ? existing : []) {
        if (typeof ep?.name === 'string' && (ep.name.startsWith('E2E Mock') || ep.name.startsWith('E2E AI Action'))) {
          await request.delete(`${API_URL}/llm-endpoints/${ep.id}`).catch(() => {});
        }
      }
    }
    // The mock LLM endpoint uses a model named `deepseek-v4-flash` so the
    // thinking-strategy resolver picks the DeepSeek strategy even though the
    // base URL points at the mock server.
    const res = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: 'E2E Mock LLM',
        providerType: 'openai',
        baseUrl: 'http://mock-llm-e2e:3002/v1',
        apiKey: 'mock-key',
        defaultModel: 'deepseek-v4-flash',
        models: ['deepseek-v4-flash'],
      },
    });
    if (res.ok()) {
      const ep = await res.json();
      deepseekEndpointId = ep.id;
    }
  });

  test.afterAll(async ({ request }) => {
    if (deepseekEndpointId) await request.delete(`${API_URL}/llm-endpoints/${deepseekEndpointId}`);
  });

  test.afterEach(async ({ request }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('sends thinking disabled when thinkingMode is disabled', async ({ page, request }, testInfo) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(120000);
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('ThinkingDisabled'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: {
        endpointId: deepseekEndpointId!, model: 'deepseek-v4-flash',
        systemPrompt: 'ECHO_PARAMS', thinkingMode: 'disabled',
      } },
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'hi');
    await expectCompleted(page, 30000);
    await expandStep(page, 'LLM Agent');
    // The mock echoes the request's thinking params back as the response content.
    await expect(debugOverlay(page).getByText(/"type":"disabled"/).first()).toBeVisible({ timeout: 10000 });
    await expect(debugOverlay(page).getByText(/"reasoning_effort":null/).first()).toBeVisible();
  });

  test('sends thinking enabled with reasoning_effort for effort levels', async ({ page, request }, testInfo) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(120000);
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('ThinkingXHigh'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: {
        endpointId: deepseekEndpointId!, model: 'deepseek-v4-flash',
        systemPrompt: 'ECHO_PARAMS', thinkingMode: 'xhigh',
      } },
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'hi');
    await expectCompleted(page, 30000);
    await expandStep(page, 'LLM Agent');
    await expect(debugOverlay(page).getByText(/"type":"enabled"/).first()).toBeVisible({ timeout: 10000 });
    await expect(debugOverlay(page).getByText(/"reasoning_effort":"xhigh"/).first()).toBeVisible();
  });

  test('echoes reasoning_content back when thinking mode + tool calls are used', async ({ page, request }, testInfo) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(120000);
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('ThinkingPassback'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: {
        endpointId: deepseekEndpointId!, model: 'deepseek-v4-flash',
        systemPrompt: 'MOCK_THINKING_TOOL_CALL: get_weather {"city":"Amsterdam"}', thinkingMode: 'enabled',
      } },
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    // Round 1: the mock emits reasoning_content + a tool call; round 2 must
    // receive the reasoning_content echoed back on the assistant message.
    await runFlow(page, 'weather?');
    await expectCompleted(page, 30000);
    await expandStep(page, 'LLM Agent');
    await expect(debugOverlay(page).getByText(/THINKING_PASSBACK=Mock chain of thought for thinking test/).first()).toBeVisible({ timeout: 10000 });
  });

  test('thinking mode dropdown offers DeepSeek effort levels and persists', async ({ page, request }, testInfo) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('ThinkingUI'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'llm-agent', label: 'LLM Agent', config: { endpointId: deepseekEndpointId!, model: 'deepseek-v4-flash', systemPrompt: '' } },
      { type: 'output', label: 'Output', config: { inputFields: ['llm_agent.content'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'LLM Agent', toHandle: 'input-0' },
      { from: 'LLM Agent', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    // The dropdown shows the DeepSeek option set (incl. x-high effort)
    await openConfig(page, 'LLM Agent');
    await page.locator('[data-field-label="Thinking Mode"]').click();
    await expect(page.getByRole('option', { name: 'Enabled — x-high effort' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('option', { name: 'Enabled — x-high effort' }).click();
    await closeConfig(page);
    await saveFlow(page);

    // Reload the editor and re-open the modal: the selection must have
    // persisted to the saved flow definition.
    await page.reload();
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 15000 });
    await openConfig(page, 'LLM Agent');
    await expect(page.locator('[data-field-label="Thinking Mode"]')).toContainText('Enabled — x-high effort', { timeout: 5000 });
  });

  test('ai-action node sends thinking params with ECHO_PARAMS in its prompt', async ({ page, request }, testInfo) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');
    testInfo.setTimeout(120000);
    // AI Action has no system prompt, so the ECHO_PARAMS directive lives in
    // the prompt (user message). The mock echoes the request's thinking params
    // back as the response content.
    (testInfo as any).flowId = await buildUiFlow(page, request, uniqueFlowName('AIActionThinking'), [
      { type: 'trigger', label: 'Trigger' },
      { type: 'ai-action', label: 'AI Action', config: {
        endpointId: deepseekEndpointId!, model: 'deepseek-v4-flash',
        prompt: 'ECHO_PARAMS', thinkingMode: 'disabled',
      } },
      { type: 'output', label: 'Output', config: { inputFields: ['AI Action'] } },
    ], [
      { from: 'Trigger', fromHandle: 'output-0', to: 'AI Action', toHandle: 'input-0' },
      { from: 'AI Action', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);

    await runFlow(page, 'hi');
    await expectCompleted(page, 30000);
    await expandStep(page, 'AI Action');
    // AI Action is not an isLLM step card, so its content only renders inside
    // the JSON-escaped "Full Output" pre — match the escaped form.
    await expect(debugOverlay(page).getByText(/\\"type\\":\\"disabled\\"/).first()).toBeVisible({ timeout: 10000 });
    await expect(debugOverlay(page).getByText(/\\"reasoning_effort\\":null/).first()).toBeVisible();
  });
});
