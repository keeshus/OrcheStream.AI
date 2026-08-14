import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import { getAdminAuthFile } from './helpers/auth';
import { setWebhookDeploymentViaUi } from './helpers/settings';
import { fillJsonSchema, selectOption } from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

// ─── OpenAPI / Swagger ────────────────────────────────────────────────────────
// The app exposes a dynamically generated OpenAPI document for every deployed
// webhook flow (GET /api/openapi.json) and a Swagger UI at /api/docs. The
// webhook flow is built through the real editor UI (trigger type, input
// schema, deployment path slug / rate limit / summary), and the rendered
// docs are verified through the flow card's API link.

test.describe('OpenAPI / Swagger', () => {
  test.describe.configure({ timeout: 180000 });

  let flowId: string;
  let flowName: string;
  let flowPage: any;
  let flowContext: any;
  const slug = `docs-${Date.now()}`;
  const summary = 'Weather lookup webhook';
  const inputSchema = '{"message":"string"}';

  test.beforeAll(async ({ browser, request }) => {
    // The flow is built through the editor UI once and shared by all tests;
    // `page` is a per-test fixture, so create the context manually here.
    flowContext = await browser.newContext({ storageState: getAdminAuthFile() });
    flowPage = await flowContext.newPage();

    // Build a webhook flow entirely through the editor UI: trigger switched
    // to Webhook, input schema set, deployment configured with path slug,
    // rate limit and summary, then saved.
    flowName = uniqueFlowName('Docs Flow');
    flowId = await createWebhookFlowViaUi(flowPage, flowName, slug, summary, inputSchema);
    expect(flowId).toBeTruthy();
    // Deployed state verified via the deployment contract (fixture check)
    const dep = await (await request.get(`${API_URL}/flows/${flowId}/deployment`)).json();
    expect(dep.pathSlug).toBe(slug);
    expect(dep.summary).toBe(summary);
  });

  test.afterAll(async ({ request }) => {
    await flowContext?.close().catch(() => {});
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('openapi.json is a valid document describing the webhook flow', async ({ request }) => {
    const res = await request.get(`${API_URL}/openapi.json`);
    expect(res.ok()).toBe(true);
    const spec = await res.json();

    // Document shape
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('OrcheStream.AI — Webhook Flows API');
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.paths).toBeDefined();
    expect(spec.components.securitySchemes.apiKey.scheme).toBe('bearer');

    // The deployed webhook flow appears as an executable endpoint
    const path = `/api/webhook/${slug}`;
    expect(spec.paths[path]).toBeDefined();
    expect(spec.paths[path].post.summary).toBe(summary);
    expect(spec.paths[path].post.operationId).toBe(`execute-${slug}`);
    expect(spec.paths[path].post.security).toEqual([{ apiKey: [] }]);

    // The input schema set in the editor is reflected in the request body
    const requestSchema = spec.paths[path].post.requestBody.content['application/json'].schema;
    expect(requestSchema.properties.message).toBeDefined();

    // Execution polling endpoints exist for the flow
    expect(spec.paths[`/api/webhook/${slug}/executions`]).toBeDefined();
    expect(spec.paths[`/api/webhook/${slug}/executions/{executionId}`]).toBeDefined();

    // The spec must never leak credentials or internal configuration
    const raw = JSON.stringify(spec);
    expect(raw).not.toContain('webhookSecret');
    expect(raw).not.toContain('api_key');
    expect(raw).not.toContain('myapp-api-key');
  });

  test('Swagger UI renders the webhook endpoint from the flow card API link', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('div.rounded-lg.border.p-4').filter({ has: page.getByText(flowName, { exact: true }) }).first();
    await expect(card).toBeVisible({ timeout: 10000 });

    // The card's API link opens the Swagger UI in a new tab
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 });
    await card.locator('a[href="/api/docs"]').click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await expect(popup).toHaveTitle(/Swagger UI/, { timeout: 10000 });

    // The rendered docs show the deployed endpoint and its summary
    await expect(popup.getByText(`/api/webhook/${slug}`).first()).toBeVisible({ timeout: 20000 });
    await expect(popup.getByText(summary).first()).toBeVisible({ timeout: 20000 });
  });

  test('trigger config links to the OpenAPI spec and Swagger UI once a path slug is set', async ({ page }) => {
    await page.goto(`/flows/${flowId}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Open the trigger config — the deployment section is visible with the
    // saved slug, and the spec links are rendered
    await page.evaluate(() => {
      for (const n of document.querySelectorAll('.react-flow__node')) {
        if (n.textContent && n.textContent.includes('Webhook')) { (n as HTMLElement).click(); return; }
      }
    });
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
    const section = page.getByTestId('webhook-deployment-settings');
    await expect(section).toBeVisible({ timeout: 5000 });
    await expect(section.getByTestId('webhook-path-slug')).toHaveValue(slug);

    // The spec links point at the right destinations
    const specLink = page.getByRole('link', { name: /openapi\.json/ });
    const uiLink = page.getByRole('link', { name: /Swagger UI/ });
    await expect(specLink).toBeVisible({ timeout: 5000 });
    await expect(uiLink).toBeVisible({ timeout: 5000 });

    // Opening the Swagger UI link lands on the docs page
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 });
    await uiLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await expect(popup).toHaveTitle(/Swagger UI/, { timeout: 10000 });
  });

  test('docs page serves the pinned Swagger UI bundle with SRI hashes', async ({ request }) => {
    const res = await request.get(`${API_URL}/docs`);
    expect(res.ok()).toBe(true);
    const html = await res.text();
    expect(html).toContain('swagger-ui');
    expect(html).toContain('swagger-ui-dist@5.32.11');
    expect(html).toContain('integrity=');
    expect(html).toContain("url: '/api/openapi.json'");
  });
});

/** Create a webhook flow via the editor UI and configure its deployment. */
async function createWebhookFlowViaUi(page: any, name: string, pathSlug: string, summary: string, inputSchema: string): Promise<string> {
  // Create the draft through the New Flow button
  await page.goto('/flows');
  await page.getByRole('button', { name: /New Flow/ }).first().click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
  const match = page.url().match(/\/flows\/([^/]+)\/edit/);
  if (!match) throw new Error(`Could not resolve flow id from URL: ${page.url()}`);
  const flowId = match[1];
  await page.getByLabel('Flow name').fill(name);

  // Switch the draft trigger to Webhook and set the input schema
  await page.evaluate(() => {
    for (const n of document.querySelectorAll('.react-flow__node')) {
      if (n.textContent && n.textContent.includes('Trigger')) { (n as HTMLElement).click(); return; }
    }
  });
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
  await selectOption(page, 'Trigger Type', 'Webhook');
  await fillJsonSchema(page, inputSchema);
  await page.getByTestId('node-config-modal').getByRole('button', { name: /Close$/ }).click();
  await expect(page.getByTestId('node-config-modal')).not.toBeVisible({ timeout: 5000 });

  // Configure the deployment (path slug, rate limit, summary)
  await setWebhookDeploymentViaUi(page, { pathSlug, rateLimit: '10', summary });

  // Save the flow and wait for the PUT to land
  await page.getByRole('button', { name: 'save Save' }).click();
  await page.waitForResponse(
    (r: any) => r.url().includes(`/api/flows/${flowId}`) && r.request().method() === 'PUT',
    { timeout: 10000 },
  ).catch(() => {});
  return flowId;
}
