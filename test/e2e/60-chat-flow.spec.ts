import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import {
  createFlowViaUi, addNode, clickNode, configureNode, closeConfig, fillField,
  fillFieldByPlaceholder, selectOption, connect, moveNodeToSlot, saveFlow,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const MOCK_LLM_URL = 'http://mock-llm-e2e:3002/v1';

// ── UI flow builder (same recipe as 90-node-types) ─────────────────────────
// The chat flow (chat trigger + LLM agent + output) is built through the real
// editor UI; the tests then drive the real chat UI (/chat/<flowId>).

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
      break;
    case 'llm-agent': {
      if (config.endpointId) await selectOption(page, 'LLM Endpoint', /E2E Mock LLM/);
      if (config.model) await selectOption(page, 'Model', config.model);
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
    case 'output': {
      for (const field of config.inputFields || []) {
        // Check the field checkbox (e.g. "content" under the upstream node).
        // The checkbox label renders as "{name}: {type}". Exact text match is
        // required — a chat trigger's "history: array<{role,content}>" field
        // also contains the substring "content".
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

/** Build the chat flow through the editor UI and save it. Returns the flow id. */
async function buildChatFlow(page: any, endpointId: string, name: string): Promise<string> {
  const flowId = await createFlowViaUi(page, name);
  // Pass 1: add/rename/move all nodes (new nodes land at the canvas centre,
  // so each is moved to its slot immediately).
  await configureNode(page, 'Trigger', 'Chat');
  await closeConfig(page);
  await moveNodeToSlot(page, 'Chat', -1, 0);
  const agentLabel = await addNode(page, 'llm-agent');
  await moveNodeToSlot(page, agentLabel, 0, 0);
  await configureNode(page, agentLabel, 'Assistant');
  await closeConfig(page);
  const outLabel = await addNode(page, 'output');
  await moveNodeToSlot(page, outLabel, 1, 0);
  await configureNode(page, outLabel, 'Output');
  await closeConfig(page);

  // Pass 2: connect incoming edges, then apply configs in order.
  await connect(page, 'Chat', 'output-0', 'Assistant', 'input-0');
  await openConfig(page, 'Chat');
  await applyConfig(page, 'trigger', 'Chat', { triggerType: 'chat' });
  await closeConfig(page);

  await connect(page, 'Assistant', 'output-0', 'Output', 'input-0');
  await openConfig(page, 'Assistant');
  await applyConfig(page, 'llm-agent', 'Assistant', {
    endpointId,
    model: 'mock-gpt-4',
    systemPrompt: 'MOCK_RESPONSE: "Hello from chat!"',
    responseFormat: 'text',
  });
  await closeConfig(page);

  await openConfig(page, 'Output');
  await applyConfig(page, 'output', 'Output', { inputFields: ['assistant.content'] });
  await closeConfig(page);

  await saveFlow(page);
  return flowId;
}

test.describe('Chat flow', () => {
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: 'E2E Mock LLM',
        providerType: 'openai',
        baseUrl: MOCK_LLM_URL,
        apiKey: 'mock-key',
        defaultModel: 'mock-gpt-4',
        models: ['mock-gpt-4'],
      },
    });
    expect(res.ok(), 'mock LLM endpoint should be created — every test in this file depends on it').toBe(true);
    const ep = await res.json();
    mockEndpointId = ep.id;
  });

  test.afterAll(async ({ request }) => {
    if (mockEndpointId) {
      await request.delete(`${API_URL}/llm-endpoints/${mockEndpointId}`).catch(() => {});
    }
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');
    const flowId = await buildChatFlow(page, mockEndpointId!, uniqueFlowName('Chat Flow E2E'));
    (testInfo as any).flowId = flowId;
  });

  test.afterEach(async ({ request }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  const sessionsHeading = (page: any) => page.getByRole("heading", { name: "Chat Sessions" });

  /** Start a new chat session through the UI and return the session URL. */
  async function startNewChat(page: any, flowId: string): Promise<void> {
    await page.goto(`/chat/${flowId}`);
    await expect(sessionsHeading(page)).toBeVisible({ timeout: 15000 });
    await page.getByText('New Chat').click();
    await expect(page).toHaveURL(new RegExp(`/chat/${flowId}/[^/]+`));
    await expect(page.getByLabel('Message')).toBeVisible({ timeout: 10000 });
  }

  /** Send a message in an open chat session and wait for the mock response. */
  async function sendMessageAndWait(page: any, message: string): Promise<void> {
    await page.getByLabel('Message').fill(message);
    await page.keyboard.press('Enter');
    await expect(page.getByText(message, { exact: true })).toBeVisible({ timeout: 5000 });
    await expect.poll(
      () => page.getByText('Hello from chat!').count(),
      { timeout: 20000, message: 'assistant response should render' },
    ).toBeGreaterThan(0);
  }

  test('chat page loads and allows starting a new chat', async ({ page }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    await page.goto(`/chat/${flowId}`);
    await expect(sessionsHeading(page)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('New Chat')).toBeVisible({ timeout: 5000 });
    await page.getByText('New Chat').click();
    await expect(page).toHaveURL(/\/chat\/[^/]+\/[^/]+/);
    await expect(page.getByLabel('Message')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Start a conversation with this agent')).toBeVisible();
  });

  test('sends a message and receives the streamed assistant response', async ({ page }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    await startNewChat(page, flowId);
    const message = 'What is 2+2?';
    await sendMessageAndWait(page, message);

    // User message appears in its own bubble (right-aligned primary bubble)
    const userBubble = page.locator('.flex.flex-row-reverse').filter({ hasText: message });
    await expect(userBubble).toBeVisible();

    // Assistant response renders in the conversation
    await expect(page.getByText('Hello from chat!').first()).toBeVisible({ timeout: 10000 });
    // Input returns to an editable state after the stream finishes
    await expect(page.getByLabel('Message')).toBeEnabled({ timeout: 15000 });
  });

  test('session appears in the session list after sending', async ({ page }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    const message = 'List sessions please';
    await startNewChat(page, flowId);
    await sendMessageAndWait(page, message);

    // Navigate back to the session list via the Back link
    await page.getByRole('link', { name: 'Back' }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${flowId}$`));
    await expect(sessionsHeading(page)).toBeVisible({ timeout: 15000 });

    // The session entry is titled with the first message
    await expect(page.getByText(message)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('a[href^="/chat/"][href*="' + flowId + '"]').filter({ hasText: message })).toBeVisible();
  });

  test('reload restores the conversation history from the session', async ({ page }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    const message = 'Remember me';
    await startNewChat(page, flowId);
    await sendMessageAndWait(page, message);

    await page.reload();
    await expect(page.getByLabel('Message')).toBeVisible({ timeout: 10000 });
    // Prior messages render again after reload
    await expect(page.getByText(message, { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Hello from chat!').first()).toBeVisible({ timeout: 10000 });
    // The empty-state hint is gone because history loaded
    await expect(page.getByText('Start a conversation with this agent')).toHaveCount(0);
  });

  test('switches between multiple chat sessions', async ({ page }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    // Session A
    await startNewChat(page, flowId);
    await sendMessageAndWait(page, 'First question');

    // Session B
    await page.getByRole('link', { name: 'Back' }).click();
    await page.getByText('New Chat').click();
    await expect(page).toHaveURL(new RegExp(`/chat/${flowId}/[^/]+`));
    await expect(page.getByLabel('Message')).toBeVisible({ timeout: 10000 });
    await sendMessageAndWait(page, 'Second question');

    // Back to list, open session A again
    await page.getByRole('link', { name: 'Back' }).click();
    await expect(sessionsHeading(page)).toBeVisible({ timeout: 15000 });
    await page.getByText('First question').click();
    await expect(page).toHaveURL(new RegExp(`/chat/${flowId}/[^/]+`));
    await expect(page.getByText('First question', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Second question')).toHaveCount(0);
    await expect(page.getByText('Hello from chat!').first()).toBeVisible({ timeout: 10000 });

    // Open session B again
    await page.getByRole('link', { name: 'Back' }).click();
    await page.getByText('Second question').click();
    await expect(page.getByText('Second question', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('First question')).toHaveCount(0);
  });

  test('deletes a session from the list', async ({ page }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    const message = 'Delete me later';
    await startNewChat(page, flowId);
    await sendMessageAndWait(page, message);

    await page.getByRole('link', { name: 'Back' }).click();
    await expect(sessionsHeading(page)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(message)).toBeVisible({ timeout: 10000 });

    // Delete via the row button + confirm dialog
    const row = page.locator('a[href^="/chat/"][href*="' + flowId + '"]').filter({ hasText: message });
    await row.locator('xpath=following-sibling::button').filter({ hasText: 'Delete' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

    // The session list (UI) confirms the deletion
    await expect(page.getByText(message)).toHaveCount(0, { timeout: 5000 });
    await expect(page.getByText('No conversations yet')).toBeVisible();
  });
});
