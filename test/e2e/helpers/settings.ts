import { expect } from '@playwright/test';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

// ─────────────────────────────────────────────────────────────────────────────
// Settings-page UI helpers. Every action drives the real interface; the API is
// only used to verify persistence where the UI cannot show it.
// ─────────────────────────────────────────────────────────────────────────────

/** Select a group in a SearchableSelect "Filter by group" control. */
export async function selectGroupFilter(page: any, groupName: string) {
  await page.getByText('All items').first().click();
  await page.getByText(groupName, { exact: true }).first().click();
}

// ─── Secrets page (/settings/secrets) ────────────────────────────────────────

export async function createSecretViaUi(
  page: any,
  { name, value, groupName }: { name: string; value: string; groupName?: string },
) {
  await page.goto('/settings/secrets');
  await expect(page.getByRole('button', { name: 'Add Secret' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Add Secret' }).click();
  await expect(page.getByRole('heading', { name: 'New Secret' })).toBeVisible({ timeout: 5000 });
  if (groupName) {
    const form = page.getByRole('heading', { name: 'New Secret' }).locator('..');
    await form.getByRole('button', { name: /App-wide/ }).click();
    await page.getByRole('button', { name: groupName, exact: true }).last().click();
    await expect(page.getByRole('button', { name: 'CyberArk', exact: true })).toBeVisible({ timeout: 5000 });
  }
  await page.getByLabel('Secret name').fill(name);
  await page.getByLabel('Value').fill(value);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
}

export async function editSecretViaUi(page: any, name: string, newValue: string) {
  await page.goto('/settings/secrets');
  const row = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.getByTestId('edit-secret-btn').click();
  await expect(page.getByTestId('edit-secret-value')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('edit-secret-value').fill(newValue);
  await page.getByTestId('save-secret-value').click();
  await expect(page.getByTestId('save-secret-value')).toHaveCount(0, { timeout: 5000 });
}

export async function revealSecretViaUi(page: any, name: string, expectedValue: string) {
  await page.goto('/settings/secrets');
  const row = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row
    .locator('button')
    .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'visibility' }) })
    .click();
  await expect(page.getByText('Reveal secret?')).toBeVisible();
  await page.getByRole('button', { name: 'Reveal' }).click();
  await expect(page.getByText(new RegExp(expectedValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible({ timeout: 5000 });
}

export async function deleteSecretViaUi(page: any, name: string) {
  await page.goto('/settings/secrets');
  const row = page.locator('div.flex.items-center.justify-between.bg-surface.rounded-lg.border.px-4').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row
    .locator('button')
    .filter({ has: page.locator('span.material-symbols-outlined', { hasText: 'delete' }) })
    .click();
  await expect(page.getByText('Delete secret?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(name)).not.toBeVisible({ timeout: 5000 });
}

export async function rotateKeyViaUi(page: any) {
  await page.goto('/settings/secrets');
  await expect(page.getByRole('button', { name: 'Rotate Key' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Rotate Key' }).click();
  await expect(page.getByText('Rotate encryption key?')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Rotate' }).click();
  await expect(page.getByRole('button', { name: 'Rotate Key' })).toBeVisible({ timeout: 5000 });
}

// ─── Secret vaults page (/settings/secret-vaults) ────────────────────────────

export async function createVaultViaUi(
  page: any,
  { name, url, login, apiKey, groupName }: { name: string; url: string; login: string; apiKey: string; groupName: string },
) {
  await page.goto('/settings/secret-vaults');
  await expect(page.getByRole('button', { name: 'Add Vault' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Add Vault' }).click();
  await expect(page.getByLabel('Name')).toBeVisible({ timeout: 5000 });
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('URL').fill(url);
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('API Key').fill(apiKey);
  await page.getByRole('button', { name: 'Bind to group (required)' }).click();
  await page.getByText(groupName, { exact: true }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Create Vault' }).click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
}

export async function testVaultViaUi(page: any, name: string) {
  await page.goto('/settings/secret-vaults');
  const card = page.locator('div.bg-surface.rounded-lg.border.border-outline-variant.p-4').filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.getByRole('button', { name: /Test/i }).click();
  await expect(card.locator('span.material-symbols-outlined', { hasText: 'check_circle' })).toBeVisible({ timeout: 10000 });
}

export async function deleteVaultViaUi(page: any, name: string) {
  await page.goto('/settings/secret-vaults');
  const card = page.locator('div.bg-surface.rounded-lg.border.border-outline-variant.p-4').filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Delete vault?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(name)).not.toBeVisible({ timeout: 5000 });
}

// ─── Global context page (/settings/global-context) ──────────────────────────

export async function saveGlobalContextViaUi(page: any, text: string) {
  await page.goto('/settings/global-context');
  await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });
  const textarea = page.locator('textarea').first();
  await expect(textarea).toBeEnabled({ timeout: 5000 });
  await textarea.fill(text);
  await page.getByRole('button', { name: /Save/ }).click();
  await expect(page.getByText('Global context saved')).toBeVisible({ timeout: 5000 });
}

export async function saveGroupContextViaUi(page: any, groupName: string, text: string) {
  await page.goto('/settings/global-context');
  await expect(page.locator('h1').filter({ hasText: 'Global Context' }).first()).toBeVisible({ timeout: 10000 });
  await page.getByText('All groups').first().click();
  await page.getByText(groupName, { exact: true }).first().click();
  const textarea = page.locator('textarea');
  await expect(textarea).toBeEnabled({ timeout: 5000 });
  await textarea.fill(text);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Context saved for/)).toBeVisible({ timeout: 5000 });
}

// ─── Approvals page (/approvals) ─────────────────────────────────────────────

/** Approve the pending approval card for a flow (matched by flow name). */
export async function approvePendingViaUi(page: any, flowName: string, feedback?: string) {
  await page.goto('/approvals');
  const card = page.locator('div.bg-surface.rounded-xl.border.p-5').filter({ hasText: flowName }).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  if (feedback !== undefined) {
    await card.getByLabel('Feedback').fill(feedback);
  }
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).not.toBeVisible({ timeout: 10000 });
}

export async function rejectPendingViaUi(page: any, flowName: string) {
  await page.goto('/approvals');
  const card = page.locator('div.bg-surface.rounded-xl.border.p-5').filter({ hasText: flowName }).first();
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card).not.toBeVisible({ timeout: 10000 });
}

export async function expectApprovalsEmptyViaUi(page: any) {
  await page.goto('/approvals');
  await expect(page.getByText('All caught up!')).toBeVisible({ timeout: 10000 });
}

// ─── Run history (/flows/:id/executions) ─────────────────────────────────────

export async function deleteExecutionViaUi(page: any, flowId: string) {
  await page.goto(`/flows/${flowId}/executions`);
  const row = page.locator('div.bg-surface.rounded-lg.border.p-4').first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Delete execution?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No executions yet')).toBeVisible({ timeout: 10000 });
}

// ─── Profile page (/profile) ─────────────────────────────────────────────────

export async function renameProfileViaUi(page: any, name: string) {
  await page.goto('/profile');
  await expect(page.getByLabel('Name')).toBeVisible({ timeout: 10000 });
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Profile updated')).toBeVisible({ timeout: 5000 });
}

export async function changePasswordViaUi(page: any, current: string, next: string) {
  await page.goto('/profile');
  await expect(page.getByLabel('Current Password')).toBeVisible({ timeout: 10000 });
  await page.getByLabel('Current Password').fill(current);
  await page.getByLabel('New Password', { exact: true }).fill(next);
  await page.getByLabel('Confirm New Password').fill(next);
  await page.getByRole('button', { name: 'Update Password' }).click();
  await expect(page.getByText('Password updated')).toBeVisible({ timeout: 5000 });
}

// ─── Chat sessions page (/chat/:flowId) ──────────────────────────────────────

export async function createChatSessionViaUi(page: any, flowId: string): Promise<string> {
  await page.goto(`/chat/${flowId}`);
  await page.getByRole('button', { name: 'New Chat' }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}\/[0-9a-f-]{36}/, { timeout: 10000 });
  return page.url().split('/').pop() as string;
}

export async function deleteChatSessionViaUi(page: any, flowId: string, title: string) {
  await page.goto(`/chat/${flowId}`);
  const row = page.locator('div.bg-surface.rounded-lg.border.border-outline-variant.p-4').filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Delete chat?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(row).not.toBeVisible({ timeout: 5000 });
}

/** The backend titles new chat sessions "New Chat" (chat.ts). */
export const CHAT_SESSION_DEFAULT_TITLE = 'New Chat';

// ─── Agent contexts (home page tab) ──────────────────────────────────────────

export async function openAgentContextsTab(page: any) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent Contexts' }).click();
  await page.waitForTimeout(500);
}

export async function createAgentContextViaUi(
  page: any,
  { title, content, groupName }: { title: string; content: string; groupName?: string },
) {
  await openAgentContextsTab(page);
  await page.getByRole('button', { name: 'New Context' }).click();
  await page.waitForTimeout(500);
  if (groupName) {
    await page.getByText('App-wide').first().click();
    await page.getByText(groupName, { exact: true }).first().click();
    await page.waitForTimeout(300);
  }
  await page.getByLabel('Title').fill(title);
  await page.locator('textarea').first().fill(content);
  await page.locator('button.m3-button').filter({ hasText: 'Create' }).click();
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 5000 });
}

// ─── Flow editor: webhook deployment + chat API ──────────────────────────────

/** Open the trigger node's config modal on the flow editor. */
async function openTriggerConfig(page: any) {
  // A previous config modal may still be open — dismiss it first.
  if (await page.getByTestId('node-config-modal').isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('node-config-modal')).not.toBeVisible({ timeout: 5000 });
  }
  await page.getByText('Trigger').first().click();
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
}

async function closeNodeConfig(page: any) {
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('node-config-modal')).not.toBeVisible({ timeout: 5000 });
}

