import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

async function readSSE(url: string, body: unknown, cookie: string): Promise<any[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Execute failed: ${res.status} ${res.statusText}`);
  const events: any[] = [];
  const reader = res.body?.getReader();
  if (!reader) return events;
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { events.push(JSON.parse(line.slice(6))); } catch {}
      }
    }
    if (events.some(e => e.type === 'execution.completed' || e.type === 'execution.failed' || e.type === 'execution.paused')) break;
  }
  reader.releaseLock();
  return events;
}

function subflowTriggerNode(label: string, schema: string): any {
  return { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label, type: 'trigger', config: { triggerType: 'subflow', inputSchema: schema } } };
}

function codeNode(id: string, label: string, code: string): any {
  return { id, type: 'code', position: { x: 250, y: 0 }, data: { label, type: 'code', config: { code } } };
}

function outputNode(id: string, label: string, inputFields: string[]): any {
  return { id, type: 'output', position: { x: 500, y: 0 }, data: { label, type: 'output', config: { inputFields } } };
}

async function createCodeChildFlow(request: any, code: string, pushId: (id: string) => void): Promise<any> {
  const res = await request.post(`${API_URL}/flows`, {
    data: {
      name: uniqueFlowName('Child-Flow'),
      nodes: [subflowTriggerNode('Trigger', JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })), codeNode('n2', 'Transform', code), outputNode('n3', 'Output', ['Transform.result'])],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    },
  });
  expect(res.ok()).toBe(true);
  const flow = await res.json();
  pushId(flow.id);
  return flow;
}

test.describe('Subflows feature', () => {
  const createdFlowIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdFlowIds) {
      await deleteFlow(request, id).catch(() => {});
    }
    createdFlowIds.length = 0;
  });

  // ─── Catalog ───────────────────────────────────────────────

  test('subflow node appears in node catalog', async ({ page }) => {
    await page.goto('/flows/new/edit');
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('add-node-btn').click();
    await expect(page.getByTestId('catalog-subflow')).toBeVisible({ timeout: 5000 });
  });

  // ─── Subflow node configuration ──────────────────────────

  test('subflow node can be added to canvas and configured', async ({ page, request }) => {
    const subflowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Child-Subflow'),
        nodes: [
          { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'subflow', inputSchema: JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }) } } },
          { id: 'n2', type: 'code', position: { x: 250, y: 0 }, data: { label: 'Transform', type: 'code', config: { code: 'return { result: (input.text || "").toUpperCase() }' } } },
          { id: 'n3', type: 'output', position: { x: 500, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Transform.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2' },
          { id: 'e2', source: 'n2', target: 'n3' },
        ],
      },
    });
    expect(subflowRes.ok()).toBe(true);
    const subflow = await subflowRes.json();
    createdFlowIds.push(subflow.id);

    const parentRes = await createFlow(request, { name: uniqueFlowName('Parent-Flow') });
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    await page.goto(`/flows/${parent.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    await page.getByTestId('add-node-btn').click();
    await expect(page.getByTestId('catalog-subflow')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('catalog-subflow').click();

    await page.getByText('Subflow').first().click();
    await expect(page.getByTestId('node-config-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('subflow-config')).toBeVisible({ timeout: 5000 });

    const subflowItem = page.getByTestId(`subflow-item-${subflow.name.replace(/\s+/g, '-')}`);
    await expect(subflowItem).toBeVisible({ timeout: 5000 });
    await subflowItem.click();

    await expect(page.getByText(subflow.name).first()).toBeVisible({ timeout: 3000 });
  });

  // ─── Subflow execution via SSE ───────────────────────────

  test('subflow node executes child flow and returns result', async ({ page, request }) => {
    const subflowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Upper-Subflow'),
        nodes: [
          { id: 's1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'subflow', inputSchema: JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }) } } },
          { id: 's2', type: 'code', position: { x: 250, y: 0 }, data: { label: 'Upper', type: 'code', config: { code: 'return { result: (input.text || "").toUpperCase() }' } } },
          { id: 's3', type: 'output', position: { x: 500, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Upper.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 's1', target: 's2' },
          { id: 'e2', source: 's2', target: 's3' },
        ],
      },
    });
    expect(subflowRes.ok()).toBe(true);
    const subflow = await subflowRes.json();
    createdFlowIds.push(subflow.id);

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;

    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Exec-Parent'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Subflow', type: 'subflow', config: { subflowId: subflow.id, subflowName: subflow.name, inputMapping: { text: '{{input.Trigger.message}}' } } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Subflow.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const events = await readSSE(
      `${API_URL}/flows/${parent.id}/execute`,
      { input: { _debug: true, message: 'hello world' } },
      adminCookie,
    );

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    expect(outputStr).toContain('HELLO WORLD');
  });

  test('subflow with number transformation works', async ({ page, request }) => {
    const subflowRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Double-Subflow'),
        nodes: [
          { id: 's1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'subflow', inputSchema: JSON.stringify({ type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }) } } },
          { id: 's2', type: 'code', position: { x: 250, y: 0 }, data: { label: 'Double', type: 'code', config: { code: 'return { result: (input.x || 0) * 2 }' } } },
          { id: 's3', type: 'output', position: { x: 500, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Double.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 's1', target: 's2' },
          { id: 'e2', source: 's2', target: 's3' },
        ],
      },
    });
    expect(subflowRes.ok()).toBe(true);
    const subflow = await subflowRes.json();
    createdFlowIds.push(subflow.id);

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;

    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Double-Parent'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Calc', type: 'subflow', config: { subflowId: subflow.id, subflowName: subflow.name, inputMapping: { x: '{{input.Trigger.num}}' } } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['Calc.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const events = await readSSE(
      `${API_URL}/flows/${parent.id}/execute`,
      { input: { _debug: true, num: 21 } },
      adminCookie,
    );

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const output = completed?.data?.output || {};
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    expect(outputStr).toContain('42');
  });

  // ─── Error handling ──────────────────────────────────────

  test('subflow with invalid subflowId fails gracefully', async ({ page, request }) => {
    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Bad-Subflow'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Broken', type: 'subflow', config: { subflowId: '00000000-0000-0000-0000-000000000000', inputMapping: {} } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;

    const events = await readSSE(
      `${API_URL}/flows/${parent.id}/execute`,
      { input: { _debug: true } },
      adminCookie,
    );

    const failedEvent = events.find(e => e.type === 'execution.failed');
    expect(failedEvent).toBeDefined();
    const errorMsg = failedEvent?.data?.error || '';
    expect(errorMsg).toContain('not found');
  });

  // ─── Nested subflows (depth 2) ────────────────────────────

  test('nested subflow: parent → subflow A → subflow B (depth 2) completes with child output', async ({ page, request }) => {
    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;

    // Level 2: flow B transforms text
    const flowB = await createCodeChildFlow(request, 'return { result: "B:" + (input.text || "") }', id => createdFlowIds.push(id));
    // Level 1: flow A calls flow B, then wraps the result
    const flowARes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Nested-A'),
        nodes: [
          subflowTriggerNode('Trigger', JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })),
          { id: 'a2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'SubB', type: 'subflow', config: { subflowId: flowB.id, subflowName: flowB.name, inputMapping: { text: '{{input.Trigger.text}}' } } } },
          codeNode('a3', 'A-Code', 'return { result: "A:" + JSON.stringify(input.subb) }'),
          outputNode('a4', 'A-Out', ['A-Code.result']),
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'a2' },
          { id: 'e2', source: 'a2', target: 'a3' },
          { id: 'e3', source: 'a3', target: 'a4' },
        ],
      },
    });
    expect(flowARes.ok()).toBe(true);
    const flowA = await flowARes.json();
    createdFlowIds.push(flowA.id);

    // Level 0: parent calls flow A
    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Nested-Parent'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'SubA', type: 'subflow', config: { subflowId: flowA.id, subflowName: flowA.name, inputMapping: { text: '{{input.Trigger.text}}' } } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'P-Out', type: 'output', config: { inputFields: ['SubA.a2'] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const events = await readSSE(
      `${API_URL}/flows/${parent.id}/execute`,
      { input: { _debug: true, text: 'hello' } },
      adminCookie,
    );

    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    // Both subflows started and completed — depth increases per level
    const startedEvents = events.filter(e => e.type === 'subflow.started');
    expect(startedEvents).toHaveLength(2);
    const labels = startedEvents.map(e => e.data?.subflowLabel || '');
    expect(labels.some(l => l === flowA.name)).toBe(true);
    expect(labels.some(l => l === flowB.name)).toBe(true);
    const depths = startedEvents.map(e => e.data?.depth);
    expect(depths).toContain(1);
    expect(depths).toContain(2);

    const completedEvents = events.filter(e => e.type === 'subflow.completed');
    expect(completedEvents).toHaveLength(2);

    // Flow B's result is threaded back through A into the parent output
    const outputStr = JSON.stringify(completed?.data?.output || {});
    expect(outputStr).toContain('B:hello');
    expect(outputStr).toContain('A:');
  });

  // ─── Recursion guard ─────────────────────────────────────

  test('self-referencing subflow fails with clear circular-reference error', async ({ page, request }) => {
    const res = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Self-Ref'),
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 's1', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Self', type: 'subflow', config: { subflowId: '00000000-0000-0000-0000-000000000000', inputMapping: {} } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Out', type: 'output', config: { inputFields: [] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', target: 's1' },
          { id: 'e2', source: 's1', target: 'o1' },
        ],
      },
    });
    expect(res.ok()).toBe(true);
    const flow = await res.json();
    createdFlowIds.push(flow.id);

    // Patch the subflow node to reference the flow itself
    const patchedNodes = flow.nodes.map((n: any) =>
      n.id === 's1' ? { ...n, data: { ...n.data, config: { ...n.data.config, subflowId: flow.id, subflowName: flow.name } } } : n
    );
    const patchRes = await request.put(`${API_URL}/flows/${flow.id}`, { data: { name: flow.name, nodes: patchedNodes, edges: flow.edges } });
    expect(patchRes.ok()).toBe(true);

    // The validate endpoint catches the cycle when the ancestry is provided
    const validateRes = await request.post(`${API_URL}/flows/validate`, {
      data: { nodes: patchedNodes, edges: flow.edges, subflowAncestry: [flow.id] },
    });
    expect(validateRes.ok()).toBe(true);
    const validation = await validateRes.json();
    expect(validation.valid).toBe(false);
    expect(JSON.stringify(validation.errors)).toContain('Circular subflow reference');

    // Runtime execution must fail with the same clear error instead of recursing infinitely
    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;
    const events = await readSSE(
      `${API_URL}/flows/${flow.id}/execute`,
      { input: { _debug: true } },
      adminCookie,
    );
    const failedEvent = events.find(e => e.type === 'execution.failed');
    expect(failedEvent).toBeDefined();
    const errorMsg = failedEvent?.data?.error || '';
    expect(errorMsg).toContain('Circular subflow reference');
    expect(errorMsg).toContain(flow.name);
  });

  // ─── HITL inside a subflow ───────────────────────────────

  test('subflow with HITL node: approval resumes inside the child and the parent completes', async ({ request }) => {
    const childRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Hitl-Child'),
        nodes: [
          subflowTriggerNode('Trigger', JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })),
          codeNode('n2', 'Transform', 'return { result: "child:" + (input.text || "") }'),
          { id: 'n3', type: 'hitl', position: { x: 500, y: 0 }, data: { label: 'Review', type: 'hitl', config: { prompt: 'Approve child step?', buttons: [{ label: 'Approve', value: 'approved' }] } } },
          outputNode('n4', 'Output', ['Transform.result']),
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2' },
          { id: 'e2', source: 'n2', target: 'n3' },
          { id: 'e3', source: 'n3', target: 'n4' },
        ],
      },
    });
    expect(childRes.ok()).toBe(true);
    const child = await childRes.json();
    createdFlowIds.push(child.id);

    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Hitl-Parent'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Sub', type: 'subflow', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.text}}' } } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Out', type: 'output', config: { inputFields: ['Sub.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;
    const { executeUntilPaused, pollExecution } = await import('./helpers/stream');
    const { executionId } = await executeUntilPaused(parent.id, { text: 'x' }, adminCookie);
    expect(executionId).toBeTruthy();

    // The pause is caused by the child's HITL node — its prompt is surfaced as pending
    const execRes = await request.get(`${API_URL}/executions/${executionId}`);
    expect(execRes.ok()).toBe(true);
    const exec = await execRes.json();
    expect(exec.status).toBe('awaiting_approval');
    const pending = Array.isArray(exec.pending_hitls) ? exec.pending_hitls : JSON.parse(exec.pending_hitls || '[]');
    expect(pending[0]?.prompt).toBe('Approve child step?');
    // The pending HITL is stored with its hierarchical node id (subflow label : child node id)
    // so the replay can resume INSIDE the child subflow
    expect(pending[0]?.nodeId).toBe('sub:n3');

    // The child flow ran as a sub-execution of the parent
    const subExecs = await (await request.get(`${API_URL}/executions?parent_execution_id=${executionId}`)).json().catch(() => []);
    const subExec = Array.isArray(subExecs) ? subExecs[0] : undefined;
    expect(subExec?.id).toBeTruthy();
    const subId = subExec.id;

    // Approve → the replay must resume inside the child, complete it, and finish the parent
    const approveRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ decision: 'approved', hitlNodeId: pending[0]?.nodeId }),
    });
    expect(approveRes.ok).toBe(true);

    const completedExec = await pollExecution(request, executionId, 30000);
    expect(completedExec.status).toBe('completed');

    // The child's output is in the parent result
    const outStr = typeof completedExec.output === 'string' ? completedExec.output : JSON.stringify(completedExec.output);
    expect(outStr).toContain('child:x');

    // The replayed child sub-execution completed with the HITL approved
    const childListRes = await request.get(`${API_URL}/flows/${child.id}/executions`);
    expect(childListRes.ok()).toBe(true);
    const childList = await childListRes.json();
    const completedSub = (childList.data || []).find((e: any) => e.id !== subId && e.status === 'completed');
    expect(completedSub).toBeDefined();
    expect(completedSub.parent_execution_id).toBe(executionId);
    expect(JSON.stringify(completedSub.output)).toContain('child:x');

    // No HITL left pending
    const pendingAfter = Array.isArray(completedExec.pending_hitls) ? completedExec.pending_hitls : JSON.parse(completedExec.pending_hitls || '[]');
    expect(pendingAfter).toHaveLength(0);
  });

  // ─── Input mapping edge cases ────────────────────────────

  test('subflow input mapping referencing a missing upstream field resolves gracefully', async ({ page, request }) => {
    const child = await createCodeChildFlow(request, 'return { result: "text=[" + input.text + "]" }', id => createdFlowIds.push(id));

    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Missing-Field-Parent'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Sub', type: 'subflow', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.nonexistent}}' } } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Out', type: 'output', config: { inputFields: ['Sub.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;
    const events = await readSSE(
      `${API_URL}/flows/${parent.id}/execute`,
      { input: { _debug: true, text: 'hello' } },
      adminCookie,
    );

    // Unresolved templates resolve to empty string — no error, child still runs
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    const failed = events.find(e => e.type === 'execution.failed');
    expect(failed).toBeUndefined();
    const outputStr = JSON.stringify(completed?.data?.output || {});
    expect(outputStr).toContain('text=[]');
  });

  // ─── Persisted (non-debug) subflow execution ─────────────

  test('persisted subflow execution: child flow runs as its own execution record and result is returned', async ({ request }) => {
    const child = await createCodeChildFlow(request, 'return { result: "persisted:" + (input.text || "") }', id => createdFlowIds.push(id));

    const parentRes = await request.post(`${API_URL}/flows`, {
      data: {
        name: uniqueFlowName('Persist-Parent'),
        nodes: [
          { id: 'p1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'p2', type: 'subflow', position: { x: 300, y: 0 }, data: { label: 'Sub', type: 'subflow', config: { subflowId: child.id, subflowName: child.name, inputMapping: { text: '{{input.Trigger.text}}' } } } },
          { id: 'p3', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Out', type: 'output', config: { inputFields: ['Sub.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 'p1', target: 'p2' },
          { id: 'e2', source: 'p2', target: 'p3' },
        ],
      },
    });
    expect(parentRes.ok()).toBe(true);
    const parent = await parentRes.json();
    createdFlowIds.push(parent.id);

    const adminCookie = `token=${getAuthCookie()?.split('=')[1] || ''}`;
    const { executePersisted, pollExecution } = await import('./helpers/stream');
    const { executionId: parentExecutionId } = await executePersisted(parent.id, { text: 'zz' }, adminCookie);
    expect(parentExecutionId).toBeTruthy();

    const parentExec = await pollExecution(request, parentExecutionId, 30000);
    expect(parentExec.status).toBe('completed');
    const outputStr = JSON.stringify(parentExec.output || {});
    expect(outputStr).toContain('persisted:zz');

    // The child flow was persisted as its own execution record
    const subRes = await request.get(`${API_URL}/executions?parent_execution_id=${parentExecutionId}`);
    expect(subRes.ok()).toBe(true);
    const subExecs = await subRes.json();
    const subList = Array.isArray(subExecs) ? subExecs : (subExecs.data || []);
    const sub = subList.find((e: any) => e.status === 'completed') || subList[0];
    expect(sub?.id).toBeTruthy();
    expect(sub.id).not.toBe(parentExecutionId);
    expect(sub.flow_id).toBe(child.id);
    expect(sub.status).toBe('completed');
    expect(JSON.stringify(sub.output)).toContain('persisted:zz');
  });
});
