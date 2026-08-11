import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const cookie = getAuthCookie() || undefined;

test.describe('Sidecar lifecycle and execution history', () => {
  const cleanupFlowIds: string[] = [];
  const cleanupGroupIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of cleanupFlowIds) { await deleteFlow(request, id).catch(() => {}); }
    for (const id of cleanupGroupIds) { await request.delete(`${API_URL}/groups/${id}`).catch(() => {}); }
    cleanupFlowIds.length = 0;
    cleanupGroupIds.length = 0;
  });

  test('persisted execution completes with proper sandbox lifecycle', async ({ request }) => {
    const flowName = uniqueFlowName('Sidecar-Lifecycle');
    const flowRes = await createFlow(request, {
      name: flowName,
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { readSSE } = await import('./helpers/stream');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const { executePersisted, pollExecution } = await import('./helpers/stream');
    const { executionId } = await executePersisted(flow.id, { message: 'hello' }, cookie);
    expect(executionId).toBeTruthy();
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
  });

  test('execution history page loads', async ({ page }) => {
    await page.goto('/settings/executions');
    await expect(page.locator('h1').filter({ hasText: 'Pending Approvals' }).first()).toBeVisible({ timeout: 10000 });
  });

  test('execution history lists completed executions', async ({ request }) => {
    const flowName = uniqueFlowName('Exec-History-List');
    const flowRes = await createFlow(request, {
      name: flowName,
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { readSSE } = await import('./helpers/stream');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const { executePersisted, pollExecution } = await import('./helpers/stream');
    const { executionId } = await executePersisted(flow.id, { message: 'list-test' }, cookie);
    expect(executionId).toBeTruthy();

    const execution = await pollExecution(request, executionId, 30000);
    expect(execution.flow_name).toBe(flowName);
    expect(execution.status).toBe('completed');
  });

  test('code node in persisted execution completes', async ({ request }) => {
    const flowName = uniqueFlowName('Code-Sandbox');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Code', type: 'code', config: { code: 'return { result: "sandbox-works" }' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Code.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
          { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { readSSE } = await import('./helpers/stream');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const { executePersisted, pollExecution } = await import('./helpers/stream');
    const { executionId } = await executePersisted(flow.id, { message: 'test' }, cookie);
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
    const output = exec.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    expect(outputStr).toContain('sandbox-works');
  });

  test('group-scoped execution filtering (HITL admin page)', async ({ page, request }) => {
    const groupName = `HITL-Admin-Group-${Date.now()}`;
    const gRes = await request.post(`${API_URL}/groups`, {
      data: { name: groupName },
    });
    expect(gRes.status()).toBe(201);
    const group = await gRes.json();
    cleanupGroupIds.push(group.id);

    const flowName = uniqueFlowName('HITL-Admin-Flow');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        group_id: group.id,
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'h1', type: 'hitl', position: { x: 0, y: 150 }, data: { label: 'HITL', type: 'hitl', config: { prompt: 'Approve?', buttons: [{ label: 'Approve', value: 'approved' }], assignmentType: 'group', assignedGroupId: group.id } } },
        ],
        edges: [{ id: 'e1', source: 't1', target: 'h1' }],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { executeUntilPaused } = await import('./helpers/stream');
    const { events, executionId } = await executeUntilPaused(flow.id, {}, cookie);
    expect(executionId).toBeTruthy();

    await page.goto('/settings/executions');
    await expect(page.locator('h1').filter({ hasText: 'Pending Approvals' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(flowName)).toBeVisible({ timeout: 10000 });

    await request.delete(`${API_URL}/executions/${executionId}`);
  });

  test('execution detail view: run history row opens detail with status and step tree', async ({ page, request }) => {
    const flowName = uniqueFlowName('Exec-Detail-UI');
    const flowRes = await createFlow(request, {
      name: flowName,
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Make', type: 'code', config: { code: 'return { made: "ui-value" }' } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Make.made'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
        { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { readSSE } = await import('./helpers/stream');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const { executePersisted } = await import('./helpers/stream');
    const { executionId } = await executePersisted(flow.id, { message: 'detail-test' }, cookie);
    expect(executionId).toBeTruthy();

    // Run history page → click the execution row → detail view with status + step trace
    await page.goto(`/flows/${flow.id}/executions`);
    await expect(page.locator('h1').filter({ hasText: 'Run history' }).first()).toBeVisible({ timeout: 10000 });
    const row = page.locator('div.cursor-pointer', { hasText: 'Completed' }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();

    await expect(page.locator('h1').filter({ hasText: 'Execution Details' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Completed/).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Step Trace \(3 steps\)/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Trigger', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Make', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Output', { exact: true }).first()).toBeVisible();

    // Dedicated execution detail page renders the step tree with each node's step card
    await page.goto(`/executions/${executionId}`);
    await expect(page.locator('h1').filter({ hasText: flowName })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/Completed/).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Execution Steps')).toBeVisible();
    await expect(page.getByTestId('step-card-t1')).toBeVisible();
    await expect(page.getByTestId('step-card-c1')).toBeVisible();
    await expect(page.getByTestId('step-card-o1')).toBeVisible();

    // Expand the code step — its output is visible
    await page.getByTestId('step-toggle-c1').click();
    await expect(page.getByTestId('step-card-c1').getByText('ui-value')).toBeVisible({ timeout: 5000 });
  });

  test('re-execution creates a new execution record (no retry button in run history)', async ({ page, request }) => {
    const flowName = uniqueFlowName('Reexec-Check');
    const flowRes = await createFlow(request, {
      name: flowName,
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'o1', type: 'output', position: { x: 300, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Trigger.message'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { readSSE } = await import('./helpers/stream');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const run = async (msg: string): Promise<string> => {
      const res = await fetch(`${API_URL}/flows/${flow.id}/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: { message: msg }, _debug: false }),
      });
      expect(res.ok).toBe(true);
      const events = await readSSE(res);
      const started = events.find(e => e.type === 'execution.started');
      expect(started).toBeDefined();
      const executionId = (started as any)?.executionId as string;
      expect(executionId).toBeTruthy();
      return executionId;
    };

    const firstId = await run('run-one');
    const secondId = await run('run-two');
    expect(secondId).not.toBe(firstId);

    // Both runs are persisted as separate, completed records (worker executes them)
    const { pollExecution } = await import('./helpers/stream');
    await pollExecution(request, firstId, 30000);
    await pollExecution(request, secondId, 30000);
    const listRes = await request.get(`${API_URL}/flows/${flow.id}/executions`);
    expect(listRes.ok()).toBe(true);
    const { data } = await listRes.json();
    const records = data.filter((e: any) => e.id === firstId || e.id === secondId);
    expect(records).toHaveLength(2);
    expect(records.every((e: any) => e.status === 'completed')).toBe(true);

    // The run history UI lists both runs and offers no retry button
    await page.goto(`/flows/${flow.id}/executions`);
    await expect(page.locator('div.cursor-pointer', { hasText: 'Completed' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('div.cursor-pointer', { hasText: 'Completed' })).toHaveCount(2);
    expect(await page.getByRole('button', { name: /retry/i }).count()).toBe(0);
  });

  test('mid-flow failure is persisted with status failed and the error shows in the detail view', async ({ page, request }) => {
    const flowName = uniqueFlowName('Midflow-Fail');
    const flowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: flowName,
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Boom', type: 'code', config: { code: 'throw new Error("boom from code node");' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Boom.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
          { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      },
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    cleanupFlowIds.push(flow.id);

    const { readSSE } = await import('./helpers/stream');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;

    const { executePersisted } = await import('./helpers/stream');
    const { executionId } = await executePersisted(flow.id, { message: 'test' }, cookie);
    expect(executionId).toBeTruthy();

    // Persisted record: status failed, error stored, failed step recorded
    let exec: any = null;
    for (let i = 0; i < 30; i++) {
      const execRes = await request.get(`${API_URL}/executions/${executionId}`);
      expect(execRes.ok()).toBe(true);
      exec = await execRes.json();
      if (exec.status !== 'running') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(exec.status).toBe('failed');
    expect(exec.error).toContain('boom from code node');
    const failedStep = exec.steps?.find((s: any) => s.node_id === 'c1');
    expect(failedStep).toBeDefined();
    expect(failedStep.status).toBe('failed');
    expect(failedStep.error).toContain('boom from code node');

    // Run history list shows the error (truncated to 80 chars), detail view shows the full banner
    await page.goto(`/flows/${flow.id}/executions`);
    await expect(page.getByText(/Code node execution failed/).first()).toBeVisible({ timeout: 10000 });
    await page.locator('div.cursor-pointer', { hasText: 'Failed' }).first().click();
    await expect(page.locator('h1').filter({ hasText: 'Execution Details' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'Execution Failed' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/boom from code node/).first()).toBeVisible({ timeout: 5000 });
  });
});