export async function setWebhookDeploymentViaUi(
  page: any,
  { pathSlug, rateLimit, summary }: { pathSlug: string; rateLimit: string; summary: string },
) {
  await openTriggerConfig(page);
  const section = page.getByTestId('webhook-deployment-settings');
  await expect(section).toBeVisible({ timeout: 5000 });
  await section.getByTestId('webhook-path-slug').fill(pathSlug);
  await section.getByTestId('webhook-rate-limit').fill(rateLimit);
  await section.getByTestId('webhook-summary').fill(summary);
  await section.getByTestId('webhook-save-deployment').click();
  await expect(section.getByTestId('webhook-deploy-saved')).toBeVisible({ timeout: 5000 });
  await closeNodeConfig(page);
}

export async function renewWebhookKeyViaUi(page: any) {
  await openTriggerConfig(page);
  await page.getByRole('button', { name: 'Renew Key' }).click();
  const code = page.locator('code.font-mono.break-all').filter({ hasText: /wh_/ }).first();
  await expect(code).toBeVisible({ timeout: 5000 });
  const rawKey = (await code.textContent())?.trim() || '';
  await closeNodeConfig(page);
  return rawKey;
}

export async function revokeWebhookKeyViaUi(page: any) {
  await openTriggerConfig(page);
  await page.getByRole('button', { name: 'Revoke Key' }).click();
  await expect(page.getByRole('button', { name: 'Revoke Key' })).toHaveCount(0, { timeout: 5000 });
  await closeNodeConfig(page);
}

