import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import {
  createFlowViaUi, addNode, configureNode, closeConfig, fillField, connect,
  moveNodeToSlot, saveFlow, runFlow, debugOverlay, expandStep,
} from './helpers/flow-builder';

const overlay = (page: any) => debugOverlay(page);

test.describe('Debug run', () => {
  let flowId: string | undefined;

  test.beforeEach(async ({ page }) => {
    flowId = await createFlowViaUi(page, uniqueFlowName('Debug Run Test'));
  });

  test.afterEach(async ({ request }) => {
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
    flowId = undefined;
  });

  /** Build a trigger → code → output flow through the editor UI. */
  async function buildCodeFlow(page: any, code: string) {
    await configureNode(page, 'Trigger', 'Trigger');
    await closeConfig(page);
    await moveNodeToSlot(page, 'Trigger', -1, 0);
    const c1 = await addNode(page, 'code');
    await moveNodeToSlot(page, c1, 0, 0);
    await configureNode(page, c1, 'Compute');
    await fillField(page, 'JavaScript Code', code);
    await closeConfig(page);
    const o1 = await addNode(page, 'output');
    await moveNodeToSlot(page, o1, 1, 0);
    await configureNode(page, o1, 'Output');
    await closeConfig(page);
    await connect(page, 'Trigger', 'output-0', 'Compute', 'input-0');
    await connect(page, 'Compute', 'output-0', 'Output', 'input-0');
    await saveFlow(page);
  }

  test('debug button is visible on the editor', async ({ page }) => {
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 5000 });
    await expect(page.getByTestId('debug-btn')).toBeVisible();
  });

  test('clicking debug opens the debug panel', async ({ page }) => {
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('debug-btn').click();
    await expect(page.getByTestId('debug-run-btn')).toBeVisible({ timeout: 5000 });
  });

  test('runs a simple trigger → output flow and completes', async ({ page }) => {
    await runFlow(page, 'hello-debug');

    // Execution completes and the output node step shows a completed status
    await expect(overlay(page).getByText('Completed').first()).toBeVisible({ timeout: 20000 });
    await expect(overlay(page).getByText('Final Output')).toBeVisible({ timeout: 5000 });
    await expect(overlay(page).getByText('hello-debug').first()).toBeVisible();
  });

  test('shows step output values from a code node', async ({ page }) => {
    await buildCodeFlow(page, 'return { value: 42 };');
    await runFlow(page);

    await expect(overlay(page).getByText('Completed').first()).toBeVisible({ timeout: 20000 });

    // Expand the Compute step card and assert the computed output is shown
    await expandStep(page, 'Compute');
    await expect(overlay(page).getByText(/"value": 42/).first()).toBeVisible({ timeout: 5000 });
  });

  test('steps appear in execution order', async ({ page }) => {
    await buildCodeFlow(page, 'return input;');
    await runFlow(page);

    await expect(overlay(page).getByText('Completed').first()).toBeVisible({ timeout: 20000 });

    // Step cards are rendered in topological execution order: Trigger → Compute → Output
    const labels = await overlay(page).locator('span.text-sm.font-medium').allTextContents();
    expect(labels).toEqual(['Trigger', 'Compute', 'Output']);
  });

  test('debug input message is used by the flow', async ({ page }) => {
    await buildCodeFlow(page, 'return { received: input.message };');
    await runFlow(page, 'debug-hello-42');
    await expect(overlay(page).getByText('Completed').first()).toBeVisible({ timeout: 20000 });

    // The code node received the filled message as input
    await expandStep(page, 'Compute');
    await expect(overlay(page).getByText('debug-hello-42').first()).toBeVisible({ timeout: 5000 });
  });

  test('code node errors are displayed in the panel', async ({ page }) => {
    // A real throwing code node: the sandbox reports a non-zero exit code, the step
    // fails, and the error text (with the original exception) surfaces in the panel.
    await buildCodeFlow(page, 'throw new Error("boom from code node");');
    await runFlow(page);

    // Panel status flips to Failed
    await expect(overlay(page).getByText('Failed').first()).toBeVisible({ timeout: 20000 });

    // The failing step shows the error message once expanded
    await expandStep(page, 'Compute');
    await expect(overlay(page).getByText(/boom from code node/).first()).toBeVisible({ timeout: 5000 });
  });
});
