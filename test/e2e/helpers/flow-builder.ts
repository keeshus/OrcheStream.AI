import { expect, type Page } from '@playwright/test';

/**
 * UI-driven flow building and running for E2E tests.
 *
 * Everything here goes through the real editor interface — catalog clicks,
 * canvas handle drags, config modal form fields, the Save button and the
 * debug run overlay. Nothing pokes the API except optional save verification.
 */

/** A node as built through the editor UI. */
export interface UiNodeSpec {
  /** Catalog type, e.g. 'trigger', 'llm-agent', 'code', 'ai-action'. */
  type: string;
  /** Label shown on the canvas (renamed via the config modal). */
  label: string;
  /** Optional config fields to set via the config modal form. */
  config?: Record<string, any>;
}

/**
 * Create a new flow from the overview page ("New Flow" button) and rename it.
 * Returns the flow id parsed from the editor URL.
 */
export async function createFlowViaUi(page: Page, name: string): Promise<string> {
  await page.goto('/flows');
  await page.getByText('New Flow').first().click();
  await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });
  await page.getByLabel('Flow name').fill(name);
  await saveFlow(page);
  const match = page.url().match(/\/flows\/([^/]+)\/edit/);
  if (!match) throw new Error(`Could not resolve flow id from URL: ${page.url()}`);
  return match[1];
}

/** Locate a canvas node by its exact label. */
export function nodeByLabel(page: Page, label: string) {
  return page.locator('.react-flow__node').filter({ has: page.getByText(label, { exact: true }) }).first();
}

/** Click a node once to select it. */
export async function clickNode(page: Page, label: string) {
  await nodeByLabel(page, label).click();
}

/**
 * Add a node from the catalog. Returns the auto-generated label
 * (e.g. 'code1', 'code2') the editor assigns.
 */
export async function addNode(page: Page, type: string): Promise<string> {
  const sameType = page.locator(`.react-flow__node-${type}`);
  const label = `${type}${await sameType.count() + 1}`;
  await page.getByTestId('add-node-btn').click();
  await expect(page.getByTestId(`catalog-${type}`)).toBeVisible({ timeout: 5000 });
  await page.getByTestId(`catalog-${type}`).click();
  await expect(nodeByLabel(page, label)).toBeVisible({ timeout: 5000 });
  return label;
}

/**
 * Open the config modal for a node and rename it. Also used to enter the
 * "configure nodes" phase: the modal stays open, so callers can then use
 * `fillField` / `selectOption` before `closeConfig`.
 */
export async function configureNode(page: Page, label: string, newLabel?: string) {
  await clickNode(page, label);
  await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
  if (newLabel) {
    await page.getByLabel('Node name').fill(newLabel);
  }
}

/** Close the node config modal. */
export async function closeConfig(page: Page) {
  await page.getByTestId('node-config-modal').getByRole('button', { name: /Close$/ }).click();
  await expect(page.getByTestId('node-config-modal')).not.toBeVisible();
}

/** Fill a labelled text field inside the open config modal. */
export async function fillField(page: Page, label: string, value: string) {
  await page.getByLabel(label).fill(value);
}

/** Fill a field identified by its placeholder (multiline prompts etc.). */
export async function fillFieldByPlaceholder(page: Page, placeholder: string, value: string) {
  await page.getByPlaceholder(placeholder).fill(value);
}

/**
 * Select an option from a Radix Select dropdown inside the open config
 * modal, matching the option's display label.
 */
export async function selectOption(page: Page, triggerLabel: string, optionLabel: string | RegExp) {
  await page.locator(`[data-field-label="${triggerLabel}"]`).click();
  await page.getByRole('option', { name: optionLabel }).first().click();
}

/**
 * Select an option from a native <select> inside the config modal by value.
 */
export async function selectNativeOption(page: Page, value: string) {
  await page.getByTestId('node-config-modal').locator('select').first().selectOption(value);
}

/**
 * Connect two nodes by dragging from a source handle to a target handle on
 * the canvas (the same gesture a user performs).
 */
export async function connect(page: Page, fromLabel: string, fromHandle: string, toLabel: string, toHandle: string) {
  const src = nodeByLabel(page, fromLabel).locator(`.react-flow__handle[data-handleid="${fromHandle}"]`).first();
  const dst = nodeByLabel(page, toLabel).locator(`.react-flow__handle[data-handleid="${toHandle}"]`).first();
  await expect(src).toBeVisible({ timeout: 5000 });
  await expect(dst).toBeVisible({ timeout: 5000 });
  const srcBox = await src.boundingBox();
  const dstBox = await dst.boundingBox();
  if (!srcBox || !dstBox) throw new Error(`Cannot bound handles for ${fromLabel} → ${toLabel}`);
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dstBox.x + dstBox.width / 2, dstBox.y + dstBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => page.locator('.react-flow__edge').count(), { timeout: 5000 })
    .toBeGreaterThan(0);
}

