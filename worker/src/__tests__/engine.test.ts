import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { FlowExecutor, HitlPauseError, PauseExecutionError } from '../executor/engine.js';
import { callLLM } from '../providers/index.js';
import type { FlowDefinition, FlowNode, FlowEdge } from 'orchestream-ai-shared';
import type { ExecutionContext } from '../executor/engine.js';

// Mock callLLM to avoid real API calls in LLM agent node tests
vi.mock('../providers/index.js', () => ({
  callLLM: vi.fn(() => Promise.resolve({ text: 'mock LLM response' })),
}));

// Sidecar eval mock — records every condition payload sent to the sandbox
const { mockEval } = vi.hoisted(() => ({ mockEval: vi.fn() }));
const { mockDnsLookup } = vi.hoisted(() => ({ mockDnsLookup: vi.fn() }));

// Mock bash tool to prevent sidecar HTTP calls for the code node; keep the real
// evaluateCondition so condition nodes exercise the sidecar eval routing
vi.mock('../tools/bash.js', async () => {
  const actual = await vi.importActual('../tools/bash.js');
  return {
    ...actual,
    executeCode: vi.fn((_client: any, _executionId: string, code: string, input: unknown) => {
      return new Function('input', code)(input);
    }),
    executeBash: vi.fn(async () => 'mock bash result'),
  };
});

// The http node fetches via the undici package (same version as its Agent
// dispatcher) — route it through a mock so http node tests don't hit the
// network. The http node test describe wires this up as its fetch mock.
const { httpMockFetch } = vi.hoisted(() => ({ httpMockFetch: vi.fn() }));
vi.mock('undici', async () => {
  const actual = await vi.importActual('undici');
  return { ...actual, fetch: httpMockFetch };
});

// Mock sidecar client to prevent HTTP calls — eval records payloads instead of executing them
vi.mock('../sandbox/sidecar-client.js', () => ({
  createSidecarClient: vi.fn(() => ({
    setup: vi.fn(async () => {}),
    exec: vi.fn(async () => ({ stdout: 'mocked', stderr: '', exitCode: 0 })),
    eval: mockEval,
    teardown: vi.fn(async () => {}),
  })),
}));

// Mock DNS so SSRF validation never performs real lookups
vi.mock('node:dns/promises', () => ({
  lookup: mockDnsLookup,
}));

function makeNode(id: string, nodeType: string, overrides: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: nodeType,
    position: { x: 0, y: 0 },
    data: {
      type: nodeType,
      label: id,
      config: {},
      ...overrides,
    } as any,
  };
}

function makeEdge(id: string, source: string, target: string, overrides: Partial<FlowEdge> = {}): FlowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: null,
    targetHandle: null,
    ...overrides,
  };
}

function makeFlow(nodes: FlowNode[], edges: FlowEdge[]): FlowDefinition {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    description: '',
    nodes,
    edges,
    version: 1,
    createdAt: '',
    updatedAt: '',
  };
}

