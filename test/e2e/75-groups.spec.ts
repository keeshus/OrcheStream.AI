import { test, expect } from '@playwright/test';
import { registerUser, createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie, getAdminAuthFile } from './helpers/auth';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

test.describe('Groups feature', () => {
  let createdGroupIds: string[] = [];
  let cleanupUserIds: string[] = [];

  test.afterEach(async ({ playwright }) => {
    // The shared `request` fixture may hold a non-admin session if the test
    // logged the browser in as a reader/editor — admin-only deletes (groups,
    // users) need a dedicated admin context from the saved auth state.
    const adminCtx = await playwright.request.newContext({ storageState: getAdminAuthFile() });
    try {
      for (const gId of createdGroupIds) {
        await adminCtx.delete(`${API_URL}/groups/${gId}`).catch(() => {});
      }
      createdGroupIds = [];
      for (const uId of cleanupUserIds) {
        await adminCtx.delete(`${API_URL}/users/${uId}`).catch(() => {});
      }
      cleanupUserIds = [];
    } finally {
      await adminCtx.dispose();
    }
  });

  // ─── Settings page navigation ──────────────────────────────────────

  test('settings page shows Groups link', async ({ page }) => {
    await page.goto('/settings');
    const link = page.locator('a').filter({ hasText: 'Groups' }).first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/settings/groups');
  });

  test('settings page shows SSO link for admin', async ({ page }) => {
    await page.goto('/settings');
    const link = page.locator('a').filter({ hasText: 'SSO / OIDC' }).first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/settings/sso');
  });

  test('groups settings page loads', async ({ page }) => {
    await page.goto('/settings/groups');
    await expect(page.locator('h1').filter({ hasText: 'Groups' }).first()).toBeVisible({ timeout: 10000 });
  });

  // ─── Group CRUD via UI ─────────────────────────────────────────────

  test('create a group via UI', async ({ page }) => {
    await page.goto('/settings/groups');
    await expect(page.locator('h1').filter({ hasText: 'Groups' }).first()).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Create Group' }).first().click();
    await page.getByLabel('Name').fill('E2E UI Group');
    await page.getByLabel('Description').fill('Created during E2E test');
    await page.getByRole('button', { name: 'Create Group' }).last().click();

    await expect(page.getByText('E2E UI Group')).toBeVisible({ timeout: 5000 });
  });

  test('edit a group name via UI', async ({ page, request }) => {
    const res = await request.post(`${API_URL}/groups`, {
      data: { name: 'Edit Test Group', description: 'Will be renamed' },
    });
    expect(res.status()).toBe(201);
    const group = await res.json();
    createdGroupIds.push(group.id);

    await page.goto('/settings/groups');
    await expect(page.getByText('Edit Test Group')).toBeVisible({ timeout: 10000 });

    // Click the edit icon button (first button containing "edit" material icon)
    await page.locator('[data-testid="group-edit-btn"]').first().click();
    await expect(page.getByText('Edit Group')).toBeVisible();
    await page.getByLabel('Name').fill('Renamed Group');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('Renamed Group')).toBeVisible({ timeout: 5000 });
  });

  test('delete a group via UI', async ({ page, request }) => {
    const res = await request.post(`${API_URL}/groups`, {
      data: { name: 'Delete Test Group' },
    });
    expect(res.status()).toBe(201);
    const group = await res.json();
    createdGroupIds.push(group.id);

    await page.goto('/settings/groups');
    await expect(page.getByText('Delete Test Group')).toBeVisible({ timeout: 10000 });

    // Click delete button
    await page.locator('[data-testid="group-delete-btn"]').first().click();
    await expect(page.getByText('Delete group?')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByText('Delete Test Group')).not.toBeVisible({ timeout: 5000 });
    createdGroupIds = createdGroupIds.filter(id => id !== group.id);
  });

  test('expand group shows no members message', async ({ page, request }) => {
    const res = await request.post(`${API_URL}/groups`, {
      data: { name: 'Member Test Group' },
    });
    expect(res.status()).toBe(201);
    const group = await res.json();
    createdGroupIds.push(group.id);

    await page.goto('/settings/groups');
    await expect(page.getByText('Member Test Group')).toBeVisible({ timeout: 10000 });

    // Click group name to expand
    await page.getByText('Member Test Group').click();
    await expect(page.getByText('No members')).toBeVisible({ timeout: 5000 });
  });

  test('add and remove member from group', async ({ page, request }) => {
    const groupName = `Member-Add-Remove-${Date.now()}`;
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: groupName },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    const userName = `Add-Remove-User-${Date.now()}`;
    const userEmail = `addremove-${Date.now()}@test.local`;

    // Use fetch directly so the request fixture's admin cookie is preserved
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: userName, email: userEmail, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    await page.goto('/settings/groups');
    await expect(page.getByText(groupName)).toBeVisible({ timeout: 10000 });

    // Expand
    await page.getByText(groupName).click();
    await expect(page.getByText('No members')).toBeVisible();

    // Add member
    await page.getByText('+ Add member').click();
    await expect(page.getByText('Select a user to add')).toBeVisible();
    await page.getByText(userName).click();
    await expect(page.getByText(userName).first()).toBeVisible({ timeout: 5000 });

    // Remove the member via the UI — the member row has a close-icon button
    const memberRow = page.locator('div.flex.items-center.justify-between.px-2').filter({ hasText: userName }).first();
    await expect(memberRow).toBeVisible();
    await memberRow
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'close' }) })
      .click();

    // The member should disappear and the empty state returns
    await expect(page.getByText(userName)).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText('No members')).toBeVisible({ timeout: 5000 });

    // Backend state matches the UI
    const getRes = await request.get(`${API_URL}/groups/${group.id}`);
    expect(getRes.status()).toBe(200);
    const detail = await getRes.json();
    expect(detail.members.length).toBe(0);
  });

  test('make group admin via the group settings UI', async ({ page, request }) => {
    const groupName = `Member-Promote-${Date.now()}`;
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: groupName },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    const userName = `Promote-User-${Date.now()}`;
    const userEmail = `promote-${Date.now()}@test.local`;

    // Use fetch directly so the request fixture's admin cookie is preserved
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: userName, email: userEmail, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    // Add the user as a member via the API (UI member-add is covered above)
    const addRes = await request.post(`${API_URL}/groups/${group.id}/members`, {
      data: { userId: regData.user.id },
    });
    expect(addRes.status()).toBe(201);

    await page.goto('/settings/groups');
    await expect(page.getByText(groupName)).toBeVisible({ timeout: 10000 });
    await page.getByText(groupName).click();

    // The member row shows the "Make group admin" button (admin_panel_settings icon)
    const memberRow = page.locator('div.flex.items-center.justify-between.px-2').filter({ hasText: userName }).first();
    await expect(memberRow).toBeVisible({ timeout: 5000 });
    await memberRow
      .locator('button')
      .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'admin_panel_settings' }) })
      .click();

    // The "Admin" badge appears after promotion
    await expect(page.getByText('Admin', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Backend state matches: member now has role admin
    const getRes = await request.get(`${API_URL}/groups/${group.id}`);
    expect(getRes.status()).toBe(200);
    const detail = await getRes.json();
    const member = detail.members.find((m: any) => m.id === regData.user.id || m.userId === regData.user.id);
    expect(member).toBeDefined();
    expect(member.role).toBe('admin');
  });

  test('user role can be updated via the users page role dropdown', async ({ page, request }) => {
    const userName = `Role-Change-User-${Date.now()}`;
    const userEmail = `rolechange-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: userName, email: userEmail, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    // Sanity check: a newly registered user has the reader role
    const rolesRes = await request.get(`${API_URL}/roles`);
    expect(rolesRes.status()).toBe(200);
    const roles = await rolesRes.json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    expect(editorRole).toBeDefined();

    await page.goto('/settings/users');
    await expect(page.locator('h1').filter({ hasText: 'Users' }).first()).toBeVisible({ timeout: 10000 });

    // Find the user's row and change the role via the row's role dropdown
    const userRow = page.locator('tr').filter({ hasText: userEmail }).first();
    await expect(userRow).toBeVisible({ timeout: 5000 });
    await userRow.locator('[role="combobox"]').click();
    await page.getByRole('option', { name: 'editor' }).click();

    // The role change is persisted to the backend
    await expect.poll(async () => {
      const res = await request.get(`${API_URL}/users`);
      if (res.status() !== 200) return null;
      const users = await res.json();
      const u = users.find((x: any) => x.id === regData.user.id);
      return u?.role_name || null;
    }, { timeout: 5000 }).toBe('editor');
  });

  test('users page shows Groups column for admin', async ({ page }) => {
    await page.goto('/settings/users');
    await expect(page.locator('h1').filter({ hasText: 'Users' }).first()).toBeVisible({ timeout: 10000 });
    // The Groups column header should be visible
    await expect(page.locator('th').filter({ hasText: 'Groups' })).toBeVisible();
  });

  test('users page: create user modal validates and creates a user', async ({ page, request }) => {
    await page.goto('/settings/users');
    await expect(page.locator('h1').filter({ hasText: 'Users' }).first()).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Create User' }).first().click();
    await expect(page.getByRole('heading', { name: 'Create User' })).toBeVisible({ timeout: 5000 });

    // ── Empty submit → client-side validation ──
    await page.getByRole('button', { name: 'Create User', exact: true }).click();
    await expect(page.getByText('All fields required')).toBeVisible({ timeout: 5000 });

    // ── Short password → client-side validation ──
    await page.getByLabel('Name').fill('Modal User');
    await page.getByLabel('Email').fill(`modal-${Date.now()}@test.local`);
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create User', exact: true }).click();
    await expect(page.getByText('Password must be at least 8 characters')).toBeVisible({ timeout: 5000 });

    // ── Valid submit → row appears, admin session is NOT hijacked ──
    const email = `modal-${Date.now()}@test.local`;
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: 'Create User', exact: true }).click();

    const userRow = page.locator('tr').filter({ hasText: email }).first();
    await expect(userRow).toBeVisible({ timeout: 10000 });

    // The admin is still logged in as themselves (not the new user) — the
    // users settings page is still reachable and the admin user is listed.
    await expect(page.locator('h1').filter({ hasText: 'Users' }).first()).toBeVisible({ timeout: 5000 });
    const meRes = await page.request.get(`${API_URL}/auth/me`);
    expect(meRes.ok()).toBe(true);
    const me = await meRes.json();
    expect(me.user.email).not.toBe(email);

    // Registered user gets the reader role by default
    const usersRes = await request.get(`${API_URL}/users`);
    const users = await usersRes.json();
    const created = users.find((u: any) => u.email === email);
    expect(created).toBeDefined();
    cleanupUserIds.push(created.id);
    expect(created.role_name).toBe('reader');
  });

  test('users page: delete user via UI with confirm dialog', async ({ page, request }) => {
    // Create a disposable user via API
    const email = `del-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Delete Me', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    await page.goto('/settings/users');
    await expect(page.locator('h1').filter({ hasText: 'Users' }).first()).toBeVisible({ timeout: 10000 });

    const userRow = page.locator('tr').filter({ hasText: email }).first();
    await expect(userRow).toBeVisible({ timeout: 5000 });
    await userRow.getByRole('button', { name: 'Delete' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Delete user?')).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(page.locator('tr').filter({ hasText: email })).toHaveCount(0, { timeout: 5000 });

    // Backend confirms deletion
    const usersRes = await request.get(`${API_URL}/users`);
    const users = await usersRes.json();
    expect(users.find((u: any) => u.id === regData.user.id)).toBeUndefined();
    cleanupUserIds = cleanupUserIds.filter((id) => id !== regData.user.id);
  });

  test('users page: manage groups modal saves memberships', async ({ page, request }) => {
    // Create a group and a disposable user
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Groups-Modal-${Date.now()}` } });
    expect(gRes.ok()).toBe(true);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    const email = `gm-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Groups Modal', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    await page.goto('/settings/users');
    await expect(page.locator('h1').filter({ hasText: 'Users' }).first()).toBeVisible({ timeout: 10000 });

    const userRow = page.locator('tr').filter({ hasText: email }).first();
    await expect(userRow).toBeVisible({ timeout: 5000 });
    await userRow.getByRole('button', { name: 'Groups' }).click();

    const modal = page.getByText(`Groups for Groups Modal`).locator('..').locator('..');
    await expect(page.getByText(`Groups for Groups Modal`)).toBeVisible({ timeout: 5000 });
    // Check the group checkbox and save
    await page.getByText(group.name).first().click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(`Groups for Groups Modal`)).toHaveCount(0, { timeout: 5000 });

    // Backend: user is now a member of the group
    const gDetail = await (await request.get(`${API_URL}/groups/${group.id}`)).json();
    expect(gDetail.members.some((m: any) => m.userId === regData.user.id)).toBe(true);
  });

  test('groups page: demote a group admin back to member via UI', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, { data: { name: `Demote-${Date.now()}` } });
    expect(gRes.ok()).toBe(true);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Demote User', email: `demote-${Date.now()}@test.local`, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    // Add member, promote to admin via API
    await request.post(`${API_URL}/groups/${group.id}/members`, { data: { userId: regData.user.id } });
    await request.put(`${API_URL}/groups/${group.id}/members/${regData.user.id}/role`, { data: { role: 'admin' } });

    await page.goto('/settings/groups');
    await expect(page.getByText(group.name)).toBeVisible({ timeout: 10000 });
    await page.getByText(group.name).click();

    // Admin badge shown; click the "Demote to member" (person icon) button.
    // Member rows contain the member's name + email inside a member-specific
    // container — scope by the row that contains the member's email.
    const memberRow = page.locator('div.flex.items-center.justify-between.px-2').filter({ hasText: regData.user.email }).first();
    await expect(memberRow).toBeVisible({ timeout: 5000 });
    await expect(memberRow.getByText('Admin', { exact: true })).toBeVisible({ timeout: 5000 });

    // The demote button is the one with the person icon; use the icon's exact
    // ligature text within a button element to avoid matching the Admin badge.
    const demoteBtn = memberRow.locator('button').filter({ has: page.locator('span.material-symbols-outlined:text-is("person")') });
    await demoteBtn.click();

    // The backend role flips to member (the row re-renders after the update)
    await expect
      .poll(async () => {
        const res = await request.get(`${API_URL}/groups/${group.id}`);
        if (!res.ok()) return null;
        const detail = await res.json();
        const m = detail.members.find((x: any) => x.userId === regData.user.id);
        return m?.role;
      }, { timeout: 10000 })
      .toBe('member');

    // Admin badge disappears from the UI — re-locate the row fresh since the
    // members list re-renders after the role update.
    await expect
      .poll(async () => {
        const freshRow = page.locator('div.flex.items-center.justify-between.px-2').filter({ hasText: regData.user.email }).first();
        return (await freshRow.getByText('Admin', { exact: true }).count()) === 0;
      }, { timeout: 10000 })
      .toBe(true);
  });

  // ─── HITL node config ─────────────────────────────────────────────

  test('HITL node config shows group assignment option', async ({ page, request }) => {
    const flowName = uniqueFlowName('HITL-Group-Test');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        nodes: [
          { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'n2', type: 'hitl', position: { x: 0, y: 150 }, data: { label: 'HITL', type: 'hitl', config: { prompt: 'Approve?', buttons: [{ label: 'Approve', value: 'approved' }] } } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await page.getByText('HITL').first().click();
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });

    // Verify the Assignment type section with group option exists
    await expect(page.getByText('Assignment type', { exact: true })).toBeVisible();

    // Click the Assignment type select trigger to open the dropdown
    const assignTrigger = page.locator('[role="combobox"]').filter({ hasText: /Select assignment type|Specific user|Specific group/ }).first();
    await assignTrigger.click();

    // Verify "Specific group" option appears in the opened dropdown
    await expect(page.getByText('Specific group').first()).toBeVisible({ timeout: 3000 });

    await request.delete(`${API_URL}/flows/${flow.id}`);
  });

  // ─── Flow editor — group selector ──────────────────────────────────

  test('flow editor loads with group assigned flow', async ({ page, request }) => {
    // Create a group first
    const groupName = `Flow-Editor-Group-${Date.now()}`;
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: groupName },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    // Create flow with this group via API
    const flowName = uniqueFlowName('Group-Selector-Test');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        nodes: [{ id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } }],
        edges: [],
        group_id: group.id,
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    expect(flow.group_id).toBe(group.id);

    // Flow editor loads successfully
    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await deleteFlow(request, flow.id);
  });

  // ─── API-based CRUD tests ──────────────────────────────────────────

  test('GET /api/groups returns groups list', async ({ request }) => {
    const res = await request.get(`${API_URL}/groups`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('POST /api/groups creates a group', async ({ request }) => {
    const name = `API-Group-${Date.now()}`;
    const res = await request.post(`${API_URL}/groups`, {
      data: { name, description: 'API created' },
    });
    expect(res.status()).toBe(201);
    const group = await res.json();
    expect(group.name).toBe(name);
    expect(group.provider).toBe('local');
    createdGroupIds.push(group.id);
  });

  test('POST /api/groups rejects empty name', async ({ request }) => {
    const res = await request.post(`${API_URL}/groups`, {
      data: { name: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/groups rejects duplicate name', async ({ request }) => {
    const name = `Dup-Group-${Date.now()}`;
    const res1 = await request.post(`${API_URL}/groups`, { data: { name } });
    expect(res1.status()).toBe(201);
    const group = await res1.json();
    createdGroupIds.push(group.id);

    const res2 = await request.post(`${API_URL}/groups`, { data: { name } });
    expect(res2.status()).toBe(409);
  });

  test('PUT /api/groups updates a group', async ({ request }) => {
    const res = await request.post(`${API_URL}/groups`, {
      data: { name: `Update-Group-${Date.now()}` },
    });
    expect(res.status()).toBe(201);
    const group = await res.json();
    createdGroupIds.push(group.id);

    const updRes = await request.put(`${API_URL}/groups/${group.id}`, {
      data: { name: 'Updated Name', description: 'Updated desc' },
    });
    expect(updRes.status()).toBe(200);
    const updated = await updRes.json();
    expect(updated.name).toBe('Updated Name');
  });

  test('DELETE /api/groups deletes a group', async ({ request }) => {
    const res = await request.post(`${API_URL}/groups`, {
      data: { name: `Delete-Group-${Date.now()}` },
    });
    expect(res.status()).toBe(201);
    const group = await res.json();
    createdGroupIds.push(group.id);

    const delRes = await request.delete(`${API_URL}/groups/${group.id}`);
    expect(delRes.status()).toBe(200);

    const getRes = await request.get(`${API_URL}/groups/${group.id}`);
    expect(getRes.status()).toBe(404);
    createdGroupIds = createdGroupIds.filter(id => id !== group.id);
  });

  test('POST /api/groups/:id/members adds a member', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Member-API-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    // Use fetch directly so the request fixture's admin cookie is not overwritten
    const user = await registerUserClean(
      `apimember-${Date.now()}@test.local`, 'Test1234!', 'API Member',
    );
    cleanupUserIds.push(user.user.id);

    const mRes = await request.post(`${API_URL}/groups/${group.id}/members`, {
      data: { userId: user.user.id },
    });
    expect(mRes.status()).toBe(201);

    const getRes = await request.get(`${API_URL}/groups/${group.id}`);
    const detail = await getRes.json();
    expect(detail.members.length).toBe(1);
    expect(detail.members[0].userId).toBe(user.user.id);
  });

  test('DELETE /api/groups/:id/members/:userId removes a member', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Remove-API-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    const user = await registerUserClean(
      `removeapi-${Date.now()}@test.local`, 'Test1234!', 'Remove API',
    );
    cleanupUserIds.push(user.user.id);

    await request.post(`${API_URL}/groups/${group.id}/members`, {
      data: { userId: user.user.id },
    });

    const rmRes = await request.delete(`${API_URL}/groups/${group.id}/members/${user.user.id}`);
    expect(rmRes.status()).toBe(200);

    const getRes = await request.get(`${API_URL}/groups/${group.id}`);
    const detail = await getRes.json();
    expect(detail.members.length).toBe(0);
  });

  test('SSO config page loads and shows fields', async ({ page }) => {
    await page.goto('/settings/sso');
    await expect(page.locator('h1').filter({ hasText: 'SSO / OIDC' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel('Provider name')).toBeVisible();
    await expect(page.getByLabel('Group claim name')).toBeVisible();
  });

  // ─── Permission checks ─────────────────────────────────────────────

  test('reader cannot create groups and cannot access pending executions', async ({ page, request }) => {
    const readerEmail = `reader-${Date.now()}@test.local`;
    const regRes = await registerUser(request, {
      name: 'Reader Perm Test',
      email: readerEmail,
      password: 'Test1234!',
    });
    expect(regRes.ok()).toBe(true);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    // Login as reader to get browser cookies
    await page.goto('/login');
    await page.getByLabel('Email').fill(readerEmail);
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: /sign.?in/i }).click();

    // Reader should be redirected to /approvals
    await expect(page).toHaveURL(/\/approvals/);

    // Use page.request (has reader's cookies) to test API permissions
    const gRes = await page.request.post(`${API_URL}/groups`, {
      data: { name: `Should-Fail-${Date.now()}` },
    });
    expect(gRes.status()).toBe(403);

    // The reader role no longer grants execution:approve (destructive rights),
    // so the pending list is forbidden for readers.
    const pRes = await page.request.get(`${API_URL}/executions/pending`);
    expect(pRes.status()).toBe(403);
  });

  test('editor role can create flows but cannot access admin settings', async ({ page, request }) => {
    // Create an editor user via API — use fetch directly so the request
    // fixture's admin cookie is not overwritten by the register response cookie
    const editorEmail = `editor-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Editor Perm Test', email: editorEmail, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    // Assign the editor role via the admin API
    const rolesRes = await request.get(`${API_URL}/roles`);
    expect(rolesRes.status()).toBe(200);
    const roles = await rolesRes.json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    expect(editorRole).toBeDefined();
    const roleUpd = await request.put(`${API_URL}/users/${regData.user.id}/role`, {
      data: { role_id: editorRole.id },
    });
    expect(roleUpd.status()).toBe(200);

    // Login as editor in the browser
    await page.goto('/login');
    await page.getByLabel('Email').fill(editorEmail);
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: /sign.?in/i }).click();

    // Editors land on the flows page (unlike readers who are sent to /approvals)
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'New Flow' })).toBeVisible({ timeout: 10000 });

    // Editor CAN create a flow via the API (flow:create permission)
    const fRes = await page.request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Editor-Created-Flow'),
        nodes: [{ id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } }],
        edges: [],
      },
    });
    expect(fRes.status()).toBe(201);
    const createdFlow = await fRes.json();
    await request.delete(`${API_URL}/flows/${createdFlow.id}`);

    // Editor CAN open the flow editor (create UI)
    await page.goto('/flows/new/edit');
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Editor CANNOT see admin-only settings links
    await page.goto('/settings');
    await expect(page.locator('h1').filter({ hasText: 'Settings' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Users').first()).not.toBeVisible();
    await expect(page.getByText('SSO / OIDC').first()).not.toBeVisible();
    await expect(page.getByText('Secret Vaults').first()).not.toBeVisible();

    // Editor sees exactly the 6 non-admin hub cards (secrets, env vars,
    // endpoints, mcp-servers, knowledge, groups) — no admin-only cards
    const hubCards = page.locator('a[href^="/settings/"]');
    await expect(hubCards).toHaveCount(6, { timeout: 5000 });
    for (const card of ['Secrets', 'Environment Variables', 'LLM Endpoints', 'MCP Servers', 'Knowledge Bases', 'Groups']) {
      await expect(page.getByText(card, { exact: true }).first()).toBeVisible({ timeout: 5000 });
    }

    // Admin API endpoints reject the editor with 403
    const ssoRes = await page.request.get(`${API_URL}/admin/sso-config`);
    expect(ssoRes.status()).toBe(403);
    const usersRes = await page.request.get(`${API_URL}/users`);
    expect(usersRes.status()).toBe(403);
    const rolesAdminRes = await page.request.get(`${API_URL}/roles`);
    expect(rolesAdminRes.status()).toBe(403);
  });

  // Register a user WITHOUT affecting the request fixture's admin cookie
async function registerUserClean(email: string, password: string, name: string): Promise<any> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  return res.json();
}

// ─── Flow creation with group_id ────────────────────────────────────

  test('create flow with group_id via API', async ({ request }) => {
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Flow-Group-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    const flowName = uniqueFlowName('Group-Flow');
    const fRes = await createFlow(request, {
      name: flowName,
      group_id: group.id,
    });
    expect(fRes.ok()).toBe(true);
    const flow = await fRes.json();
    expect(flow.group_id).toBe(group.id);

    await deleteFlow(request, flow.id);
  });

  test('search filters groups on settings page', async ({ page, request }) => {
    const res1 = await request.post(`${API_URL}/groups`, {
      data: { name: 'Searchable Alpha Group' },
    });
    expect(res1.status()).toBe(201);
    const g1 = await res1.json();
    createdGroupIds.push(g1.id);

    const res2 = await request.post(`${API_URL}/groups`, {
      data: { name: 'Searchable Beta Group' },
    });
    expect(res2.status()).toBe(201);
    const g2 = await res2.json();
    createdGroupIds.push(g2.id);

    await page.goto('/settings/groups');
    await expect(page.getByText('Searchable Alpha Group')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Searchable Beta Group')).toBeVisible();

    const searchInput = page.getByLabel('Search groups');
    await searchInput.fill('Alpha');
    await expect(page.getByText('Searchable Alpha Group')).toBeVisible();
    await expect(page.getByText('Searchable Beta Group')).not.toBeVisible();
  });

  // ─── Duplicate group name rejection via UI ───────────────────────────

  test('duplicate group name shows error via UI', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: 'Unique Group Name For Dup Test' },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    await page.goto('/settings/groups');
    await expect(page.getByText('Create Group').first()).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Create Group' }).first().click();
    await page.getByLabel('Name').fill('Unique Group Name For Dup Test');
    await page.getByRole('button', { name: 'Create Group' }).last().click();

    await expect(page.getByText('A group with this name already exists')).toBeVisible({ timeout: 5000 });
  });

  // ─── Flow editor group selector save ─────────────────────────────────

  test('flow editor group selector saves group_id on save', async ({ page, request }) => {
    // Create a group
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Editor-Save-Group-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    // Create flow without group
    const flowName = uniqueFlowName('Editor-Group-Save');
    const fRes = await createFlow(request, { name: flowName });
    const flow = await fRes.json();

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open Flow Settings — the real group selector lives in this modal
    await page.getByTestId('flow-settings-btn').click();
    await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });

    // The Group SearchableSelect shows "No group" for an unassigned flow
    const groupTrigger = page.locator('button').filter({ hasText: 'No group' }).first();
    await expect(groupTrigger).toBeVisible();

    // Selecting a group in the UI auto-saves it (PUT /api/flows/:id) — no manual Save needed
    const saveResponse = page.waitForResponse(
      (resp) => resp.url().includes(`/api/flows/${flow.id}`) && resp.request().method() === 'PUT',
      { timeout: 10000 },
    );
    await groupTrigger.click();
    await page.getByText(group.name, { exact: true }).click();
    await saveResponse;

    // The UI now shows the selected group on the trigger
    await expect(page.locator('button').filter({ hasText: group.name }).first()).toBeVisible({ timeout: 5000 });

    // Backend persisted the group_id via the UI save
    const getRes = await request.get(`${API_URL}/flows/${flow.id}`);
    expect(getRes.status()).toBe(200);
    const saved = await getRes.json();
    expect(saved.group_id).toBe(group.id);

    await deleteFlow(request, flow.id);
  });

  // ─── Group-based flow visibility ─────────────────────────────────

  test('non-admin user sees only unassigned and own group flows', async ({ page, request }) => {
    // Create two groups
    const gARes = await request.post(`${API_URL}/groups`, {
      data: { name: `Group-A-${Date.now()}` },
    });
    expect(gARes.status()).toBe(201);
    const groupA = await gARes.json();
    createdGroupIds.push(groupA.id);

    const gBRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Group-B-${Date.now()}` },
    });
    expect(gBRes.status()).toBe(201);
    const groupB = await gBRes.json();
    createdGroupIds.push(groupB.id);

    // Create 3 flows: unassigned, assigned to A, assigned to B
    const f1Res = await createFlow(request, { name: uniqueFlowName('Unassigned-Flow') });
    const f2Res = await request.post(`${API_URL}/flows`, {
      data: { name: uniqueFlowName('Group-A-Flow'), group_id: groupA.id },
    });
    const f3Res = await request.post(`${API_URL}/flows`, {
      data: { name: uniqueFlowName('Group-B-Flow'), group_id: groupB.id },
    });
    expect(f1Res.ok()).toBe(true);
    expect(f2Res.ok()).toBe(true);
    expect(f3Res.ok()).toBe(true);
    const f1 = await f1Res.json();
    const f2 = await f2Res.json();
    const f3 = await f3Res.json();
    expect(f1.group_id).toBeNull();
    expect(f2.group_id).toBe(groupA.id);
    expect(f3.group_id).toBe(groupB.id);

    // Register a reader user and add them to Group A
    const readerEmail = `visibility-${Date.now()}@test.local`;
    const regData = await registerUserClean(readerEmail, 'Test1234!', 'Visibility Reader');
    cleanupUserIds.push(regData.user.id);

    // Add user to Group A via the groups API
    const addMemberRes = await request.post(`${API_URL}/groups/${groupA.id}/members`, {
      data: { userId: regData.user.id },
    });
    expect(addMemberRes.status()).toBe(201);

    // Login as reader
    await page.goto('/login');
    await page.getByLabel('Email').fill(readerEmail);
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: /sign.?in/i }).click();

    // Get the reader's cookie from browser context and make API call
    const cookies = await page.context().cookies();
    const tokenCookie = cookies.find(c => c.name === 'token');
    // Verify reader redirected to /approvals (confirmed reader role)
    await expect(page).toHaveURL(/\/approvals/);

    // Use page.evaluate to make the API call with actual browser cookies
    // This guarantees we use the reader's cookie, not the admin's from storage state
    const flowNames = await page.evaluate(async (apiUrl) => {
      const res = await fetch(`${apiUrl}/flows?limit=100`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.data.map((f: any) => f.name);
    }, API_URL);

    // The Group B flow should NOT be visible to a reader only in Group A
    expect(flowNames).not.toContain(f3.name);

    // The unassigned and Group A flows should be visible
    expect(flowNames).toContain(f1.name);
    expect(flowNames).toContain(f2.name);

    // Cleanup flows
    await request.delete(`${API_URL}/flows/${f1.id}`);
    await request.delete(`${API_URL}/flows/${f2.id}`);
    await request.delete(`${API_URL}/flows/${f3.id}`);
  });

  // ─── Group-based execution approval filtering ────────────────────────

  test('pending executions filtered by group membership', async ({ page, request }) => {
    // Create a group
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `HITL-Group-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    createdGroupIds.push(group.id);

    // Create a flow with HITL assigned to this group and group_id set
    const flowName = uniqueFlowName('HITL-Visibility');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        group_id: group.id,
        nodes: [
          { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'n2', type: 'hitl', position: { x: 0, y: 150 }, data: { label: 'HITL', type: 'hitl', config: { prompt: 'Approve?', buttons: [{ label: 'Approve', value: 'approved' }], assignmentType: 'group', assignedGroupId: group.id } } },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    expect(flow.group_id).toBe(group.id);

    // Execute the flow as admin (get the auth cookie from storage state)
    const adminCookie = getAuthCookie();
    const execRes = await fetch(`${API_URL}/flows/${flow.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie || '' },
      body: JSON.stringify({ input: {}, _debug: false }),
    });
    expect(execRes.ok).toBe(true);
    const events = await (await import('./helpers/stream')).readSSE(execRes);
    const started = events.find((e: any) => e.type === 'execution.started');
    expect(started).toBeDefined();
    const executionId = (started as any)?.executionId || started?.data?.executionId || '';

    // Persisted runs pause on the worker — poll until the execution is awaiting approval
    for (let i = 0; i < 30; i++) {
      const r = await request.get(`${API_URL}/executions/${executionId}`);
      if (r.ok()) {
        const exec = await r.json();
        if (exec.status === 'awaiting_approval') break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    const pausedExec = await (await request.get(`${API_URL}/executions/${executionId}`)).json();
    expect(pausedExec.status).toBe('awaiting_approval');

    // Register a member who is in this group and promote them to editor so
    // they hold execution:approve (the reader role no longer has it)
    const memberEmail = `hitl-member-${Date.now()}@test.local`;
    const memberData = await registerUserClean(memberEmail, 'Test1234!', 'HITL Member');
    cleanupUserIds.push(memberData.user.id);
    const allRoles = await (await request.get(`${API_URL}/roles`)).json();
    const editorRole = allRoles.find((r: any) => r.name === 'editor');
    if (editorRole) {
      await request.put(`${API_URL}/users/${memberData.user.id}/role`, { data: { role_id: editorRole.id } });
    }

    // Add member via groups API
    const addMember = await request.post(`${API_URL}/groups/${group.id}/members`, {
      data: { userId: memberData.user.id },
    });
    expect(addMember.status()).toBe(201);

    // Login as the member (editor role)
    await page.goto('/login');
    await page.getByLabel('Email').fill(memberEmail);
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: /sign.?in/i }).click();

    // Member should see the pending execution
    const readerExecIds = await page.evaluate(async (apiUrl) => {
      const res = await fetch(`${apiUrl}/executions/pending`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((e: any) => e.id);
    }, API_URL);
    expect(readerExecIds).toContain(executionId);

    // Register a second user who is NOT in this group and has no approval rights
    const outsiderEmail = `outsider-${Date.now()}@test.local`;
    const outsiderData = await registerUserClean(outsiderEmail, 'Test1234!', 'Outsider');
    cleanupUserIds.push(outsiderData.user.id);

    // Login as outsider
    await page.goto('/login');
    await page.getByLabel('Email').fill(outsiderEmail);
    await page.getByLabel('Password', { exact: true }).fill('Test1234!');
    await page.getByRole('button', { name: /sign.?in/i }).click();
    // Verify redirected to /approvals (confirmed login as non-admin)
    await expect(page).toHaveURL(/\/approvals/);

    // Outsider is a reader and must NOT be able to list pending executions at all
    const result = await page.evaluate(async (apiUrl) => {
      const meRes = await fetch(`${apiUrl}/auth/me`, { credentials: 'include' });
      const me = meRes.ok ? await meRes.json() : null;
      const pRes = await fetch(`${apiUrl}/executions/pending`, { credentials: 'include' });
      return {
        userId: me?.user?.userId,
        role: me?.user?.role,
        groups: me?.user?.groups,
        pendingStatus: pRes.status,
      };
    }, API_URL);
    expect(result.role).toBe('reader');
    expect(result.groups).toEqual([]);
    expect(result.pendingStatus).toBe(403);

    // Cleanup: cancel execution
    await request.delete(`${API_URL}/executions/${executionId}`);
    await request.delete(`${API_URL}/flows/${flow.id}`);
  });

  // ─── Group flow execution ─────────────────────────────────

  test('flow assigned to a group executes correctly through the engine', async ({ request }) => {
    // Create a group
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Exec-Group-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();

    // Create a flow with group_id and a code node to verify engine processes it
    const flowName = uniqueFlowName('Group-Exec');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        group_id: group.id,
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Transform', type: 'code', config: { code: 'return { message: (input.t1.message || "") + " processed", groupId: "' + group.id + '" }' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Transform.message', 'Transform.groupId'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
          { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();

    // Execute in debug mode
    const { debugExecute } = await import('./helpers/stream');
    const adminCookie = getAuthCookie() || undefined;
    const events = await debugExecute(flow.id, { message: 'group-test' }, adminCookie);

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    expect(outputStr).toContain('processed');
    expect(outputStr).toContain(group.id);

    await request.delete(`${API_URL}/groups/${group.id}`);
    await deleteFlow(request, flow.id);
  });

  // ─── Group context ─────────────────────────────────

  test('group context: admin and group admin can set context, member cannot', async ({ playwright, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Ctx-API-Group-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();

    const adminEmail = `ctx-admin-${Date.now()}@test.local`;
    const memberEmail = `ctx-member-${Date.now()}@test.local`;
    const adminRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ctx Admin', email: adminEmail, password: 'Test1234!' }),
    });
    expect(adminRes.status).toBe(201);
    const adminUser = await adminRes.json();
    const memberRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ctx Member', email: memberEmail, password: 'Test1234!' }),
    });
    expect(memberRes.status).toBe(201);
    const memberUser = await memberRes.json();
    cleanupUserIds.push(adminUser.user.id, memberUser.user.id);

    const rolesRes = await request.get(`${API_URL}/roles`);
    const roles = await rolesRes.json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${adminUser.user.id}/role`, { data: { role_id: editorRole.id } });
    await request.put(`${API_URL}/users/${memberUser.user.id}/role`, { data: { role_id: editorRole.id } });
    await request.post(`${API_URL}/groups/${group.id}/members`, { data: { userId: adminUser.user.id } });
    await request.put(`${API_URL}/groups/${group.id}/members/${adminUser.user.id}/role`, { data: { role: 'admin' } });
    await request.post(`${API_URL}/groups/${group.id}/members`, { data: { userId: memberUser.user.id } });

    try {
      // Admin sets the group context
      const setRes = await request.put(`${API_URL}/groups/${group.id}/context`, {
        data: { context: 'Admin context text' },
      });
      expect(setRes.status()).toBe(200);
      expect((await setRes.json()).context).toBe('Admin context text');

      // Admin reads it back
      const getRes = await request.get(`${API_URL}/groups/${group.id}/context`);
      expect(getRes.status()).toBe(200);
      expect((await getRes.json()).context).toBe('Admin context text');

      // Group admin can update their own group's context
      const adminCtx = await playwright.request.newContext();
      await adminCtx.post(`${API_URL}/auth/login`, { data: { email: adminEmail, password: 'Test1234!' } });
      const setByGroupAdmin = await adminCtx.put(`${API_URL}/groups/${group.id}/context`, {
        data: { context: 'Group admin context text' },
      });
      expect(setByGroupAdmin.status()).toBe(200);
      expect((await setByGroupAdmin.json()).context).toBe('Group admin context text');

      // Group admin can read it
      const getByGroupAdmin = await adminCtx.get(`${API_URL}/groups/${group.id}/context`);
      expect(getByGroupAdmin.status()).toBe(200);
      expect((await getByGroupAdmin.json()).context).toBe('Group admin context text');
      await adminCtx.dispose();

      // Plain member can read but cannot update
      const memberCtx = await playwright.request.newContext();
      await memberCtx.post(`${API_URL}/auth/login`, { data: { email: memberEmail, password: 'Test1234!' } });
      const getByMember = await memberCtx.get(`${API_URL}/groups/${group.id}/context`);
      expect(getByMember.status()).toBe(200);
      const setByMember = await memberCtx.put(`${API_URL}/groups/${group.id}/context`, {
        data: { context: 'Member attempt' },
      });
      expect(setByMember.status()).toBe(403);
      await memberCtx.dispose();

      // Context unchanged after the member's rejected attempt
      const afterRes = await request.get(`${API_URL}/groups/${group.id}/context`);
      expect((await afterRes.json()).context).toBe('Group admin context text');
    } finally {
      await request.delete(`${API_URL}/groups/${group.id}`).catch(() => {});
    }
  });

  test('global-context page: group admin can edit their group context', async ({ page, request }) => {
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: `Ctx-UI-Group-${Date.now()}` },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();

    const email = `ctx-ui-${Date.now()}@test.local`;
    const regRes = await fetch(`${API_URL}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ctx UI Admin', email, password: 'Test1234!' }),
    });
    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    cleanupUserIds.push(regData.user.id);

    const rolesRes = await request.get(`${API_URL}/roles`);
    const roles = await rolesRes.json();
    const editorRole = roles.find((r: any) => r.name === 'editor');
    await request.put(`${API_URL}/users/${regData.user.id}/role`, { data: { role_id: editorRole.id } });
    await request.post(`${API_URL}/groups/${group.id}/members`, { data: { userId: regData.user.id } });
    await request.put(`${API_URL}/groups/${group.id}/members/${regData.user.id}/role`, { data: { role: 'admin' } });

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

      // The settings index shows the Global Context link for group admins
      await page.goto('/settings');
      await expect(page.locator('a').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });

      await page.goto('/settings/global-context');
      await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });

      // Global scope is read-only for non-admins
      const globalTextarea = page.locator('textarea');
      await expect(globalTextarea).toBeDisabled({ timeout: 5000 });
      await expect(page.getByText('All groups').first()).toBeVisible();

      // Select the group — the group context is editable by the group admin
      await page.getByText('All groups').first().click();
      await page.getByText(group.name, { exact: true }).first().click();
      await expect(globalTextarea).toBeEnabled({ timeout: 5000 });

      await globalTextarea.fill('Group context set via UI');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Context saved for/)).toBeVisible({ timeout: 5000 });

      // Verify persisted via API
      const ctxRes = await request.get(`${API_URL}/groups/${group.id}/context`);
      expect(ctxRes.status()).toBe(200);
      expect((await ctxRes.json()).context).toBe('Group context set via UI');
    } finally {
      await request.delete(`${API_URL}/groups/${group.id}`).catch(() => {});
    }
  });
});