/** Drive the Chat API panel inside Flow Settings (chat flows only). */
async function openChatApiPanel(page: any) {
  // A previous Flow Settings modal may still be open — dismiss it first.
  const modal = page.locator('[data-co-pilot-modal="flow-settings"]');
  if (await modal.isVisible().catch(() => false)) {
    await modal.click({ position: { x: 5, y: 5 } });
    await expect(modal).not.toBeVisible({ timeout: 5000 });
  }
  await page.getByTestId('flow-settings-btn').click();
  await expect(page.getByText('Flow Settings')).toBeVisible({ timeout: 5000 });
  const header = page.locator('span', { hasText: 'Chat API (OpenAI-compatible)' }).first();
  await expect(header).toBeVisible({ timeout: 5000 });
  return page;
}

async function closeChatApiPanel(page: any) {
  const modal = page.locator('[data-co-pilot-modal="flow-settings"]');
  await modal.click({ position: { x: 5, y: 5 } });
  await expect(modal).not.toBeVisible({ timeout: 5000 });
}

export async function enableChatApiViaUi(page: any, modelName: string) {
  await openChatApiPanel(page);
  // The toggle renders before the deployment fetch resolves and would flip
  // back when it lands — wait for the loaded form (Model Name input) first.
  const modelInput = page.getByPlaceholder('e.g. gpt-4o');
  await expect(modelInput).toBeVisible({ timeout: 5000 });
  const toggle = page.locator('input.toggle');
  await expect(toggle).toBeEnabled({ timeout: 5000 });
  if (!(await toggle.isChecked())) await toggle.check();
  await expect(page.getByText('Enabled', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  await modelInput.fill(modelName);
  await modelInput.blur();
  const flowId = page.url().match(/\/flows\/([0-9a-f-]{36})\//)?.[1];
  expect(flowId).toBeTruthy();
  await expect.poll(async () => {
    const res = await page.request.get(`${API_URL}/flows/${flowId}/chat-api/deployment`);
    if (!res.ok()) return null;
    return (await res.json()).model_name;
  }, { timeout: 5000 }).toBe(modelName);
  await closeChatApiPanel(page);
}

export async function createChatApiKeyViaUi(page: any, label: string): Promise<string> {
  await openChatApiPanel(page);
  await page.getByPlaceholder('Key label (optional)').fill(label);
  await page.getByRole('button', { name: 'Generate' }).click();
  const code = page.locator('code.font-mono.break-all').filter({ hasText: /ca_/ }).first();
  await expect(code).toBeVisible({ timeout: 5000 });
  const rawKey = (await code.textContent())?.trim() || '';
  await closeChatApiPanel(page);
  return rawKey;
}

export async function deleteChatApiKeyViaUi(page: any) {
  await openChatApiPanel(page);
  const row = page.locator('div.flex.items-center.justify-between.bg-surface-container.rounded').first();
  await expect(row).toBeVisible({ timeout: 5000 });
  await row.locator('button').click();
  await expect(page.getByText('Delete API Key')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Delete' }).last().click();
  await expect(page.locator('div.flex.items-center.justify-between.bg-surface-container.rounded').first()).toHaveCount(0, { timeout: 5000 });
  await closeChatApiPanel(page);
}