describe('FlowExecutor', () => {
  let executor: FlowExecutor;
  let onEvent: any;
  let context: ExecutionContext;

  beforeEach(() => {
    executor = new FlowExecutor();
    onEvent = vi.fn();
    mockEval.mockReset();
    mockEval.mockResolvedValue({ ok: true, result: true });
    mockDnsLookup.mockReset();
    mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    context = {
      getEndpoint: vi.fn().mockResolvedValue({
        providerType: 'anthropic' as const,
        apiKey: 'test-key',
        baseUrl: null,
      }),
      sandboxExecutionId: 'test-exec-id',
    };
  });

  it('executes a simple flow with trigger and code node', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('mycode', 'code', { config: { code: 'return input;' } }),
      ],
      [makeEdge('e1', 'trigger', 'mycode')],
    );
    const flowDef = { ...makeFlow([], []), nodes: flow.nodes, edges: flow.edges };

    const result = await executor.execute(flowDef, { message: 'hello' }, onEvent, context);

    expect(result.output.trigger).toHaveProperty('message', 'hello');
    expect(result.steps).toHaveLength(2);
  });

  it('routes correctly through a branch node', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('branch', 'condition', { config: { condition: 'input.message === "yes"' } }),
        makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
        makeNode('llm2', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
      ],
      [
        makeEdge('e1', 'trigger', 'branch'),
        makeEdge('e2', 'branch', 'llm1', { sourceHandle: 'output-0' }),  // true path (label 'true' = index 0)
        makeEdge('e3', 'branch', 'llm2', { sourceHandle: 'output-1' }),  // false path (label 'false' = index 1)
      ],
    );

    const result = await executor.execute(flow, { message: 'yes' }, onEvent, context);

    expect(result.steps.some(s => s.nodeId === 'trigger')).toBe(true);
    expect(result.steps.some(s => s.nodeId === 'branch')).toBe(true);
    expect(result.steps.some(s => s.nodeId === 'llm1')).toBe(true);
    expect(result.steps.every(s => s.nodeId !== 'llm2')).toBe(true);
  });

  it('routes correctly through a switch node', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('switch', 'switch', {
          config: {
            fieldPath: 'trigger.status',
            cases: [
              { value: 'active', label: 'active' },
              { value: 'inactive', label: 'inactive' },
            ],
          },
        }),
        makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
        makeNode('llm2', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
      ],
      [
        makeEdge('e1', 'trigger', 'switch'),
        makeEdge('e2', 'switch', 'llm1', { sourceHandle: 'output-0' }),  // active path
        makeEdge('e3', 'switch', 'llm2', { sourceHandle: 'output-1' }),  // inactive path
      ],
    );

    const result = await executor.execute(flow, { status: 'active' }, onEvent, context);

    // llm1 (active) should have been reached
    expect(result.steps.some(s => s.nodeId === 'trigger')).toBe(true);
    expect(result.steps.some(s => s.nodeId === 'switch')).toBe(true);
    expect(result.steps.some(s => s.nodeId === 'llm1')).toBe(true);
    // llm2 (inactive) should be skipped
    expect(result.steps.every(s => s.nodeId !== 'llm2')).toBe(true);
  });

  it('routes through switch default path when no case matches', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('switch', 'switch', {
          config: {
            fieldPath: 'trigger.status',
            cases: [
              { value: 'active', label: 'active' },
            ],
            defaultPath: 'other',
          },
        }),
        makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
        makeNode('llm2', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
      ],
      [
        makeEdge('e1', 'trigger', 'switch'),
        makeEdge('e2', 'switch', 'llm1', { sourceHandle: 'output-0' }),  // active path
        makeEdge('e3', 'switch', 'llm2', { sourceHandle: 'output-1' }),  // default path
      ],
    );

    const result = await executor.execute(flow, { status: 'unknown' }, onEvent, context);

    // llm1 (active) should be skipped because "unknown" !== "active"
    expect(result.steps.every(s => s.nodeId !== 'llm1')).toBe(true);
    // llm2 (default path) should have been reached
    expect(result.steps.some(s => s.nodeId === 'llm2')).toBe(true);
  });

  it('records the fully injected prompt (context layers + resolved template + sandbox notes) on LLM Agent steps', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: 'Review this request: {{input.message}}', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
      ],
      [makeEdge('e1', 'trigger', 'llm1')],
    );
    context.getGlobalContext = vi.fn().mockResolvedValue('GLOBAL CONTEXT BLOCK');
    context.getGroupContext = vi.fn().mockResolvedValue('GROUP CONTEXT BLOCK');
    flow.groupId = 'grp-1';

    await executor.execute(flow, { message: 'hello' }, onEvent, context);

    const started = onEvent.mock.calls
      .map((c: any) => c[1])
      .find((e: any) => e.type === 'step.started' && e.data?.nodeId === 'llm1');
    expect(started).toBeDefined();
    const prompt: string = started.data.input.systemPrompt || '';

    // Context layering: global → group → node prompt (template resolved)
    expect(prompt).toContain('GLOBAL CONTEXT BLOCK');
    expect(prompt).toContain('GROUP CONTEXT BLOCK');
    expect(prompt).toContain('Review this request: hello');
    // Sandbox environment notes are injected after the layers
    expect(prompt).toContain('You are running inside a flow execution');
  });

  it('records the structured-output instruction on JSON LLM Agent steps', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'json_object' } }),
      ],
      [makeEdge('e1', 'trigger', 'llm1')],
    );

    await executor.execute(flow, { message: 'x' }, onEvent, context);

    const started = onEvent.mock.calls
      .map((c: any) => c[1])
      .find((e: any) => e.type === 'step.started' && e.data?.nodeId === 'llm1');
    expect(started!.data.input.systemPrompt).toContain('You must use the structured_output tool to respond');
  });

  it('output node filters input to only specified inputFields', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('output', 'output', {
          config: { inputFields: ['trigger.message'] },
        }),
      ],
      [makeEdge('e1', 'trigger', 'output')],
    );

    const result = await executor.execute(flow, { message: 'hello', secret: 'S3CR3T', extra: 'data' }, onEvent, context);
    expect(result.output?.output).toBe('hello');
  });

  it('throws HitlPauseError when executing a HITL node on first run', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('hitl', 'hitl', {
          config: {
            prompt: 'Approve this?', displayFields: [], forwardFields: [],
            buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }],
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'hitl')],
    );

    await expect(executor.execute(flow, { message: 'test' }, onEvent, context)).rejects.toThrow(HitlPauseError);
  });

  it('replays through a HITL node when _approved is in input', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('hitl', 'hitl', {
          config: {
            prompt: 'Approve this?', displayFields: [], forwardFields: [],
            buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }],
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'hitl')],
    );

    const result = await executor.execute(flow, { _approved: true, _decision: 'approved', _feedback: 'ok' }, onEvent, context);
    expect(Object.keys(result.output)).toContain('trigger');
    expect(result.steps.find(s => s.nodeId === 'hitl')?.output).toBeDefined();
  });

  it('resumes only the target HITL node via the per-node approval flag when replaying', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('hitl', 'hitl', {
          config: {
            prompt: 'Approve this?', displayFields: [], forwardFields: [],
            buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }],
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'hitl')],
    );

    const result = await executor.execute(flow, {}, onEvent, context, {
      replayFrom: 'hitl',
      replayOutputs: { 'hitl:__approved': { decision: 'approved', feedback: 'ok' } },
    });
    const hitlStep = result.steps.find(s => s.nodeId === 'hitl');
    expect(hitlStep?.output).toBeDefined();
    expect(hitlStep?.output?.decision).toBe('approved');
    expect(hitlStep?.output?.feedback).toBe('ok');
  });

  it('does not auto-approve a second HITL node when replaying a different one (node-scoped approval)', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('hitl1', 'hitl', {
          config: {
            prompt: 'First?', displayFields: [], forwardFields: [],
            buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }],
          },
        }),
        makeNode('hitl2', 'hitl', {
          config: {
            prompt: 'Second?', displayFields: [], forwardFields: [],
            buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }],
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'hitl1'), makeEdge('e2', 'hitl1', 'hitl2')],
    );

    await expect(
      executor.execute(flow, {}, onEvent, context, {
        replayFrom: 'hitl1',
        replayOutputs: { 'hitl1:__approved': { decision: 'approved' } },
      }),
    ).rejects.toMatchObject({ nodeId: 'hitl2' });
  });

  it('exits a HITL feedback loop via the max_iterations handle when maxIterations is reached', async () => {
    // trigger → code → hitl(buttons: retry) → feedback edge back to code
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('code', 'code', { config: { code: 'return { attempt: (input._iterationCount || 0) + 1 };' } }),
        makeNode('hitl', 'hitl', {
          config: {
            prompt: 'Retry?', displayFields: [], forwardFields: [],
            buttons: [{ label: 'Retry', value: 'retry' }],
            maxIterations: 2,
          },
        }),
        makeNode('out', 'output', { config: { inputFields: [] } }),
      ],
      [
        makeEdge('e1', 'trigger', 'code'),
        makeEdge('e2', 'code', 'hitl', { sourceHandle: 'output-0', targetHandle: 'input-0' }),
        // Feedback edge: hitl retry → back to code
        makeEdge('e3', 'hitl', 'code', { sourceHandle: 'output-0', targetHandle: 'input-0' }),
        makeEdge('e4', 'hitl', 'out', { sourceHandle: 'output-1', targetHandle: 'input-0' }),
      ],
    );

    // Round 1: fresh run — the HITL node pauses for human input
    await expect(executor.execute(flow, { start: true }, onEvent, context)).rejects.toThrow(HitlPauseError);

    // Round 2: replay the HITL with decision=retry → feedback loop re-runs the
    // upstream code node and pauses again at the HITL
    await expect(executor.execute(
      flow,
      { start: true, _iterationCount: 0 },
      onEvent,
      context,
      { replayFrom: 'hitl', replayOutputs: { 'hitl:__approved': { decision: 'retry', feedback: 'again' } }, inputOverride: { start: true, _iterationCount: 0 }, initialIteration: 1 },
    )).rejects.toThrow(HitlPauseError);

    // Round 3: maxIterations (2) reached → the HITL exits via the
    // max_iterations handle (output-1) and the output node runs
    const result = await executor.execute(
      flow,
      { start: true, _iterationCount: 1 },
      onEvent,
      context,
      { replayFrom: 'hitl', replayOutputs: { 'hitl:__approved': { decision: 'retry', feedback: 'again' } }, inputOverride: { start: true, _iterationCount: 1 }, initialIteration: 2 },
    );
    expect(result.output.hitl).toMatchObject({ decision: 'max_iterations' });
    expect(result.output.out).toBeDefined();
  });

  it('executes all sub-nodes in a parallel node', async () => {
    const subNodes: FlowNode[] = [
      makeNode('sub-a', 'output', { config: { inputFields: [] } }),
      makeNode('sub-b', 'output', { config: { inputFields: [] } }),
      makeNode('sub-c', 'output', { config: { inputFields: [] } }),
    ];

    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('parallel', 'parallel', { config: { subNodes } }),
      ],
      [makeEdge('e1', 'trigger', 'parallel')],
    );

    const result = await executor.execute(flow, { start: true }, onEvent, context);
    const parallelOutput = (result.output as any).parallel as Record<string, any>;

    expect(parallelOutput).toBeDefined();
    expect(Object.keys(parallelOutput)).toContain('sub-a');
    expect(Object.keys(parallelOutput)).toContain('sub-b');
    expect(Object.keys(parallelOutput)).toContain('sub-c');
  });

  it('stops execution when abort is called', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('slow', 'code', {
          config: { code: 'return new Promise(resolve => setTimeout(() => resolve({ done: true }), 500));' },
        }),
        makeNode('after', 'code', { config: { code: 'return { completed: true };' } }),
      ],
      [makeEdge('e1', 'trigger', 'slow'), makeEdge('e2', 'slow', 'after')],
    );

    const executePromise = executor.execute(flow, { data: 'test' }, onEvent, context);
    setTimeout(() => executor.abort(), 50);
    const result = await executePromise;

    expect(result.output.trigger).toBeDefined();
    expect(result.steps.map(s => s.nodeId)).not.toContain('after');
  });

  it('throws an error when the flow contains a cycle', async () => {
    const flow = makeFlow(
      [
        makeNode('a', 'trigger'),
        makeNode('b', 'code', { config: { code: 'return input;' } }),
        makeNode('c', 'code', { config: { code: 'return input;' } }),
      ],
      [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c'), makeEdge('e3', 'c', 'a')],
    );

    const result = await executor.execute(flow, {}, onEvent, context);
    expect(result.output).toBeDefined();
  });

  it('executes a note node as pass-through', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('note', 'note'),
      ],
      [makeEdge('e1', 'trigger', 'note')],
    );

    const result = await executor.execute(flow, { message: 'hello' }, onEvent, context);
    expect(result.steps.some(s => s.nodeId === 'note')).toBe(true);
    expect(result.output).toHaveProperty('trigger');
    expect(result.output).toHaveProperty('note');
  });

  it('executes a map node with replace mode', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('map', 'map', {
          config: {
            fields: [{ name: 'result', type: 'string', value: 'message' }],
            mode: 'replace',
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'map')],
    );

    const result = await executor.execute(flow, { message: 'hello' }, onEvent, context);
    // The map node's output is keyed by its node id
    expect(result.output.map).toHaveProperty('result', 'hello');
    expect(result.output.map).not.toHaveProperty('message');
  });

  it('executes a map node with merge mode', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('map', 'map', {
          config: {
            fields: [{ name: 'transformed', type: 'string', value: 'message' }],
            mode: 'merge',
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'map')],
    );

    const result = await executor.execute(flow, { message: 'hello' }, onEvent, context);
    // In merge mode, upstream data is preserved in the map output plus mapped fields
    expect(result.output.map).toHaveProperty('message', 'hello');
    expect(result.output.map).toHaveProperty('transformed', 'hello');
  });

  it('executes a delay node with fixed seconds (throws PauseExecutionError)', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('delay', 'delay', {
          config: { type: 'fixed', seconds: 5 },
        }),
      ],
      [makeEdge('e1', 'trigger', 'delay')],
    );

    await expect(executor.execute(flow, { message: 'test' }, onEvent, context))
      .rejects.toThrow(PauseExecutionError);
  });

  it('executes ai-action node and returns LLM response', async () => {
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('ai', 'ai-action', {
          config: {
            endpointId: 'ep1',
            model: 'claude-3-haiku',
            prompt: 'Summarize: {{input.trigger.message}}',
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'ai')],
    );

    const result = await executor.execute(flow, { message: 'hello world' }, onEvent, context);
    expect(result.steps.some(s => s.nodeId === 'ai')).toBe(true);
    expect(result.output.ai).toHaveProperty('content');
  });

  it('throws if ai-action node has no endpointId', async () => {
    const flow = makeFlow(
      [makeNode('ai', 'ai-action', { config: { endpointId: '', model: 'claude', prompt: 'test' } })],
      [],
    );

    await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('endpointId');
  });

  it('throws if ai-action node has no model', async () => {
    const flow = makeFlow(
      [makeNode('ai', 'ai-action', { config: { endpointId: 'ep1', model: '', prompt: 'test' } })],
      [],
    );

    await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('model');
  });

  it('throws if ai-action node has no prompt', async () => {
    const flow = makeFlow(
      [makeNode('ai', 'ai-action', { config: { endpointId: 'ep1', model: 'claude', prompt: '' } })],
      [],
    );

    await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('prompt');
  });

  it('executes a loop node over an array', async () => {
    const items = [{ id: 1 }, { id: 2 }];
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('loop', 'loop', {
          config: {
            itemsField: 'trigger.items',
            itemVariable: 'item',
            collectResults: true,
            subNodes: [makeNode('sub', 'output', { config: { inputFields: [] } })],
            subEdges: [],
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'loop')],
    );

    const result = await executor.execute(flow, { items }, onEvent, context);
    expect(result.steps.some(s => s.nodeId === 'loop')).toBe(true);
  });

  it('throws if loop node has no itemsField', async () => {
    const flow = makeFlow(
      [makeNode('loop', 'loop', { config: { itemsField: '' } })],
      [],
    );

    await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('itemsField');
  });

  it('throws if loop node field is not an array', async () => {
    const flow = makeFlow(
      [makeNode('loop', 'loop', { config: { itemsField: 'trigger.message' } })],
      [],
    );

    await expect(executor.execute(flow, { message: 'not-an-array' }, onEvent, context)).rejects.toThrow('not an array');
  });

  it('executes a loop node without collecting results', async () => {
    const items = [{ id: 1 }, { id: 2 }];
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('loop', 'loop', {
          config: {
            itemsField: 'trigger.items',
            itemVariable: 'item',
            collectResults: false,
            subNodes: [makeNode('sub', 'output', { config: { inputFields: [] } })],
            subEdges: [],
          },
        }),
      ],
      [makeEdge('e1', 'trigger', 'loop')],
    );

    const result = await executor.execute(flow, { items }, onEvent, context);
    expect(result.steps.some(s => s.nodeId === 'loop')).toBe(true);
  });

  describe('http node', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeAll(() => {
      mockFetch = httpMockFetch;
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      mockFetch.mockReset();
    });

    afterAll(() => {
      vi.unstubAllGlobals();
    });

    it('executes GET request', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map([['content-type', 'application/json']]),
        text: () => Promise.resolve('{"data":"ok"}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com/data' } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/data', expect.objectContaining({ method: 'GET' }));
      expect((result.output as any).http).toHaveProperty('status', 200);
      expect((result.output as any).http).toHaveProperty('ok', true);
      expect(((result.output as any).http).body).toEqual({ data: 'ok' });
    });

    it('executes POST request with body and headers', async () => {
      mockFetch.mockResolvedValue({
        status: 201, statusText: 'Created', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{"id":1}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', {
          config: {
            method: 'POST', url: 'https://api.example.com/data',
            headers: '{"Authorization":"Bearer test"}',
            body: '{"name":"test"}',
          },
        })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/data', expect.objectContaining({
        method: 'POST', body: '{"name":"test"}',
      }));
      expect((result.output as any).http).toHaveProperty('status', 201);
    });

    it('executes PUT request', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { method: 'PUT', url: 'https://api.example.com/data/1', body: '{}' } })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'PUT' }));
    });

    it('executes DELETE request', async () => {
      mockFetch.mockResolvedValue({
        status: 204, statusText: 'No Content', ok: true,
        headers: new Map(),
        text: () => Promise.resolve(''),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { method: 'DELETE', url: 'https://api.example.com/data/1' } })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'DELETE' }));
    });

    it('executes PATCH request', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { method: 'PATCH', url: 'https://api.example.com/data/1', body: '{}' } })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'PATCH' }));
    });

    it('executes HEAD request', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map([['content-length', '42']]),
        text: () => Promise.resolve(''),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { method: 'HEAD', url: 'https://api.example.com/data' } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'HEAD' }));
      expect((result.output as any).http).toHaveProperty('status', 200);
    });

    it('applies Basic auth headers', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', {
          config: { url: 'https://api.example.com', authType: 'basic', authUsername: 'admin', authPassword: 'secret' },
        })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      const args = mockFetch.mock.calls[0][1];
      expect(args.headers['Authorization']).toMatch(/^Basic /);
    });

    it('applies Bearer token headers', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', {
          config: { url: 'https://api.example.com', authType: 'bearer', authToken: 'mytoken' },
        })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      const args = mockFetch.mock.calls[0][1];
      expect(args.headers['Authorization']).toBe('Bearer mytoken');
    });

    it('applies API Key auth headers', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', {
          config: { url: 'https://api.example.com', authType: 'api-key', authKeyName: 'X-API-Key', authKeyValue: 'abc123' },
        })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      const args = mockFetch.mock.calls[0][1];
      expect(args.headers['X-API-Key']).toBe('abc123');
    });

    it('applies HMAC signing', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', {
          config: { method: 'POST', url: 'https://api.example.com', body: '{"data":"test"}', hmacSecret: 'secret-key', hmacHeader: 'X-Signature' },
        })],
        [],
      );
      await executor.execute(flow, {}, onEvent, context);
      const args = mockFetch.mock.calls[0][1];
      expect(args.headers['X-Signature']).toMatch(/^[a-f0-9]{64}$/);
    });

    it('parses JSON response body', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('{"user":"alice","score":42}'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com/user' } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(((result.output as any).http).body).toEqual({ user: 'alice', score: 42 });
    });

    it('returns raw text for non-JSON body', async () => {
      mockFetch.mockResolvedValue({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        text: () => Promise.resolve('plain text'),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com' } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(((result.output as any).http).body).toBe('plain text');
    });

    it('throws when URL is empty', async () => {
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: '' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('URL is required');
    });

    it('throws on invalid headers JSON', async () => {
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com', headers: 'not-json' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('headers must be valid JSON');
    });

    it('blocks requests to private IPs (SSRF)', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('private or restricted');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('blocks requests when any resolved IP is private (SSRF)', async () => {
      mockDnsLookup.mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
        { address: '10.1.2.3', family: 4 },
      ]);
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('private or restricted');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('blocks IPv6 loopback (SSRF)', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('private or restricted');
    });

    it('blocks IPv4-mapped IPv6 loopback (SSRF)', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('private or restricted');
    });

    it('rejects non-http(s) schemes (SSRF)', async () => {
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'file:///etc/passwd' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('unsupported protocol');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects invalid URLs', async () => {
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'not a url' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('invalid URL');
    });

    it('re-validates DNS on every redirect hop (SSRF)', async () => {
      mockDnsLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
      mockDnsLookup.mockResolvedValueOnce([{ address: '192.168.1.5', family: 4 }]);
      mockFetch.mockResolvedValueOnce({
        status: 302, statusText: 'Found', ok: false,
        headers: new Map([['location', 'https://internal.example.com/secret']]),
        text: () => Promise.resolve(''),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com/start' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('private or restricted');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('follows redirects up to 5 hops when followRedirects is set', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      mockFetch
        .mockResolvedValueOnce({
          status: 302, statusText: 'Found', ok: false,
          headers: new Map([['location', 'https://api.example.com/v2']]),
          text: () => Promise.resolve(''),
        })
        .mockResolvedValueOnce({
          status: 200, statusText: 'OK', ok: true,
          headers: new Map([['content-type', 'application/json']]),
          text: () => Promise.resolve('{"data":"ok"}'),
        });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com/start' } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect((result.output as any).http).toHaveProperty('status', 200);
      expect(((result.output as any).http).body).toEqual({ data: 'ok' });
    });

    it('returns the redirect response itself when followRedirects is off', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      mockFetch.mockResolvedValueOnce({
        status: 302, statusText: 'Found', ok: false,
        headers: new Map([['location', 'https://evil.example.com']]),
        text: () => Promise.resolve(''),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com', followRedirects: false } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect((result.output as any).http).toHaveProperty('status', 302);
    });

    it('stops after too many redirects', async () => {
      mockDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      mockFetch.mockResolvedValue({
        status: 302, statusText: 'Found', ok: false,
        headers: new Map([['location', 'https://api.example.com/loop']]),
        text: () => Promise.resolve(''),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com/start' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('too many redirects');
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it('aborts when the response body exceeds 10 MB', async () => {
      const bigBody = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('x'.repeat(11 * 1024 * 1024)));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce({
        status: 200, statusText: 'OK', ok: true,
        headers: new Map(),
        body: bigBody,
        text: () => Promise.resolve(''),
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('10 MB limit');
    }, 15000);

    it('times out after configured timeout', async () => {
      mockFetch.mockImplementation(async (_url: string, options: any) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });
      const flow = makeFlow(
        [makeNode('http', 'http', { config: { url: 'https://api.example.com', timeout: 50 } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('Aborted');
    }, 10000);
  });

  describe('condition node sandbox routing', () => {
    it('routes condition evaluation to the sidecar eval endpoint', async () => {
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('branch', 'condition', { config: { condition: 'input.message === "yes"' } }),
          makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
          makeNode('llm2', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
        ],
        [
          makeEdge('e1', 'trigger', 'branch'),
          makeEdge('e2', 'branch', 'llm1', { sourceHandle: 'output-0' }),
          makeEdge('e3', 'branch', 'llm2', { sourceHandle: 'output-1' }),
        ],
      );

      const result = await executor.execute(flow, { message: 'yes' }, onEvent, context);

      expect(mockEval).toHaveBeenCalledTimes(1);
      const [request] = mockEval.mock.calls[0];
      expect(request.executionId).toBe('test-exec-id');
      expect(request.code).toBe('input.message === "yes"');
      expect(request.input.message).toBe('yes');
      expect(result.steps.some(s => s.nodeId === 'llm1')).toBe(true);
      expect(result.steps.every(s => s.nodeId !== 'llm2')).toBe(true);
    });

    it('passes injected payloads to the sidecar as data — never executes them in-process', async () => {
      const payload = `(function(){ require('child_process').execSync('touch /tmp/pwned'); return true })()`;
      mockEval.mockResolvedValue({ ok: false, error: 'syntax error' });

      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('branch', 'condition', { config: { condition: '{{input.payload}}', outputLabels: ['true', 'false'] } }),
        ],
        [makeEdge('e1', 'trigger', 'branch')],
      );

      await expect(executor.execute(flow, { payload }, onEvent, context)).rejects.toThrow(
        'does not match any output label',
      );

      // The raw payload must arrive at the sidecar untouched — the worker never compiled it
      expect(mockEval).toHaveBeenCalledTimes(1);
      const [request] = mockEval.mock.calls[0];
      expect(request.code).toBe(payload);
      expect(request.input.payload).toBe(payload);
    });

    it('fails the node when the sidecar is unreachable (no in-process fallback)', async () => {
      mockEval.mockRejectedValue(new Error('connection refused'));

      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('branch', 'condition', { config: { condition: 'input.message === "yes"' } }),
        ],
        [makeEdge('e1', 'trigger', 'branch')],
      );

      await expect(executor.execute(flow, { message: 'yes' }, onEvent, context)).rejects.toThrow(
        'failed to evaluate condition in sandbox',
      );
    });

    it('preserves value mode when the condition is not valid JS', async () => {
      mockEval.mockResolvedValue({ ok: false, error: 'ReferenceError: active is not defined' });

      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('branch', 'condition', {
            config: { condition: '{{input.status}}', outputLabels: ['active', 'inactive'] },
          }),
          makeNode('llm1', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
          makeNode('llm2', 'llm-agent', { config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', temperature: 0.7, maxTokens: 1000, responseFormat: 'text' } }),
        ],
        [
          makeEdge('e1', 'trigger', 'branch'),
          makeEdge('e2', 'branch', 'llm1', { sourceHandle: 'output-0' }),
          makeEdge('e3', 'branch', 'llm2', { sourceHandle: 'output-1' }),
        ],
      );

      const result = await executor.execute(flow, { status: 'active' }, onEvent, context);
      expect(result.steps.some(s => s.nodeId === 'llm1')).toBe(true);
      expect(result.steps.every(s => s.nodeId !== 'llm2')).toBe(true);
    });

    it('throws when the sandbox execution context is missing', async () => {
      context.sandboxExecutionId = undefined;
      const flow = makeFlow(
        [makeNode('branch', 'condition', { config: { condition: 'true' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('sandbox not available');
      expect(mockEval).not.toHaveBeenCalled();
    });
  });

  describe('loop node limits', () => {
    it('aborts loop sub-executions when the executor is aborted', async () => {
      const bashMock = await import('../tools/bash.js') as any;
      bashMock.executeCode.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { done: true };
      });

      const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('loop', 'loop', {
            config: {
              itemsField: 'trigger.items',
              itemVariable: 'item',
              collectResults: true,
              subNodes: [makeNode('sub', 'code', { config: { code: 'return input;' } })],
              subEdges: [],
            },
          }),
        ],
        [makeEdge('e1', 'trigger', 'loop')],
      );

      const executePromise = executor.execute(flow, { items }, onEvent, context);
      setTimeout(() => executor.abort(), 30);
      const result = await executePromise;

      const loopOutput = result.output.loop as any;
      expect(loopOutput.count).toBeLessThan(100);
      expect(loopOutput.count).toBeGreaterThan(0);
      expect(loopOutput.aborted).toBe(true);
      expect(loopOutput.results.length).toBeLessThan(100);

      bashMock.executeCode.mockImplementation((_client: any, _executionId: string, code: string, input: unknown) => {
        return new Function('input', code)(input);
      });
    }, 15000);

    it('caps loop items at MAX_LOOP_ITEMS', async () => {
      vi.resetModules();
      process.env.MAX_LOOP_ITEMS = '3';
      const { FlowExecutor: ReloadedExecutor } = await import('../executor/engine.js');
      const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('loop', 'loop', {
            config: {
              itemsField: 'trigger.items',
              itemVariable: 'item',
              collectResults: true,
              subNodes: [makeNode('sub', 'output', { config: { inputFields: [] } })],
              subEdges: [],
            },
          }),
        ],
        [makeEdge('e1', 'trigger', 'loop')],
      );
      const cappedExecutor = new ReloadedExecutor();
      const result = await cappedExecutor.execute(flow, { items }, vi.fn(), context);
      const loopOutput = result.output.loop as any;
      expect(loopOutput.count).toBe(3);
      expect(loopOutput.results.length).toBe(3);
      delete process.env.MAX_LOOP_ITEMS;
    });
  });

  describe('prototype pollution', () => {
    it('strips __proto__/constructor keys from untrusted flow input before merging', async () => {
      const input = JSON.parse('{"message":"hello","__proto__":{"polluted":"PWNED"},"constructor":{"evil":true}}');
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('probe', 'code', { config: { code: 'return { polluted: input.polluted, evil: input.evil };' } }),
        ],
        [makeEdge('e1', 'trigger', 'probe')],
      );

      const result = await executor.execute(flow, input, onEvent, context);
      expect(result.output.probe).toEqual({ polluted: undefined, evil: undefined });
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  describe('delay node', () => {
    it('throws PauseExecutionError for fixed seconds', async () => {
      const flow = makeFlow(
        [makeNode('delay', 'delay', { config: { type: 'fixed', seconds: 5 } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow(PauseExecutionError);
    });

    it('throws PauseExecutionError for duration type', async () => {
      const flow = makeFlow(
        [makeNode('delay', 'delay', { config: { type: 'duration', duration: 'PT30S' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow(PauseExecutionError);
    });

    it('throws PauseExecutionError for timestamp type', async () => {
      const future = new Date(Date.now() + 60000).toISOString();
      const flow = makeFlow(
        [makeNode('delay', 'delay', { config: { type: 'timestamp', timestamp: future } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow(PauseExecutionError);
    });

    it('throws on invalid duration string', async () => {
      const flow = makeFlow(
        [makeNode('delay', 'delay', { config: { type: 'duration', duration: 'invalid' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('invalid ISO 8601 duration');
    });

    it('throws on invalid timestamp', async () => {
      const flow = makeFlow(
        [makeNode('delay', 'delay', { config: { type: 'timestamp', timestamp: 'not-a-date' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('invalid timestamp');
    });

    it('returns delayed:false when delay is 0', async () => {
      const flow = makeFlow(
        [makeNode('trigger', 'trigger'), makeNode('delay', 'delay', { config: { type: 'fixed', seconds: 0 } })],
        [makeEdge('e1', 'trigger', 'delay')],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(result.output.delay).toHaveProperty('delayed', false);
    });

    it('returns delayed:false when seconds is undefined', async () => {
      const flow = makeFlow(
        [makeNode('delay', 'delay', { config: { type: 'fixed' } })],
        [],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(result.output.delay).toHaveProperty('delayed', false);
    });

    it('skips the pause when replaying from the delay node (delayed resume)', async () => {
      const flow = makeFlow(
        [makeNode('trigger', 'trigger'), makeNode('delay', 'delay', { config: { type: 'fixed', seconds: 5 } })],
        [makeEdge('e1', 'trigger', 'delay')],
      );
      const result = await executor.execute(flow, {}, onEvent, context, {
        replayFrom: 'delay',
        replayOutputs: {},
      });
      expect(result.output.delay).toHaveProperty('delayed', false);
    });
  });

  describe('ai-action error cases', () => {
    it('throws when endpoint is not found', async () => {
      context.getEndpoint = vi.fn().mockResolvedValue(null);
      const flow = makeFlow(
        [makeNode('ai', 'ai-action', { config: { endpointId: 'missing', model: 'claude', prompt: 'test' } })],
        [],
      );
      await expect(executor.execute(flow, {}, onEvent, context)).rejects.toThrow('not found');
    });
  });

  describe('llm-agent tool loop failure recovery', () => {
    const defaultCallLLM = vi.fn(() => Promise.resolve({ text: 'mock LLM response' }));
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('l1', 'llm-agent', {
          config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', responseFormat: 'text' },
        }),
      ],
      [makeEdge('e1', 'trigger', 'l1')],
    );

    it('recovers from a transient LLM failure and keeps looping', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      let calls = 0;
      mockCallLLM.mockImplementation(async () => {
        calls++;
        if (calls === 1) throw new Error('connection reset');
        if (calls === 2) return { text: '', toolCalls: [{ id: 't1', name: 'store_get', input: { key: 'k' } }] };
        return { text: 'wrapped up', toolCalls: [] };
      });

      const result = await executor.execute(flow, { message: 'hi' }, onEvent, context);

      expect(calls).toBe(3);
      const msgs = mockCallLLM.mock.calls[1][0].messages;
      expect(msgs.some((m: any) => m.role === 'user' && String(m.content).includes('LLM API call failed'))).toBe(true);
      expect((result.output as any).l1.content).toBe('wrapped up');
      mockCallLLM.mockImplementation(defaultCallLLM);
    });

    it('fails the node after two consecutive LLM failures instead of hanging', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      mockCallLLM.mockRejectedValue(new Error('rate limited'));

      await expect(executor.execute(flow, { message: 'hi' }, onEvent, context)).rejects.toThrow(
        'LLM API call failed repeatedly',
      );
      mockCallLLM.mockImplementation(defaultCallLLM);
    });

    it('continues the loop when a response is truncated (finishReason length) and keeps the partial text', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      let calls = 0;
      mockCallLLM.mockImplementation(async () => {
        calls++;
        if (calls === 1) return { text: 'PART ONE: the review begins', finishReason: 'length', toolCalls: [] };
        return { text: 'PART TWO: the review ends', finishReason: 'stop', toolCalls: [] };
      });

      const result = await executor.execute(flow, { message: 'hi' }, onEvent, context);

      expect(calls).toBe(2);
      // The truncated response must not be treated as the final answer:
      // the loop continues and the final output concatenates both parts.
      expect((result.output as any).l1.content).toBe('PART ONE: the review beginsPART TWO: the review ends');
      const msgs = mockCallLLM.mock.calls[1][0].messages;
      expect(msgs.some((m: any) => m.role === 'user' && String(m.content).includes('cut off'))).toBe(true);
      mockCallLLM.mockImplementation(defaultCallLLM);
    });

    it('trims the conversation and retries when the provider reports a context overflow', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      let calls = 0;
      mockCallLLM.mockImplementation(async () => {
        calls++;
        // Several tool rounds first so there is middle history to trim
        if (calls < 6) return { text: 'exploring...', toolCalls: [{ id: `t${calls}`, name: 'store_get', input: { key: 'k' } }] };
        if (calls === 6) throw new Error("This model's maximum context length is 64000 tokens. However, your messages resulted in 80000 tokens.");
        return { text: 'final answer after trim', toolCalls: [] };
      });

      const result = await executor.execute(flow, { message: 'hi' }, onEvent, context);

      expect(calls).toBe(7);
      expect((result.output as any).l1.content).toBe('final answer after trim');
      // The conversation was compacted (head kept, oldest rounds dropped) and
      // the model was told the context was trimmed.
      const msgs = mockCallLLM.mock.calls[6][0].messages;
      expect(msgs[msgs.length - 1].content).toContain('trimmed');
      mockCallLLM.mockImplementation(defaultCallLLM);
    });

    it('fails the node when trimming cannot fix a context overflow', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      // A conversation with only the initial messages cannot be trimmed —
      // the overflow must surface as a node failure instead of hanging.
      mockCallLLM.mockRejectedValue(new Error('maximum context length exceeded'));

      await expect(executor.execute(flow, { message: 'hi' }, onEvent, context)).rejects.toThrow(
        'LLM API call failed repeatedly',
      );
      mockCallLLM.mockImplementation(defaultCallLLM);
    });
  });

  describe('llm-agent prompt-only contract', () => {
    const defaultCallLLM = vi.fn(() => Promise.resolve({ text: 'mock LLM response' }));
    const flow = makeFlow(
      [
        makeNode('trigger', 'trigger'),
        makeNode('l1', 'llm-agent', {
          config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: '', responseFormat: 'text' },
        }),
      ],
      [makeEdge('e1', 'trigger', 'l1')],
    );

    afterEach(() => {
      vi.mocked(callLLM).mockImplementation(defaultCallLLM);
    });

    function lastMessages(): any[] {
      const mockCallLLM = vi.mocked(callLLM);
      return mockCallLLM.mock.calls[mockCallLLM.mock.calls.length - 1][0].messages;
    }

    it('never sends run input data as the user message', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();

      const secret = 'https://github.com/keeshus/TopSecretRepo';
      await executor.execute(
        flow,
        { message: secret, trigger: { message: secret }, upstream: { internal: 'classified' } },
        onEvent,
        context,
      );

      const msgs = lastMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe('user');
      expect(msgs[0].content).toBe('Proceed.');
      expect(JSON.stringify(msgs)).not.toContain('TopSecretRepo');
      expect(JSON.stringify(msgs)).not.toContain('classified');
    });

    it('never sends chat_input as a user message either', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();

      await executor.execute(
        flow,
        {
          chat_input: {
            message: 'chat secret message',
            history: [{ role: 'user', content: 'old turn' }],
          },
          message: 'chat secret message',
          history: [{ role: 'user', content: 'old turn' }],
        },
        onEvent,
        context,
      );

      const msgs = lastMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('Proceed.');
      expect(JSON.stringify(msgs)).not.toContain('chat secret message');
      expect(JSON.stringify(msgs)).not.toContain('old turn');
    });

    it('resolves {{input.…}} variables in the system prompt', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      const promptFlow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('l1', 'llm-agent', {
            config: { endpointId: 'ep1', model: 'claude-3', systemPrompt: 'Review this repo: {{input.trigger.message}}', responseFormat: 'text' },
          }),
        ],
        [makeEdge('e1', 'trigger', 'l1')],
      );

      await executor.execute(promptFlow, { message: 'https://github.com/keeshus/CoreTemplate' }, onEvent, context);

      const call = mockCallLLM.mock.calls[0][0];
      expect(String(call.systemPrompt)).toContain('Review this repo: https://github.com/keeshus/CoreTemplate');
    });

    it('resolves {{input.message}} and {{input.history}} variables in the system prompt (chat flows)', async () => {
      const mockCallLLM = vi.mocked(callLLM);
      mockCallLLM.mockClear();
      const promptFlow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('l1', 'llm-agent', {
            config: {
              endpointId: 'ep1', model: 'claude-3',
              systemPrompt: 'User said: {{input.message}}\nHistory: {{input.history}}',
              responseFormat: 'text',
            },
          }),
        ],
        [makeEdge('e1', 'trigger', 'l1')],
      );

      await executor.execute(
        promptFlow,
        { message: 'hello', history: [{ role: 'user', content: 'hi' }] },
        onEvent,
        context,
      );

      const call = mockCallLLM.mock.calls[0][0];
      const prompt = String(call.systemPrompt);
      expect(prompt).toContain('User said: hello');
      expect(prompt).toContain('History: [{');
      expect(prompt).toContain('"role":"user"');
    });
  });

  describe('map edge cases', () => {
    it('returns empty object with no fields', async () => {
      const flow = makeFlow(
        [makeNode('trigger', 'trigger'), makeNode('map', 'map', { config: { fields: [], mode: 'replace' } })],
        [makeEdge('e1', 'trigger', 'map')],
      );
      const result = await executor.execute(flow, { x: 1 }, onEvent, context);
      expect(result.output.map).toEqual({});
    });

    it('sets null for undefined value', async () => {
      const flow = makeFlow(
        [makeNode('trigger', 'trigger'), makeNode('map', 'map', {
          config: { fields: [{ name: 'missing', type: 'string', value: 'nonexistent.path' }], mode: 'replace' },
        })],
        [makeEdge('e1', 'trigger', 'map')],
      );
      const result = await executor.execute(flow, {}, onEvent, context);
      expect(result.output.map).toHaveProperty('missing', null);
    });
  });

  describe('condition node defaultPath', () => {
    it('routes to the configured default path when the condition value matches no label', async () => {
      mockEval.mockResolvedValue({ ok: true, result: 'unknown-value' });
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('cond', 'condition', {
            config: {
              condition: 'input.value',
              outputLabels: ['yes', 'no'],
              defaultPath: 'no',
            },
          }),
          makeNode('out-yes', 'output', { config: { inputFields: [] } }),
          makeNode('out-no', 'output', { config: { inputFields: [] } }),
        ],
        [
          makeEdge('e1', 'trigger', 'cond'),
          makeEdge('e2', 'cond', 'out-yes', { sourceHandle: 'output-0', targetHandle: 'input-0' }),
          makeEdge('e3', 'cond', 'out-no', { sourceHandle: 'output-1', targetHandle: 'input-0' }),
        ],
      );
      const result = await executor.execute(flow, { value: 'unmatched' }, onEvent, context);
      // The default path ('no') is followed; the unmatched 'yes' branch is skipped
      expect(result.output['out-no']).toBeDefined();
      expect(result.output['out-yes']).toEqual({ skipped: true, reason: 'No matching route' });
    });
  });

  describe('parallel node failure handling', () => {
    it('aborts sibling sub-nodes when one sub-node throws', async () => {
      const bashMock = await import('../tools/bash.js') as any;
      const slowFn = bashMock.executeCode;
      slowFn.mockImplementation(async (_c: any, _e: string, code: string, input: unknown) => {
        if (code.includes('throw')) throw new Error('sub-node exploded');
        await new Promise(resolve => setTimeout(resolve, 30));
        return { ok: true };
      });

      const subNodes: FlowNode[] = [
        makeNode('sub-fail', 'code', { config: { code: 'throw new Error("sub-node exploded")' } }),
        makeNode('sub-slow', 'code', { config: { code: 'return { ok: true }' } }),
      ];
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('parallel', 'parallel', { config: { subNodes } }),
        ],
        [makeEdge('e1', 'trigger', 'parallel')],
      );

      await expect(executor.execute(flow, { start: true }, onEvent, context)).rejects.toThrow('sub-node exploded');

      // Restore the default executeCode implementation
      slowFn.mockImplementation((_client: any, _executionId: string, code: string, input: unknown) => {
        return new Function('input', code)(input);
      });
    });
  });

  describe('loop error collection', () => {
    it('collects per-iteration errors without failing the whole flow', async () => {
      const bashMock = await import('../tools/bash.js') as any;
      const codeFn = bashMock.executeCode;
      codeFn.mockImplementation(async (_c: any, _e: string, code: string, input: any) => {
        if (input?.item?.id === 1) throw new Error('iteration 1 failed');
        return { processed: input?.item?.id };
      });

      const items = [{ id: 0 }, { id: 1 }, { id: 2 }];
      const flow = makeFlow(
        [
          makeNode('trigger', 'trigger'),
          makeNode('loop', 'loop', {
            config: {
              itemsField: 'trigger.items',
              itemVariable: 'item',
              collectResults: true,
              subNodes: [makeNode('sub', 'code', { config: { code: 'return { processed: input.item.id }' } })],
              subEdges: [],
            },
          }),
        ],
        [makeEdge('e1', 'trigger', 'loop')],
      );

      const result = await executor.execute(flow, { items }, onEvent, context);
      const loopOutput = result.output.loop as any;
      expect(loopOutput.count).toBe(3);
      // The failing iteration is recorded, the flow completes
      expect(loopOutput.errors).toBeDefined();
      expect(Array.isArray(loopOutput.errors)).toBe(true);
      expect(loopOutput.errors.length).toBeGreaterThanOrEqual(1);

      codeFn.mockImplementation((_client: any, _executionId: string, code: string, input: unknown) => {
        return new Function('input', code)(input);
      });
    });
  });
});