/** Drag a node by a relative delta to spread nodes out on the canvas. */
export async function moveNodeBy(page: Page, label: string, dx: number, dy: number) {
  const node = nodeByLabel(page, label);
  const box = await node.boundingBox();
  if (!box) throw new Error(`Cannot bound node ${label}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}

/** Current canvas zoom (from the React Flow viewport transform). */
export async function getZoom(page: Page): Promise<number> {
  const t = await page.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    return el?.style?.transform || '';
  });
  const m = t.match(/matrix\(([^)]+)\)/);
  return m ? parseFloat(m[1].split(',')[0]) : 1;
}

/**
 * Move a node to a grid slot (col, row) relative to the canvas centre, in
 * flow coordinates (zoom-independent). 280px columns / 220px rows.
 */
export async function moveNodeToSlot(page: Page, label: string, col: number, row: number) {
  const scale = await getZoom(page);
  const box = await nodeByLabel(page, label).boundingBox();
  const rf = await page.locator('.react-flow').boundingBox();
  if (!box || !rf) throw new Error(`Cannot bound node ${label} or canvas`);
  const targetX = rf.x + rf.width / 2 + col * 280 * scale;
  const targetY = rf.y + rf.height / 2 + row * 220 * scale;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();
}

/** Debug overlay locator. */
export function debugOverlay(page: Page) {
  return page.getByTestId('debug-overlay');
}

/** Expand a step card in the debug overlay by node label (idempotent). */
export async function expandStep(page: Page, label: string) {
  const card = debugOverlay(page).getByRole('button').filter({ has: page.getByText(label, { exact: true }) }).first();
  const isExpanded = await card.locator('.material-symbols-outlined', { hasText: 'expand_less' }).count();
  if (!isExpanded) {
    await card.click();
  }
}

/** Assert the debug run completed (status banner + optional final output). */
export async function expectCompleted(page: Page, timeout = 20000) {
  await expect(debugOverlay(page).getByText('Completed').first()).toBeVisible({ timeout });
}

/** Assert the debug run failed and shows the given error text. */
export async function expectFailed(page: Page, errorText?: string | RegExp, timeout = 20000) {
  await expect(debugOverlay(page).getByText('Failed').first()).toBeVisible({ timeout });
  if (errorText !== undefined) {
    // Surface the error: flow-level failures show a banner, per-step failures
    // show the error inside the expanded step card — expand a failed card.
    const failedCard = debugOverlay(page).getByRole('button').filter({ hasText: 'Failed' }).first();
    await failedCard.click().catch(() => {});
    await expect(debugOverlay(page).getByText(errorText).first()).toBeVisible({ timeout: 5000 });
  }
}

/** Assert the final output block shows the given text. */
export async function expectFinalOutput(page: Page, text: string | RegExp, timeout = 10000) {
  const heading = debugOverlay(page).getByText('Final Output').first();
  await expect(heading).toBeVisible({ timeout });
  const pre = heading.locator('xpath=../pre');
  try {
    await expect(pre).toContainText(text, { timeout });
  } catch (err) {
    const dump = await debugOverlay(page).evaluate((el) => (el as HTMLElement).innerText.slice(0, 600)).catch(() => 'n/a');
    console.log('FINAL OUTPUT DEBUG:', JSON.stringify(dump));
    throw err;
  }
}

/** Fill a JSON schema via the JsonSchemaBuilder (switches it to raw JSON mode). */
export async function fillJsonSchema(page: Page, schema: string) {
  await page.getByTestId('json-schema-mode-raw').click();
  await page.getByTestId('json-schema-raw-input').fill(schema);
}

/** Click the editor Save button. */
export async function saveFlow(page: Page) {
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled({ timeout: 5000 });
  await page.getByRole('button', { name: 'Save' }).click();
}

/**
 * Run the flow from the debug overlay, optionally supplying the manual
 * trigger input. If the overlay is already open, re-runs from inside it.
 * Returns once the run button is clicked (assertions on results are left to
 * the caller via the debug overlay).
 */
export async function runFlow(page: Page, input?: string) {
  const runBtn = debugOverlay(page).getByTestId('debug-run-btn');
  if (!(await runBtn.isVisible().catch(() => false))) {
    await page.getByTestId('debug-btn').click();
    await expect(runBtn).toBeVisible({ timeout: 5000 });
  }
  if (input !== undefined) {
    await page.getByPlaceholder(/Enter the message to send to the flow/).fill(input);
  }
  await runBtn.click();
}
