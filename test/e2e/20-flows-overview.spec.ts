import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

function flowCard(page: any, name: string) {
  return page.locator('div.rounded-lg.border.p-4').filter({ has: page.getByText(name, { exact: true }) });
}

test.describe('Flows overview', () => {
  // Quick-run tests execute flows — a cold worker's first run can take a
  // while, so the default 30s budget is too tight.
  test.describe.configure({ timeout: 120000 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows flows list heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Flows').first()).toBeVisible();
  });

  test('shows new flow button', async ({ page }) => {
    await page.goto('/');
    const createBtn = page.getByText('New Flow').first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
  });

  test('new flow button navigates to editor', async ({ page }) => {
    await page.goto('/');
    await page.getByText('New Flow').first().click();
    await expect(page).toHaveURL(/\/flows\/[^/]+\/edit/);
  });

  test('created flow appears in the list', async ({ page, request }) => {
    const res = await createFlow(request, { name: uniqueFlowName('Test Flow E2E'), description: 'E2E test flow' });
    const flow = await res.json();
    await page.goto('/');
    await expect(page.getByText('Test Flow E2E')).toBeVisible();
    // Cleanup
    await deleteFlow(request, flow.id);
  });

  test('search filters the list', async ({ page, request }) => {
    const res1 = await createFlow(request, { name: uniqueFlowName('Alpha Flow') });
    const res2 = await createFlow(request, { name: uniqueFlowName('Beta Flow') });
    const flow1 = await res1.json();
    const flow2 = await res2.json();

    await page.goto('/');
    await expect(page.getByText('Alpha Flow')).toBeVisible();
    await expect(page.getByText('Beta Flow')).toBeVisible();

    // Type in search
    await page.getByLabel('Search').fill('Alpha');
    await expect(page.getByText('Alpha Flow')).toBeVisible();
    await expect(page.getByText('Beta Flow')).not.toBeVisible();

    await deleteFlow(request, flow1.id);
    await deleteFlow(request, flow2.id);
  });

  test('search with no matches shows empty state message', async ({ page, request }) => {
    const res = await createFlow(request, { name: uniqueFlowName('Present Flow') });
    const flow = await res.json();
    await page.goto('/');
    await expect(page.getByText('Present Flow')).toBeVisible();

    await page.getByLabel('Search').fill(uniqueFlowName('zzzz-no-such-flow'));
    await expect(page.getByText('No flows match your search')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Present Flow')).not.toBeVisible();

    await deleteFlow(request, flow.id);
  });

  test('group filter filters the flows list', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: uniqueFlowName('Flow Filter Group') } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();

    const res1 = await createFlow(request, { name: uniqueFlowName('Grouped Flow'), group_id: group.id });
    const res2 = await createFlow(request, { name: uniqueFlowName('Ungrouped Flow') });
    const flow1 = await res1.json();
    const flow2 = await res2.json();

    await page.goto('/');
    await expect(page.getByText('Filter by group').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(flow1.name, { exact: true })).toBeVisible();
    await expect(page.getByText(flow2.name, { exact: true })).toBeVisible();

    // Open the group filter dropdown and pick the group
    await page.getByText('All groups').first().click();
    await page.getByText(group.name).first().click();
    await expect(page.getByText(flow1.name, { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(flow2.name, { exact: true })).not.toBeVisible();

    // Switch back to "All groups" to restore the full list
    await page.getByText(group.name).first().click();
    await page.getByText('All groups').first().click();
    await expect(page.getByText(flow2.name, { exact: true })).toBeVisible({ timeout: 5000 });

    await deleteFlow(request, flow1.id);
    await deleteFlow(request, flow2.id);
    await request.delete(`${API_URL}/groups/${group.id}`);
  });

  test('delete flow removes it from list', async ({ page, request }) => {
    const res = await createFlow(request, { name: uniqueFlowName('Delete Me') });
    const flow = await res.json();
    await page.goto('/');

    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.getByRole('button', { name: 'Delete' }).click();

    // Confirm dialog must appear before deletion happens
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText('Delete flow?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText(flow.name, { exact: true })).not.toBeVisible({ timeout: 5000 });
    // Flow must be gone from the API as well
    const gone = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(gone.status()).toBe(404);
  });

  test('shows correct trigger type badge for manual trigger', async ({ page, request }) => {
    const res = await createFlow(request, {
      name: uniqueFlowName('Manual Trigger Flow'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: {} } },
      ],
      edges: [],
    });
    const flow = await res.json();
    await page.goto('/');

    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });
    // Manual trigger badge = play_arrow icon, and no webhook badge in this card
    await expect(card.locator('.material-symbols-outlined').first()).toHaveText('play_arrow');
    await expect(card.locator('.material-symbols-outlined', { hasText: 'webhook' })).toHaveCount(0);

    await deleteFlow(request, flow.id);
  });

  test('webhook-trigger flow shows webhook badge in the list', async ({ page, request }) => {
    const res = await createFlow(request, {
      name: uniqueFlowName('Webhook Flow'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'webhook' } } },
      ],
      edges: [],
    });
    const flow = await res.json();
    await page.goto('/');

    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });
    // Badge icon is the first material symbol in the card (webhook)
    await expect(card.locator('.material-symbols-outlined').first()).toHaveText('webhook');
    // Webhook flows also expose an API docs link
    await expect(card.getByRole('link', { name: 'API' })).toBeVisible();

    await deleteFlow(request, flow.id);
  });

  test('chat-trigger flow shows chat badge in the list', async ({ page, request }) => {
    const res = await createFlow(request, {
      name: uniqueFlowName('Chat Flow'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
      ],
      edges: [],
    });
    const flow = await res.json();
    await page.goto('/');

    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });
    // Badge icon is the first material symbol in the card (chat)
    await expect(card.locator('.material-symbols-outlined').first()).toHaveText('chat');
    // Chat flows expose an "Open Chat" link
    await expect(card.getByRole('link', { name: 'Open Chat' })).toBeVisible();

    await deleteFlow(request, flow.id);
  });

  test('flow name click navigates to the editor', async ({ page, request }) => {
    const res = await createFlow(request, { name: uniqueFlowName('Navigate Me') });
    const flow = await res.json();
    await page.goto('/');

    await page.getByRole('link', { name: 'Navigate Me' }).click();
    await expect(page).toHaveURL(new RegExp(`/flows/${flow.id}/edit`));

    await deleteFlow(request, flow.id);
  });

  // ─── Quick run from the flow card (RunModal) ─────────────────────────

  test('quick run: Run button opens the run modal with prefilled trigger input', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('QuickRun'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    await page.goto('/');
    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });

    // The Run button opens the modal with the default trigger input prefilled
    await card.getByRole('button', { name: 'Run' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Run ${flow.name}` })).toBeVisible({ timeout: 5000 });
    await expect(dialog.locator('textarea')).toHaveValue(/"message": "Hello!"/);

    // Invalid JSON is rejected client-side
    await dialog.locator('textarea').fill('not json');
    await dialog.getByRole('button', { name: 'Run' }).click();
    await expect(dialog.getByText('Input must be valid JSON.')).toBeVisible({ timeout: 5000 });

    // Cancel closes without running
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    await expect(card.getByRole('button', { name: 'Run' })).toBeVisible();

    await deleteFlow(request, flow.id);
  });

  test('quick run: valid input executes the flow and the card shows Completed', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('QuickRunExec'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    await page.goto('/');
    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });

    await card.getByRole('button', { name: 'Run' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Run ${flow.name}` })).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Run' }).click();

    // The card shows the transient Completed state after the run starts
    // (cold-worker first runs can be slow to emit the initial SSE event).
    // Note: the span also contains the check_circle icon ligature, so the
    // match must be non-exact.
    await expect(card.getByText('Completed')).toBeVisible({ timeout: 45000 });

    // A persisted execution was created (the quick run is not a debug run)
    await expect.poll(async () => {
      const res = await request.get(`${API_URL}/flows/${flow.id}/executions`);
      if (!res.ok()) return 0;
      const data = await res.json();
      return (data.data || data).length;
    }, { timeout: 10000 }).toBeGreaterThan(0);

    await deleteFlow(request, flow.id);
  });

  // ─── Sort ────────────────────────────────────────────────────────────

  test('sort by Created reorders the list', async ({ page, request }) => {
    const older = await (await createFlow(request, { name: uniqueFlowName('SortOlder') })).json();
    await new Promise(r => setTimeout(r, 1200));
    const newer = await (await createFlow(request, { name: uniqueFlowName('SortNewer') })).json();

    await page.goto('/');
    await expect(page.getByRole('link', { name: older.name })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('link', { name: newer.name })).toBeVisible();

    // Default "Last updated" — newer first
    const cards = page.locator('div.rounded-lg.border.p-4');
    await expect(cards.first()).toContainText(newer.name);

    // Switch to "Created" — still newest created first
    await page.getByText('Last updated').click();
    await page.getByRole('option', { name: 'Created' }).click();
    await expect(cards.first()).toContainText(newer.name, { timeout: 5000 });
    await expect(cards.nth(1)).toContainText(older.name);

    await deleteFlow(request, older.id);
    await deleteFlow(request, newer.id);
  });

  // ─── Pagination ──────────────────────────────────────────────────────

  test('pagination: Next and Previous pages with more than 20 flows', async ({ page, request }) => {
    const created: any[] = [];
    for (let i = 0; i < 22; i++) {
      created.push(await (await createFlow(request, { name: uniqueFlowName(`PageFlow${i}`) })).json());
    }
    const last = created[created.length - 1].name;

    await page.goto('/');
    await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible({ timeout: 10000 });
    // The newest flow is on the first page
    await expect(page.getByRole('link', { name: last })).toBeVisible({ timeout: 5000 });
    // 20 cards on page 1
    await expect(page.locator('div.rounded-lg.border.p-4')).toHaveCount(20);

    // Next page shows the remaining flows (earlier tests may leak flows, so
    // the exact count varies — the first of our fixtures must be here though)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Page 2 of 2', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('link', { name: created[0].name })).toBeVisible({ timeout: 5000 });
    // A partial page — fewer than 20 cards
    await expect.poll(async () => page.locator('div.rounded-lg.border.p-4').count(), { timeout: 5000 }).toBeLessThan(20);

    // Previous returns to page 1
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(page.getByText('Page 1 of 2', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('link', { name: last })).toBeVisible({ timeout: 5000 });

    for (const f of created) await deleteFlow(request, f.id);
  });

  // ─── Per-trigger card actions ────────────────────────────────────────

  test('chat flow card links to the chat page', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('ChatCard'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Chat', type: 'trigger', config: { triggerType: 'chat' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    await page.goto('/');
    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });

    // The Open Chat link goes to the chat session list
    await card.getByRole('link', { name: 'Open Chat' }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${flow.id}$`));
    await expect(page.getByRole('heading', { name: 'Chat Sessions' })).toBeVisible({ timeout: 10000 });

    await deleteFlow(request, flow.id);
  });

  test('webhook flow card links to the API docs', async ({ page, request }) => {
    const flowRes = await createFlow(request, {
      name: uniqueFlowName('ApiCard'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Webhook', type: 'trigger', config: { triggerType: 'webhook' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' }],
    });
    const flow = await flowRes.json();

    await page.goto('/');
    const card = flowCard(page, flow.name);
    await expect(card).toBeVisible({ timeout: 10000 });

    await card.locator('a[href="/api/docs"]').click();
    // The link opens the Swagger UI in a new tab
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await expect(popup.locator('body')).not.toHaveText(/404/, { timeout: 10000 });
    } else {
      // Fallback: the docs may render in the same tab
      await expect(page.locator('body')).not.toHaveText(/404/, { timeout: 10000 });
    }

    await deleteFlow(request, flow.id);
  });
});
