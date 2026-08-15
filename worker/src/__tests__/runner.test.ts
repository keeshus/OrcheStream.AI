import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeFlowWithPersistence } from '../executor/runner.js';

// Mock the sandbox + queue so no real sidecar / Redis is touched
vi.mock('../sandbox/index.js', () => ({
  createSidecarClient: vi.fn(() => ({})),
  createSandboxManager: vi.fn(() => ({
    setup: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
  })),
}));

vi.mock('../queue.js', () => ({
  executionQueue: { add: vi.fn(async () => {}) },
}));

// Mock the engine so we can drive success / HITL / delay / failure paths
const { mockExecute, mockSetCalls, mockInsertCalls } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSetCalls: vi.fn(),
  mockInsertCalls: vi.fn(),
}));

vi.mock('../executor/engine.js', async () => {
  const actual = await vi.importActual('../executor/engine.js');
  return {
    ...actual,
    FlowExecutor: vi.fn(function FlowExecutorMock() {
      return { execute: mockExecute };
    }),
  };
});

import { HitlPauseError, PauseExecutionError, FlowStopError } from '../executor/engine.js';
import { executionQueue } from '../queue.js';

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    flow: {
      id: 'flow-1', name: 'Test', description: '', nodes: [], edges: [], version: 1,
      envVars: [{ name: 'FLOW_ONLY', value: 'from-flow', type: 'static' }],
    },
    input: { message: 'hi', __env: { HACKED: 'x' }, __executionId: 'exec-1' },
    executionId: 'exec-1',
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })) })),
      insert: vi.fn((table: any) => ({ values: (vals: any) => { mockInsertCalls(table, vals); return Promise.resolve(); } })),
      update: vi.fn(() => ({ set: (data: any) => { mockSetCalls(data); return { where: vi.fn(async () => {}) }; } })),
    },
    executionsTable: {},
    executionStepsTable: {},
    eq: vi.fn((a: any) => a),
    and: vi.fn((...args: any[]) => args),
    ...overrides,
  } as any;
}

describe('executeFlowWithPersistence', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockSetCalls.mockReset();
    mockInsertCalls.mockReset();
  });

  it('strips client-supplied __env and replay metadata before the engine sees input', async () => {
    mockExecute.mockResolvedValue({ output: { ok: true } });
    const options = makeOptions();

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('completed');
    const engineInput = mockExecute.mock.calls[0][1];
    expect(engineInput).not.toHaveProperty('__env');
    expect(engineInput).not.toHaveProperty('__executionId');
    expect(engineInput).not.toHaveProperty('__replayFrom');
    expect(engineInput.message).toBe('hi');
    // Only the flow's own env vars reach the sandbox context
    const context = mockExecute.mock.calls[0][3];
    expect(context.sandboxEnv).toEqual({ FLOW_ONLY: 'from-flow' });
  });

  it('marks the execution completed on success', async () => {
    mockExecute.mockResolvedValue({ output: { ok: true } });
    const options = makeOptions();

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('completed');
    expect(mockSetCalls.mock.calls.some((c: any[]) => c[0]?.status === 'completed')).toBe(true);
  });

  it('stores awaiting_approval + mirrors an assignment when the flow pauses on HITL', async () => {
    mockExecute.mockImplementation(async () => {
      throw new HitlPauseError('h1', { a: 1 }, [{ label: 'Go', value: 'go' }], 'Approve?', undefined, undefined, 1);
    });
    const options = makeOptions({ userAssignmentsTable: {} });

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('awaiting_approval');
    expect(mockSetCalls.mock.calls.some((c: any[]) => c[0]?.status === 'awaiting_approval')).toBe(true);
    // Assignment mirror insert fired against the assignments table
    expect(mockInsertCalls.mock.calls.some((c: any[]) => c[0] === options.userAssignmentsTable)).toBe(true);
  });

  it('schedules a delayed re-run on PauseExecutionError and keeps execution running', async () => {
    mockExecute.mockImplementation(async () => {
      throw new PauseExecutionError('d1', { x: 1 }, 5000);
    });
    const options = makeOptions();

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('running');
    expect(result.delayResumeAt).toBeGreaterThan(Date.now());
    expect(executionQueue.add).toHaveBeenCalledWith(
      'execute-flow',
      expect.objectContaining({ input: expect.objectContaining({ __replayFrom: 'd1' }) }),
      expect.objectContaining({ delay: 5000 }),
    );
  });

  it('carries per-run env overrides into the delayed resume job', async () => {
    mockExecute.mockImplementation(async () => {
      throw new PauseExecutionError('d1', { x: 1 }, 5000);
    });
    const options = makeOptions({ envOverrides: { DB_HOST: 'override-host' } });

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('running');
    expect(executionQueue.add).toHaveBeenCalledWith(
      'execute-flow',
      expect.objectContaining({ envOverrides: { DB_HOST: 'override-host' } }),
      expect.anything(),
    );
  });

  it('strips client-supplied __envOverrides from the engine input (persistence-only field)', async () => {
    mockExecute.mockResolvedValue({ output: { ok: true } });
    const options = makeOptions();
    options.input.__envOverrides = { DB_HOST: 'persisted-only' };

    await executeFlowWithPersistence(options);

    const engineInput = mockExecute.mock.calls[0][1];
    expect(engineInput).not.toHaveProperty('__envOverrides');
  });

  it('marks the execution failed on engine errors', async () => {
    mockExecute.mockImplementation(async () => {
      throw new Error('boom');
    });
    const options = makeOptions();

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('failed');
    expect(mockSetCalls.mock.calls.some((c: any[]) => c[0]?.status === 'failed' && c[0]?.error === 'boom')).toBe(true);
  });

  it('marks the execution cancelled on FlowStopError', async () => {
    mockExecute.mockImplementation(async () => {
      throw new FlowStopError('cancelled', 'Stopped by user');
    });
    const options = makeOptions();

    const result = await executeFlowWithPersistence(options);

    expect(result.status).toBe('cancelled');
    expect(mockSetCalls.mock.calls.some((c: any[]) => c[0]?.status === 'cancelled')).toBe(true);
  });
});
