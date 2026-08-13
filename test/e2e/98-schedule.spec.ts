import { test, expect } from '@playwright/test';
import { deleteFlow, uniqueFlowName } from './helpers/api';
import {
  createFlowViaUi, addNode, clickNode, configureNode, closeConfig, fillField,
  fillJsonSchema, selectOption, connect, moveNodeToSlot, saveFlow, runFlow,
  debugOverlay, expandStep, expectCompleted,
} from './helpers/flow-builder';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

// ── UI flow builder (same recipe as 90-node-types) ─────────────────────────
// Flow creation, trigger config (Trigger Type select, Cron Expression, Input
// Message), node wiring, save and debug-run all go through the real editor UI.

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
      if (config.cronExpression !== undefined) await fillField(page, 'Cron Expression', config.cronExpression);
      if (config.inputMessage !== undefined) await fillField(page, 'Input Message', config.inputMessage);
      if (config.inputSchema) await fillJsonSchema(page, config.inputSchema);
      break;
    case 'code':
      if (config.code) await fillField(page, 'JavaScript Code', config.code);
      if (config.outputSchema) await fillJsonSchema(page, config.outputSchema);
      break;
    case 'output': {
      for (const field of config.inputFields || []) {
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

/** Build a flow through the editor UI: nodes, layout, edges, configs, save. */
async function buildUiFlow(page: any, request: any, name: string, nodes: UiNode[], edges: UiEdge[]): Promise<string> {
  const flowId = await createFlowViaUi(page, name);
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

test.describe('Schedule trigger', () => {
  test.afterEach(async ({ request }, testInfo) => {
    const flowId = (testInfo as any).flowId;
    if (flowId) await deleteFlow(request, flowId).catch(() => {});
  });

  test('schedule-triggered flow executes via the debug overlay', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('ScheduleTest'), [
      { type: 'trigger', label: 'Scheduler', config: { triggerType: 'schedule', cronExpression: '* * * * *', inputMessage: '{"message":"scheduled run"}' } },
      { type: 'code', label: 'Echo', config: { code: 'return { result: input.message };' } },
      { type: 'output', label: 'Output', config: { inputFields: ['Echo'] } },
    ], [
      { from: 'Scheduler', fromHandle: 'output-0', to: 'Echo', toHandle: 'input-0' },
      { from: 'Echo', fromHandle: 'output-0', to: 'Output', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The debug overlay simulates a scheduled run with a message input
    // (its trigger chip shows "Schedule").
    await runFlow(page, 'cron job run');
    await expectCompleted(page);
    await expandStep(page, 'Echo');
    await expect(debugOverlay(page).getByText(/"result": "cron job run"/).first()).toBeVisible({ timeout: 5000 });
  });

  test('schedule flow saves cron expression and can be re-fetched', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('ScheduleCRUD'), [
      { type: 'trigger', label: 'Timer', config: { triggerType: 'schedule', cronExpression: '0 */2 * * *', inputMessage: '{"task":"check"}' } },
      { type: 'output', label: 'Out', config: { inputFields: [] } },
    ], [
      { from: 'Timer', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // Read back via the UI: reopen the trigger config — the cron must be there
    await openConfig(page, 'Timer');
    await expect(page.getByLabel('Cron Expression')).toHaveValue('0 */2 * * *');
    // Update the cron expression through the UI form
    await page.getByLabel('Cron Expression').fill('*/10 * * * *');
    await page.getByLabel('Input Message').fill('{"task":"check"}');
    await closeConfig(page);
    await saveFlow(page);

    // Reload and reopen — the updated cron must be persisted (server round trip)
    await page.goto(`/flows/${flowId}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });
    await openConfig(page, 'Timer');
    await expect(page.getByLabel('Cron Expression')).toHaveValue('*/10 * * * *');
  });

  test('schedule flow can be converted to manual and back', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('ScheduleToggle'), [
      { type: 'trigger', label: 'Timer', config: { triggerType: 'schedule', cronExpression: '0 * * * *', inputMessage: '{}' } },
      { type: 'output', label: 'Out', config: { inputFields: [] } },
    ], [
      { from: 'Timer', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // Convert to manual via the trigger type select (removes the cron fields)
    await openConfig(page, 'Timer');
    await expect(page.locator('[data-field-label="Trigger Type"]')).toContainText('Schedule');
    await page.locator('[data-field-label="Trigger Type"]').click();
    await page.getByRole('option', { name: 'Manual' }).click();
    await expect(page.getByLabel('Input Message')).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel('Cron Expression')).toHaveCount(0);
    await page.getByLabel('Input Message').fill('{"via":"ui"}');
    await closeConfig(page);
    await saveFlow(page);

    // Reload — manual must be persisted (cron field gone)
    await page.goto(`/flows/${flowId}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });
    await openConfig(page, 'Timer');
    await expect(page.locator('[data-field-label="Trigger Type"]')).toContainText('Manual');
    await expect(page.getByLabel('Cron Expression')).toHaveCount(0);
    await closeConfig(page);

    // The manual flow is still executable from the debug overlay
    await runFlow(page, 'manual run');
    await expectCompleted(page);
  });

  test('schedule flow fires on a real cron (sub-minute) and the execution completes', async ({ page, request }, testInfo) => {
    test.setTimeout(120000);
    const flowId = await buildUiFlow(page, request, uniqueFlowName('ScheduleStrict'), [
      { type: 'trigger', label: 'Cron', config: { triggerType: 'schedule', cronExpression: '*/10 * * * * *', inputMessage: '{"source":"cron-strict"}' } },
      { type: 'code', label: 'Mark', config: { code: 'return { scheduled: true, source: input.source || input.message || "none", received: input };' } },
      { type: 'output', label: 'Out', config: { inputFields: ['Mark'] } },
    ], [
      { from: 'Cron', fromHandle: 'output-0', to: 'Mark', toHandle: 'input-0' },
      { from: 'Mark', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // NOTE: waiting for a REAL cron-fired run has no UI (the debug overlay
    // runs in-memory and the BullMQ repeatable job executes on the worker), so
    // the wait + execution-record assertions stay API-based — a documented UI
    // gap. The flow itself (cron + inputMessage config, nodes, wiring) was
    // built and saved through the editor UI above, which registers the job.
    await expect.poll(async () => {
      const listRes = await request.get(`${API_URL}/flows/${flowId}/executions?limit=10`);
      if (!listRes.ok()) return null;
      const body = await listRes.json();
      const list = body.data || [];
      const scheduled = list.find((e: any) => e.input?.triggerType === 'schedule');
      return scheduled ? scheduled.status : null;
    }, {
      timeout: 90000,
      intervals: [2000],
      message: 'No cron-fired execution appeared within 90s — the BullMQ repeatable job did not fire',
    }).toBe('completed');

    // Fetch the fired execution and assert on the delivered input
    const listRes = await request.get(`${API_URL}/flows/${flowId}/executions?limit=10`);
    const body = await listRes.json();
    const scheduled = (body.data || []).find((e: any) => e.input?.triggerType === 'schedule');
    expect(scheduled).toBeDefined();
    expect(scheduled.status).toBe('completed');
    expect(scheduled.input).toMatchObject({ triggerType: 'schedule' });
    expect(scheduled.input.timestamp).toBeDefined();

    // The code node echoed the exact input the worker delivered. Node ids are
    // editor-generated for UI-built flows, so locate the code node's output by
    // its marker value instead of a hardcoded id.
    const detailRes = await request.get(`${API_URL}/flows/${flowId}/executions/${scheduled.id}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json();
    const mark: any = Object.values(detail.output || {}).find((v: any) => v && typeof v === 'object' && v.scheduled === true);
    expect(mark).toBeDefined();
    expect(mark?.received).toMatchObject({ triggerType: 'schedule' });
    // The trigger's configured inputMessage ({"source":"cron-strict"}) IS now
    // delivered: the repeatable BullMQ job carries it, and the worker merges it
    // into the execution input alongside the schedule context fields.
    expect(mark?.received?.source).toBe('cron-strict');
    expect(mark?.source).toBe('cron-strict');
  });

  test('cron expression and input message can be configured via the editor UI and persist', async ({ page, request }, testInfo) => {
    // Start from a manual flow and configure the schedule via the trigger panel
    const flowId = await createFlowViaUi(page, uniqueFlowName('ScheduleUI'));
    (testInfo as any).flowId = flowId;

    // Open the trigger config and switch to Schedule
    await configureNode(page, 'Trigger', 'Timer');
    await page.locator('[data-field-label="Trigger Type"]').click();
    await page.getByRole('option', { name: 'Schedule' }).click();
    await expect(page.getByLabel('Cron Expression')).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Cron Expression').fill('*/30 * * * * *');
    await page.getByLabel('Input Message').fill('{"task":"ui-configured"}');
    await closeConfig(page);
    await saveFlow(page);

    // Reload and reopen — values must be persisted (fetched from the server)
    await page.goto(`/flows/${flowId}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });
    await configureNode(page, 'Timer', 'Timer');
    await expect(page.locator('[data-field-label="Trigger Type"]')).toContainText('Schedule');
    await expect(page.getByLabel('Cron Expression')).toHaveValue('*/30 * * * * *');
    await expect(page.getByLabel('Input Message')).toHaveValue('{"task":"ui-configured"}');
  });

  test('schedule trigger converts to manual via the editor UI and persists', async ({ page, request }, testInfo) => {
    const flowId = await buildUiFlow(page, request, uniqueFlowName('ScheduleToggleUI'), [
      { type: 'trigger', label: 'Timer', config: { triggerType: 'schedule', cronExpression: '0 0 1 1 *', inputMessage: '{"task":"ui"}' } },
      { type: 'output', label: 'Out', config: { inputFields: [] } },
    ], [
      { from: 'Timer', fromHandle: 'output-0', to: 'Out', toHandle: 'input-0' },
    ]);
    (testInfo as any).flowId = flowId;

    // The trigger panel shows the schedule config
    await openConfig(page, 'Timer');
    await expect(page.locator('[data-field-label="Trigger Type"]')).toContainText('Schedule');
    await expect(page.getByLabel('Cron Expression')).toBeVisible();

    // Convert to manual via the trigger type select
    await page.locator('[data-field-label="Trigger Type"]').click();
    await page.getByRole('option', { name: 'Manual' }).click();
    await expect(page.getByLabel('Input Message')).toBeVisible({ timeout: 5000 });
    await expect(page.getByLabel('Cron Expression')).toHaveCount(0);
    await page.getByLabel('Input Message').fill('{"via":"ui"}');
    await closeConfig(page);
    await saveFlow(page);

    // Reload — manual is persisted (cron field is gone)
    await page.goto(`/flows/${flowId}/edit`);
    await page.getByTestId('flow-canvas').waitFor({ state: 'visible', timeout: 10000 });
    await openConfig(page, 'Timer');
    await expect(page.locator('[data-field-label="Trigger Type"]')).toContainText('Manual');
    await expect(page.getByLabel('Cron Expression')).toHaveCount(0);
  });
});
