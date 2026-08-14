import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const cookie = getAuthCookie() || undefined;

test.describe('Agent contexts system', () => {
const cleanupContextIds: string[] = [];
const cleanupGroupIds: string[] = [];
const cleanupFlowIds: string[] = [];
const cleanupUserIds: string[] = [];
  let mockEndpointId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const llmRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: { name: 'E2E Mock LLM AC', providerType: 'openai', baseUrl: 'http://mock-llm-e2e:3002/v1', apiKey: 'mock-key', defaultModel: 'mock-gpt-4', models: ['mock-gpt-4'] },
    });
    if (llmRes.ok()) { const ep = await llmRes.json(); mockEndpointId = ep.id; }
  });

  test.afterAll(async ({ request }) => {
    if (mockEndpointId) await request.delete(`${API_URL}/llm-endpoints/${mockEndpointId}`);
  });

  test.afterEach(async ({ request }) => {
    for (const id of cleanupUserIds) {
      await request.delete(`${API_URL}/users/${id}`).catch(() => {});
    }
    cleanupUserIds.length = 0;
    for (const id of cleanupContextIds) {
      await request.delete(`${API_URL}/agent-contexts/${id}`).catch(() => {});
    }
    cleanupContextIds.length = 0;
    for (const id of cleanupGroupIds) {
      await request.delete(`${API_URL}/groups/${id}`).catch(() => {});
    }
    cleanupGroupIds.length = 0;
    for (const id of cleanupFlowIds) {
      await deleteFlow(request, id).catch(() => {});
    }
    cleanupFlowIds.length = 0;
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Agent Context CRUD (via the home page UI) ───────────────
  // NOTE: the API happy-path CRUD tests were removed — the home page
  // Agent Contexts tab covers create/edit/delete through the UI below
  // ('agent contexts form group selector assigns context to group',
  // 'edit an agent context via UI', 'delete an agent context via UI').
  // ═══════════════════════════════════════════════════════════════

  test('rejects empty title', async ({ request }) => {
    const res = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: '', content: 'test' },
    });
    expect(res.status()).toBe(400);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Global Context ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('global context settings page loads', async ({ page }) => {
    await page.goto('/settings/global-context');
    await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });
  });

  test('global context can be saved and read back', async ({ page }) => {
    await page.goto('/settings/global-context');
    await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });

    const textarea = page.locator('textarea').first();
    await textarea.fill('You are a helpful AI assistant for the Acme Corporation.');

    await page.getByRole('button', { name: /Save/ }).click();
    await expect(page.getByText('Global context saved')).toBeVisible({ timeout: 5000 });

    // Reload and verify persisted
    await page.goto('/settings/global-context');
    await expect(page.locator('textarea').first()).toHaveValue(/Acme Corporation/);
  });

  test('global context appears in settings navigation', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByText('Global Context')).toBeVisible();
    const link = page.locator('a').filter({ hasText: 'Global Context' }).first();
    await expect(link).toHaveAttribute('href', '/settings/global-context');
  });

  // ─── Global Context page: group scope + permissions ─────────────

  test('global-context page: admin can edit a group context via UI', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `GC-Admin-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    await page.goto('/settings/global-context');
    await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });

    // Admin sees all groups in the filter
    await page.getByText('All groups').first().click();
    await expect(page.getByText(group.name, { exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByText(group.name, { exact: true }).click();

    const textarea = page.locator('textarea');
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await textarea.fill('Group context set by admin via UI');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Context saved for/)).toBeVisible({ timeout: 5000 });

    const ctxRes = await request.get(`${API_URL}/groups/${group.id}/context`);
    expect(ctxRes.status()).toBe(200);
    expect((await ctxRes.json()).context).toBe('Group context set by admin via UI');
  });

  test('global-context page: plain member sees only their group and it is read-only', async ({ page, request }) => {
    const mine = (await (await request.post(`${API_URL}/groups`, { data: { name: `GC-Member-Group-${Date.now()}` } })).json());
    const other = (await (await request.post(`${API_URL}/groups`, { data: { name: `GC-Hidden-Group-${Date.now()}` } })).json());
    cleanupGroupIds.push(mine.id, other.id);

    const email = `gc-member-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'GC Member', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);
    const roles = await (await request.get(`${API_URL}/roles`)).json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${regData.user.id}/role`, { data: { role_id: editorRole.id } });
    await request.post(`${API_URL}/groups/${mine.id}/members`, { data: { userId: regData.user.id } });

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

    // A plain member is not a group admin — no Global Context link in settings
    await page.goto('/settings');
    await expect(page.getByText('Global Context')).toHaveCount(0);

    await page.goto('/settings/global-context');
    await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });

    // The filter lists only the member's own group
    await page.getByText('All groups').first().click();
    await expect(page.getByText(mine.name, { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(other.name, { exact: true })).toHaveCount(0);
    await page.getByText(mine.name, { exact: true }).click();

    // Group context is read-only for plain members — no Save button
    const textarea = page.locator('textarea');
    await expect(textarea).toBeDisabled({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  });

  test('global-context page: user without groups sees no group filter', async ({ page, request }) => {
    const email = `gc-nogroup-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'GC No Group', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);
    const roles = await (await request.get(`${API_URL}/roles`)).json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${regData.user.id}/role`, { data: { role_id: editorRole.id } });

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

    await page.goto('/settings/global-context');
    await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });

    // No groups → no group filter at all
    await expect(page.getByText('Filter by group')).toHaveCount(0);
    // Global context is read-only for non-admins
    await expect(page.locator('textarea')).toBeDisabled({ timeout: 5000 });
    await expect(page.getByText(/Global context is read-only/)).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Group Context (via the global-context settings page) ─────
  // ═══════════════════════════════════════════════════════════════

  test('group context: create group via UI, set context via settings page', async ({ page, request }) => {
    const name = `Ctx-Group-${Date.now()}`;

    // Create the group through the groups settings page
    await page.goto('/settings/groups');
    await page.getByRole('button', { name: 'Create Group' }).first().click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Create Group' }).last().click();
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
    const group = (await (await request.get(`${API_URL}/groups`)).json()).find((g: any) => g.name === name);
    expect(group).toBeDefined();
    cleanupGroupIds.push(group.id);

    // Set the context via the global-context page (group scope)
    await page.goto('/settings/global-context');
    await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });
    await page.getByText('All groups').first().click();
    await page.getByText(name, { exact: true }).first().click();
    const textarea = page.locator('textarea');
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await textarea.fill('This group manages customer-facing flows.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Context saved for/)).toBeVisible({ timeout: 5000 });

    // Reload — the context persists and is shown in the group filter
    await page.goto('/settings/global-context');
    await page.getByText('All groups').first().click();
    await page.getByText(name, { exact: true }).first().click();
    await expect(page.locator('textarea')).toHaveValue('This group manages customer-facing flows.', { timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Flow Context ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('flow context can be set via the Flow Settings modal', async ({ page, request }) => {
    const res = await createFlow(request, {
      name: uniqueFlowName('Context-Flow'),
      nodes: [{ id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } }],
      edges: [],
    });
    const flow = await res.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings and set the Flow Context (auto-saves on change)
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });
    const contextField = page.getByPlaceholder('Context for this specific flow...');
    await contextField.fill('This flow handles user onboarding.');
    await expect.poll(async () => {
      const res = await request.get(`${API_URL}/flows/${flow.id}`);
      if (!res.ok()) return null;
      return (await res.json()).flow_context;
    }, { timeout: 10000 }).toBe('This flow handles user onboarding.');
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── LLM Agent Config — Agent Contexts selector ─────────────
  // ═══════════════════════════════════════════════════════════════

  test('LLM agent config shows agent contexts checkbox list', async ({ page, request }) => {
    // Create an agent context
    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'Test Context', description: 'A test', content: 'Test content here.' },
    });
    const ctx = await ctxRes.json();
    cleanupContextIds.push(ctx.id);

    const flowRes = await createFlow(request, { name: uniqueFlowName('AC-Config-Test') });
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Add LLM Agent node
    await page.getByTestId('add-node-btn').click();
    await page.getByTestId('catalog-llm-agent').click();

    // Open the LLM Agent config
    await page.getByText('LLM Agent').first().click();
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });

    // Agent Contexts section should be visible with our context
    await expect(page.getByText('Agent Contexts')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Test Context')).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Context Layering in LLM Execution ──────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('context layering injects global + group + flow + agent contexts into LLM prompt', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Set up global context
    const globalRes = await request.put(`${API_URL}/settings/global-context`, {
      data: { value: 'You work for Acme Corp.' },
    });
    expect(globalRes.ok()).toBe(true);

    // Create a group with context
    const groupName = `Layer-Group-${Date.now()}`;
    const groupRes = await request.post(`${API_URL}/groups`, {
      data: { name: groupName, context: 'Answer customer support questions.' },
    });
    expect(groupRes.status()).toBe(201);
    const group = await groupRes.json();
    cleanupGroupIds.push(group.id);

    // Create an agent context
    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'Product Info', content: 'Widget Pro v2 is our main product.' },
    });
    expect(ctxRes.status()).toBe(201);
    const agentCtx = await ctxRes.json();
    cleanupContextIds.push(agentCtx.id);

    // Create the flow with all context layers
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Layer-Test'),
        group_id: group.id,
        flow_context: 'This is the billing flow.',
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          {
            id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 },
            data: {
              label: 'Assistant',
              type: 'llm-agent',
              config: {
                endpointId: mockEndpointId, model: 'mock-gpt-4',
                systemPrompt: 'ECHO_SYSTEM_PROMPT\nRespond to {{input.Trigger.message}}',
                temperature: 0.7, maxTokens: 1024, responseFormat: 'text',
                contextIds: [agentCtx.id],
              },
            },
          },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Assistant.content'] } } },
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

    // Execute in debug mode — the mock LLM will echo back the full system prompt
    const { debugExecute } = await import('./helpers/stream');
    const events = await debugExecute(flow.id, { message: 'test' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

    // The mock LLM echoed the full system prompt — verify all 5 layers are present
    expect(outputStr).toContain('You work for Acme Corp.');          // Layer 1: Global context
    expect(outputStr).toContain('Answer customer support questions.'); // Layer 2: Group context
    expect(outputStr).toContain('This is the billing flow.');          // Layer 3: Flow context
    expect(outputStr).toContain('Product Info');                        // Layer 4: Agent context title
    expect(outputStr).toContain('Widget Pro v2 is our main product.'); // Layer 4: Agent context content
    expect(outputStr).toContain('Respond to');                         // Layer 5: Node system prompt
    expect(outputStr).toContain('---');                                // Separators between layers
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Agent Contexts: Group filter on settings page ───────────
  // ═══════════════════════════════════════════════════════════════

  test('agent contexts group filter filters contexts by group', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `AC-Filter-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'Group-Scoped', content: 'Only for this group.', group_id: group.id },
    });
    expect(ctxRes.status()).toBe(201);
    const ctx = await ctxRes.json();
    cleanupContextIds.push(ctx.id);

    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Agent Contexts' }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Group-Scoped').first()).toBeVisible({ timeout: 5000 });

    await page.getByText('All groups').first().click();
    await page.getByText(group.name).first().click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Group-Scoped').first()).toBeVisible({ timeout: 5000 });
  });

  test('agent contexts search filters contexts by title', async ({ page, request }) => {
    const c1Res = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'Searchable-Pineapple', content: 'Fruit content.' },
    });
    const c2Res = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'Searchable-Banana', content: 'Other fruit.' },
    });
    expect(c1Res.status()).toBe(201);
    expect(c2Res.status()).toBe(201);
    const c1 = await c1Res.json();
    const c2 = await c2Res.json();
    cleanupContextIds.push(c1.id, c2.id);

    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Agent Contexts' }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Searchable-Pineapple').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Searchable-Banana').first()).toBeVisible();

    // Type in the search field
    await page.getByLabel('Search').fill('pineapple');
    await page.waitForTimeout(500);
    await expect(page.getByText('Searchable-Pineapple').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Searchable-Banana').first()).not.toBeVisible();

    // No matches shows the empty state
    await page.getByLabel('Search').fill('zzzz-no-match');
    await page.waitForTimeout(500);
    await expect(page.getByText('No agent contexts match your search')).toBeVisible({ timeout: 5000 });

    // Clearing restores the full list
    await page.getByLabel('Search').fill('');
    await page.waitForTimeout(500);
    await expect(page.getByText('Searchable-Banana').first()).toBeVisible({ timeout: 5000 });
  });

  // ─── Agent Contexts: sort + timestamps ─────────────────────────

  const openContextsTab = async (page: any) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Agent Contexts' }).click();
    await page.waitForTimeout(500);
  };

  const contextCards = (page: any) => page.locator('div.bg-surface.rounded-lg.border.p-4');

  test('agent contexts default sort is by last updated and cards show timestamps', async ({ page, request }) => {
    const c1 = await (await request.post(`${API_URL}/agent-contexts`, { data: { title: 'Sort-First', content: 'x' } })).json();
    const c2 = await (await request.post(`${API_URL}/agent-contexts`, { data: { title: 'Sort-Second', content: 'x' } })).json();
    const c3 = await (await request.post(`${API_URL}/agent-contexts`, { data: { title: 'Sort-Third', content: 'x' } })).json();
    cleanupContextIds.push(c1.id, c2.id, c3.id);

    // Bump c1's updated_at so it becomes the most recently updated
    await request.put(`${API_URL}/agent-contexts/${c1.id}`, { data: { title: 'Sort-First', content: 'x' } });

    await openContextsTab(page);

    // Default sort (Last updated) — the updated context is first
    await expect(contextCards(page).first()).toContainText('Sort-First', { timeout: 5000 });
    await expect(contextCards(page).first()).not.toContainText('Sort-Third');

    // Cards display created/updated timestamps
    await expect(contextCards(page).first()).toContainText('Created:', { timeout: 5000 });
    await expect(contextCards(page).first()).toContainText('Updated:');
  });

  test('agent contexts can be sorted by created date', async ({ page, request }) => {
    const mk = async (title: string) => {
      const c = await (await request.post(`${API_URL}/agent-contexts`, { data: { title, content: 'x' } })).json();
      cleanupContextIds.push(c.id);
      return c;
    };
    const c1 = await mk('Created-First');
    await new Promise(r => setTimeout(r, 30));
    const c2 = await mk('Created-Second');
    await new Promise(r => setTimeout(r, 30));
    const c3 = await mk('Created-Third');
    // Bump the FIRST-created context — it must NOT win the "Created" sort
    await request.put(`${API_URL}/agent-contexts/${c1.id}`, { data: { title: 'Created-First', content: 'x' } });

    await openContextsTab(page);

    // Switch the sort selector to "Created"
    await page.locator('[data-field-label="Sort"]').click();
    await page.getByRole('option', { name: 'Created' }).click();
    await page.waitForTimeout(500);

    // Newest created first: Created-Third, Created-Second, Created-First
    await expect(contextCards(page).nth(0)).toContainText('Created-Third', { timeout: 5000 });
    await expect(contextCards(page).nth(1)).toContainText('Created-Second');
    await expect(contextCards(page).nth(2)).toContainText('Created-First');
  });

  test('agent contexts form group selector assigns context to group', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `AC-Form-Group-${Date.now()}` } });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Agent Contexts' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'New Context' }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText('Group').first()).toBeVisible({ timeout: 5000 });

    await page.getByText('App-wide').first().click();
    await page.getByText(group.name).first().click();
    await page.waitForTimeout(300);
    await page.getByLabel('Title').fill('Group-Assigned');
    await page.locator('textarea').first().fill('Group content.');
    await page.locator('button.m3-button').filter({ hasText: 'Create' }).click();
    await page.waitForTimeout(1000);
    await expect(page.getByText('Group-Assigned').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(group.name).first()).toBeVisible({ timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Agent Context CRUD via UI ─────────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('edit an agent context via UI', async ({ page, request }) => {
    const origTitle = `Edit-Me-Context-${Date.now()}`;
    const newTitle = `Renamed-Context-${Date.now()}`;
    // Create a context via API, then edit it in the Agent Contexts tab
    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: origTitle, description: 'Original desc', content: 'Original content.' },
    });
    expect(ctxRes.status()).toBe(201);
    const ctx = await ctxRes.json();
    cleanupContextIds.push(ctx.id);

    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Agent Contexts' }).click();
    await expect(page.getByText(origTitle).first()).toBeVisible({ timeout: 5000 });

    // Click the edit icon button on the context card
    const card = page.locator('div.bg-surface.rounded-lg.border.p-4').filter({ hasText: origTitle }).first();
    await card
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'edit' }) })
      .click();

    // The form opens with the title prefilled
    await expect(page.getByLabel('Title')).toHaveValue(origTitle);
    await page.getByLabel('Title').fill(newTitle);

    // Save via the Update button
    await page.locator('button.m3-button').filter({ hasText: 'Update' }).click();
    await expect(page.getByText(newTitle).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(origTitle)).not.toBeVisible({ timeout: 5000 });

    // Backend reflects the rename
    const getRes = await request.get(`${API_URL}/agent-contexts/${ctx.id}`);
    expect(getRes.status()).toBe(200);
    const updated = await getRes.json();
    expect(updated.title).toBe(newTitle);
  });

  test('delete an agent context via UI', async ({ page, request }) => {
    const title = `Delete-Me-Context-${Date.now()}`;
    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title, content: 'Will be removed.' },
    });
    expect(ctxRes.status()).toBe(201);
    const ctx = await ctxRes.json();

    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: 'Agent Contexts' }).click();
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 5000 });

    // Click the delete icon button on the context card
    const card = page.locator('div.bg-surface.rounded-lg.border.p-4').filter({ hasText: title }).first();
    await card
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'delete' }) })
      .click();

    // Confirm in the dialog
    await expect(page.getByText('Delete context?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();

    // The context disappears from the list
    await expect(page.getByText(title)).not.toBeVisible({ timeout: 5000 });

    // Backend reflects the deletion
    const getRes = await request.get(`${API_URL}/agent-contexts/${ctx.id}`);
    expect(getRes.status()).toBe(404);
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Agent Context checkbox persistence in LLM config ───────
  // ═══════════════════════════════════════════════════════════════

  test('agent context checkbox persists across save and reload', async ({ page, request }) => {
    const ctxTitle = `Persist-Ctx-${Date.now()}`;
    // Create an agent context
    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: ctxTitle, description: 'Persistence test', content: 'Persisted content.' },
    });
    expect(ctxRes.status()).toBe(201);
    const ctx = await ctxRes.json();
    cleanupContextIds.push(ctx.id);

    const flowRes = await createFlow(request, { name: uniqueFlowName('AC-Persist-Test') });
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Add an LLM Agent node
    await page.getByTestId('add-node-btn').click();
    await page.getByTestId('catalog-llm-agent').click();

    // Open the LLM Agent config
    await page.getByText('LLM Agent').first().click();
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });

    // Check the context checkbox
    const checkbox = page
      .locator('label')
      .filter({ hasText: ctxTitle })
      .locator('input[type="checkbox"]')
      .first();
    await expect(checkbox).toBeVisible({ timeout: 5000 });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Close the node config modal (Radix Dialog hides the rest of the page,
    // which would make the editor Save button inaccessible to role queries)
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('node-config-modal')).not.toBeVisible();

    // Save the flow via the editor Save button and wait for the backend PUT
    const saveResponse = page.waitForResponse(
      (resp) => resp.url().includes(`/api/flows/${flow.id}`) && resp.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await page.getByRole('button', { name: 'Save' }).click();
    await saveResponse;

    // Backend received the contextIds
    const getRes = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(getRes.status()).toBe(200);
    const savedFlow = await getRes.json();
    const llmNode = savedFlow.nodes.find((n: any) => n.data?.type === 'llm-agent');
    expect(llmNode).toBeDefined();
    expect(llmNode.data.config.contextIds).toContain(ctx.id);

    // Reload the editor and reopen the LLM Agent config — the checkbox must still be checked
    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
    await page.getByText('LLM Agent').first().click();
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
    const checkboxAfter = page
      .locator('label')
      .filter({ hasText: ctxTitle })
      .locator('input[type="checkbox"]')
      .first();
    await expect(checkboxAfter).toBeChecked({ timeout: 5000 });
  });

  // ═══════════════════════════════════════════════════════════════
  // ─── Context layering in chat flows ─────────────────────────
  // ═══════════════════════════════════════════════════════════════

  test('chat flow injects attached agent context into the system prompt', async ({ page, request }) => {
    test.skip(!mockEndpointId, 'Mock LLM endpoint not available');

    // Create an agent context
    const ctxRes = await request.post(`${API_URL}/agent-contexts`, {
      data: { title: 'Chat-Flow-Ctx', content: 'Chat contexts give the assistant its expertise.' },
    });
    expect(ctxRes.status()).toBe(201);
    const agentCtx = await ctxRes.json();
    cleanupContextIds.push(agentCtx.id);

    // Create a chat flow with the context attached to the LLM agent node
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Chat-Context-Test'),
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'chat' } } },
          {
            id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 },
            data: {
              label: 'Assistant',
              type: 'llm-agent',
              config: {
                endpointId: mockEndpointId, model: 'mock-gpt-4',
                systemPrompt: 'ECHO_SYSTEM_PROMPT\nYou are a helpful chat assistant.',
                temperature: 0.7, maxTokens: 1024, responseFormat: 'text',
                contextIds: [agentCtx.id],
              },
            },
          },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Assistant.content'] } } },
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
    const events = await debugExecute(flow.id, { message: 'hello' }, cookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

    // The mock LLM echoed the full system prompt — the chat flow must include the attached context
    expect(outputStr).toContain('Chat-Flow-Ctx');
    expect(outputStr).toContain('Chat contexts give the assistant its expertise.');
    expect(outputStr).toContain('You are a helpful chat assistant.');
  });
});
