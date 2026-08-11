import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';
import { debugExecute } from './helpers/stream';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

/**
 * LLM Agent thinking mode (DeepSeek-style chain-of-thought control).
 *
 * The mock LLM endpoint uses a model named `deepseek-v4-flash` so the worker's
 * thinking-strategy resolver picks the DeepSeek strategy even though the base
 * URL points at the mock server. The mock supports two test directives:
 *   - ECHO_PARAMS        → responds with the request's `thinking`,
 *                          `reasoning_effort` and `reasoning_content` pass-back
 *   - MOCK_THINKING_TOOL_CALL → first call returns reasoning_content + a tool
 *                          call; follow-up call reports the pass-back value.
 */
test.describe('LLM Agent thinking mode', () => {
  let deepseekEndpointId: string | null = null;
  const flowIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: 'E2E Mock DeepSeek',
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
    for (const id of flowIds) await deleteFlow(request, id).catch(() => {});
    if (deepseekEndpointId) await request.delete(`${API_URL}/llm-endpoints/${deepseekEndpointId}`);
  });

  const cookie = getAuthCookie() || undefined;

  async function createThinkingFlow(request: any, name: string, config: any) {
    const res = await createFlow(request, {
      name,
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        {
          id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 },
          data: { label: 'LLM Agent', type: 'llm-agent', config: { endpointId: deepseekEndpointId, model: 'deepseek-v4-flash', systemPrompt: '', responseFormat: 'text', ...config } },
        },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['llm_agent.content'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
        { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    const flow = await res.json();
    flowIds.push(flow.id);
    return flow;
  }

  test('sends thinking disabled when thinkingMode is disabled', async ({ request }) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');

    const flow = await createThinkingFlow(request, uniqueFlowName('ThinkingDisabled'), {
      thinkingMode: 'disabled',
      systemPrompt: 'ECHO_PARAMS',
    });

    const events = await debugExecute(flow.id, { message: 'hi' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const params = JSON.parse(completed!.data?.output?.l1?.content || '{}');
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.reasoning_effort).toBeNull();
  });

  test('sends thinking enabled with reasoning_effort for effort levels', async ({ request }) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');

    const flow = await createThinkingFlow(request, uniqueFlowName('ThinkingXHigh'), {
      thinkingMode: 'xhigh',
      systemPrompt: 'ECHO_PARAMS',
    });

    const events = await debugExecute(flow.id, { message: 'hi' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const params = JSON.parse(completed!.data?.output?.l1?.content || '{}');
    expect(params.thinking).toEqual({ type: 'enabled' });
    expect(params.reasoning_effort).toBe('xhigh');
  });

  test('echoes reasoning_content back when thinking mode + tool calls are used', async ({ request }) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');

    const flow = await createThinkingFlow(request, uniqueFlowName('ThinkingPassback'), {
      thinkingMode: 'enabled',
      systemPrompt: 'MOCK_THINKING_TOOL_CALL: get_weather {"city":"Amsterdam"}',
    });

    const events = await debugExecute(flow.id, { message: 'weather?' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    // Round 1: the mock emits reasoning_content + a tool call; round 2 must
    // receive the reasoning_content echoed back on the assistant message.
    const content = completed!.data?.output?.l1?.content || '';
    expect(content).toContain('THINKING_PASSBACK=Mock chain of thought for thinking test');
  });

  test('thinking mode dropdown offers DeepSeek effort levels and persists', async ({ page, request }) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');

    const flow = await createThinkingFlow(request, uniqueFlowName('ThinkingUI'), {});
    await page.goto(`/flows/${flow.id}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });

    // Open the LLM Agent config modal
    await page.locator('.react-flow__node').filter({ has: page.getByText('LLM Agent', { exact: true }) }).first().click();
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });

    // The dropdown shows the DeepSeek option set (incl. x-high effort)
    await page.locator('[role="combobox"]').filter({ hasText: 'Default (provider)' }).click();
    await expect(page.getByRole('option', { name: 'Enabled — x-high effort' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('option', { name: 'Enabled — x-high effort' }).click();

    // Save and verify the config persisted via the API
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('node-config-modal')).toHaveCount(0, { timeout: 3000 });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => {
      const res = await request.get(`${API_URL}/flows/${flow.id}`);
      if (!res.ok()) return false;
      const saved = await res.json();
      const llmNode = saved.nodes?.find((n: any) => n.data?.type === 'llm-agent');
      return llmNode?.data?.config?.thinkingMode === 'xhigh';
    }, { timeout: 10000, message: 'thinkingMode should persist' }).toBe(true);
  });

  test('ai-action node sends thinking params with ECHO_PARAMS in its prompt', async ({ request }) => {
    test.skip(!deepseekEndpointId, 'Mock LLM endpoint not available');

    // AI Action has no system prompt, so the ECHO_PARAMS directive lives in
    // the prompt (user message). The mock echoes the request's thinking params
    // back as the response content.
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('AIActionThinking'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        {
          id: 'a1', type: 'ai-action', position: { x: 300, y: 0 },
          data: { label: 'AI Action', type: 'ai-action', config: { endpointId: deepseekEndpointId, model: 'deepseek-v4-flash', prompt: 'ECHO_PARAMS', thinkingMode: 'disabled' } },
        },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['ai_action.content'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'a1', targetHandle: 'input-0' },
        { id: 'e2', source: 'a1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();

    const events = await debugExecute(flow.id, { message: 'hi' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const params = JSON.parse(completed!.data?.output?.a1?.content || '{}');
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect(params.reasoning_effort).toBeNull();
  });
});
