/**
 * Shared flow execution runner with step persistence and HITL/Stop error handling.
 * Used by the BullMQ worker for ALL persisted runs (manual, webhook, schedule,
 * delay/HITL resumes). Debug runs execute in-process in the backend but build
 * their context through the same buildExecutionContext().
 */
import { FlowExecutor, HitlPauseError, FlowStopError, PauseExecutionError } from './engine.js';
import type { ExecutionContext } from './engine.js';
import type { FlowDefinition, SSEEvent, EnvOverrides } from 'orchestream-ai-shared';
import { createSidecarClient, createSandboxManager } from '../sandbox/index.js';
import { executionQueue } from '../queue.js';
import { buildExecutionContext } from './context.js';

interface RunnerOptions {
  flow: FlowDefinition;
  input: Record<string, unknown>;
  executionId: string;
  envOverrides?: EnvOverrides;
  db: any;
  executionsTable: any;
  executionStepsTable: any;
  eq: any;
  and: any;
  inArray?: any;
  onEvent?: (nodeId: string, event: SSEEvent) => void;
  agentContextsTable?: any;
  agentStoreTable?: any;
  groupsTable?: any;
  userAssignmentsTable?: any;
  secretAccessLogTable?: any;
  flowsTable?: any;
}

// Sandbox env comes exclusively from the flow's own env var configuration —
// client-supplied __env must never reach the sandbox. Resolution happens in
// buildExecutionContext() (static / core_secret / cyberark).

/**
 * Iteration + hierarchy aware step persistence (shared by initial runs and
 * HITL replays): closes stale running rows, then upserts per
 * (execution, node, iteration).
 */
function makeStepPersister(options: {
  db: any;
  executionsTable: any;
  executionStepsTable: any;
  eq: any;
  and: any;
  executionId: string;
}) {
  const { db, executionsTable, executionStepsTable, eq, and, executionId } = options;

  return async (nodeId: string, event: SSEEvent) => {
    const data = event.data;
    const hierarchy = event.hierarchy || (data.hierarchy as { path: string; depth: number } | undefined);
    const prefix = hierarchy ? hierarchy.path.replace(/->/g, ':') + ':' : '';
    const resolvedNodeId = (data.nodeId as string) || nodeId;
    const hierarchicalNodeId = prefix ? `${prefix}${resolvedNodeId}` : resolvedNodeId;
    const resolvedNodeType = (data.nodeType as string) || '';
    const iter = (data as any).iteration ?? 0;
    try {
      if (event.type === 'step.started') {
        // Complete any existing running rows for this node (e.g. a prior HITL pause)
        await db.update(executionStepsTable).set({ status: 'completed', completed_at: new Date() })
          .where(and(eq(executionStepsTable.execution_id, executionId), eq(executionStepsTable.node_id, hierarchicalNodeId), eq(executionStepsTable.status, 'running')));
        const [existing] = await db.select({ id: executionStepsTable.id })
          .from(executionStepsTable)
          .where(and(eq(executionStepsTable.execution_id, executionId), eq(executionStepsTable.node_id, hierarchicalNodeId), eq(executionStepsTable.iteration, iter)))
          .limit(1);
        if (existing) {
          await db.update(executionStepsTable).set({
            status: 'running', input: data.input as any, started_at: new Date(),
            hierarchy: hierarchy as any || null,
          }).where(eq(executionStepsTable.id, existing.id));
        } else {
          await db.insert(executionStepsTable).values({
            execution_id: executionId, node_id: hierarchicalNodeId, node_type: resolvedNodeType,
            node_label: data.nodeLabel as string | null, iteration: iter,
            status: 'running', input: data.input as any, started_at: new Date(),
            hierarchy: hierarchy as any || null,
          });
        }
      } else if (event.type === 'step.completed') {
        await db.update(executionStepsTable).set({
          status: 'completed', output: data.output as any, completed_at: new Date(),
          hierarchy: hierarchy as any || null,
        }).where(and(
          eq(executionStepsTable.execution_id, executionId),
          eq(executionStepsTable.node_id, hierarchicalNodeId),
          eq(executionStepsTable.iteration, iter),
        ));
      } else if (event.type === 'step.failed') {
        await db.update(executionStepsTable).set({
          status: 'failed', error: data.error as string, completed_at: new Date(),
          hierarchy: hierarchy as any || null,
        }).where(and(
          eq(executionStepsTable.execution_id, executionId),
          eq(executionStepsTable.node_id, hierarchicalNodeId),
          eq(executionStepsTable.iteration, iter),
        ));
      }
    } catch (e) { console.error('Failed to persist step:', e); }
  };
}

/**
 * Execute a flow with full lifecycle management:
 * - Builds the complete execution context (endpoints, MCP, secrets, CyberArk,
 *   vector search, contexts) — identical to debug runs
 * - Persists steps (iteration/hierarchy aware) to the DB
 * - Handles HitlPauseError (stores pending_hitls + assignments, awaiting_approval)
 * - Handles FlowStopError / general errors (marks as cancelled/failed)
 * - On success marks as completed
 */
export async function executeFlowWithPersistence(options: RunnerOptions): Promise<{ status: string; output?: any; delayResumeAt?: number }> {
  const { flow, input, executionId, db: database, executionsTable, executionStepsTable, eq: eqFn, and: andFn, onEvent, userAssignmentsTable, secretAccessLogTable } = options;

  // Replay metadata injected by queue jobs (delay resumes / HITL approvals):
  // resume from the pause point using the saved outputs.
  const replayFrom = (input as any)?.__replayFrom as string | undefined;
  const replayOutputs = (input as any)?.__replayOutputs as Record<string, unknown> | undefined;
  const replayOverride = (input as any)?.__replayOverride as Record<string, unknown> | undefined;
  const initialIteration = (input as any)?.__initialIteration as number | undefined;
  const flowInput: Record<string, unknown> = { ...input };
  delete (flowInput as any).__replayFrom;
  delete (flowInput as any).__replayOutputs;
  delete (flowInput as any).__replayOverride;
  delete (flowInput as any).__initialIteration;
  delete (flowInput as any).__executionId;
  // Client-supplied __env is untrusted — strip it defensively; only the flow's
  // own env vars may reach the sandbox.
  delete (flowInput as any).__env;
  // __envOverrides is persisted on the execution record for auditing; the
  // actual merge happens via options.envOverrides in buildExecutionContext.
  delete (flowInput as any).__envOverrides;

  // Initialize sandbox
  const sidecarClient = createSidecarClient();
  const sandboxManager = createSandboxManager(sidecarClient);

  // Setup sandbox execution directory
  await sandboxManager.setup(executionId).catch(err => {
    console.error(`Failed to setup sandbox for ${executionId}:`, err);
    // Non-fatal — execution continues without sandbox
  });

  // In-memory secret store (engine may cache resolved secrets per run)
  const secretStore = new Map<string, string>();

  // Build the FULL execution context — identical to debug runs in the backend.
  const executionContext: ExecutionContext = await buildExecutionContext({
    db: database,
    flow,
    input: flowInput,
    executionId,
    sandboxEnv: {},
    envOverrides: options.envOverrides,
    onSubExecution: async (data) => {
      const [subExec] = await database.insert(executionsTable).values({
        flow_id: data.subflowId,
        parent_execution_id: data.parentExecutionId,
        subflow_node_id: data.subflowNodeId,
        subflow_depth: data.depth,
        status: 'running',
        input: data.input,
        started_at: new Date(),
      }).returning();
      return subExec.id;
    },
    completeSubExecution: async (subExecutionId, output, status, error) => {
      await database.update(executionsTable).set({
        status,
        output: output as any,
        error: error || null,
        completed_at: new Date(),
      }).where(eqFn(executionsTable.id, subExecutionId));
    },
    logSecretAccess: secretAccessLogTable
      ? (entry) => {
          database.insert(secretAccessLogTable).values({
            action: entry.action,
            metadata: { secretName: entry.name, source: entry.source, executionId: flow.id },
            created_at: new Date(),
          }).catch(() => {});
        }
      : undefined,
    setSecret: (name, value) => { secretStore.set(name, value); },
  });

  const executor = new FlowExecutor();
  const persistStep = makeStepPersister({
    db: database, executionsTable, executionStepsTable, eq: eqFn, and: andFn, executionId,
  });

  try {
    const result = await executor.execute(
      flow,
      flowInput,
      async (nodeId, event) => {
        await persistStep(nodeId, event);
        onEvent?.(nodeId, event);
      },
      executionContext,
      replayFrom ? { replayFrom, replayOutputs: replayOutputs || {}, inputOverride: replayOverride, initialIteration } : undefined,
    );

    await database.update(executionsTable).set({
      status: 'completed',
      output: result.output as any,
      pending_hitls: JSON.stringify([]) as any,
      completed_at: new Date(),
    }).where(eqFn(executionsTable.id, executionId));

    // Teardown sandbox on success
    await sandboxManager.teardown(executionId).catch(err => {
      console.error(`Failed to teardown sandbox for ${executionId}:`, err);
    });

    return { status: 'completed', output: result.output };
  } catch (err) {
    if (err instanceof HitlPauseError) {
      const hitlEntry = { nodeId: err.nodeId, prompt: err.prompt, buttons: err.buttons, savedOutputs: err.savedOutputs, assignmentType: err.assignmentType, assignees: err.assignees, requiredApprovals: err.requiredApprovals, assignedGroupId: err.assignedGroupId, assignedUserId: err.assignedUserId, assignedRoleId: err.assignedRoleId };

      // Accumulate paused time across approvals
      const [current] = await database.select({ output: executionsTable.output }).from(executionsTable).where(eqFn(executionsTable.id, executionId)).limit(1);
      const prevOutput = (current?.output as any) || {};
      const prevPausedAt = prevOutput._pausedAt;
      const prevPausedTotal = prevOutput._pausedTotal || 0;
      const addPause = prevPausedAt ? (Date.now() - prevPausedAt) : 0;
      const nextIteration = (prevOutput._nextIteration ?? 1) + 1;

      await database.update(executionsTable).set({
        status: 'awaiting_approval',
        output: { ...err.savedOutputs, _flowSnapshot: prevOutput._flowSnapshot, _hitlButtons: err.buttons, _hitlPrompt: err.prompt, _pausedTotal: prevPausedTotal + addPause, _pausedAt: Date.now(), _nextIteration: nextIteration } as any,
        pending_hitls: JSON.stringify([hitlEntry]) as any,
      }).where(eqFn(executionsTable.id, executionId));

      // Mirror the paused HITL into the assignments table so the co-pilot's
      // list_assignments / decide_assignment tools and the /api/assignments
      // endpoints operate on real data for worker-run executions too.
      if (userAssignmentsTable) {
        try {
          let assigneeId = err.assignedUserId || err.assignees?.userIds?.[0] || null;
          // No explicit assignee: fall back to the flow owner (the backend
          // previously used the requesting user — the worker only knows the flow).
          if (!assigneeId && options.flowsTable) {
            const [flowRow] = await database.select({ created_by: options.flowsTable.created_by }).from(options.flowsTable).where(eqFn(options.flowsTable.id, flow.id)).limit(1);
            assigneeId = flowRow?.created_by || null;
          }
          await database.insert(userAssignmentsTable).values({
            execution_id: executionId,
            hitl_node_id: err.nodeId,
            assigned_to_user_id: assigneeId,
            assigned_to_role_id: err.assignedRoleId || null,
            assigned_to_group_id: err.assignedGroupId || err.assignees?.groupIds?.[0] || null,
            status: 'pending',
          });
        } catch (insertErr) {
          console.error('Failed to create assignment for HITL pause:', insertErr);
        }
      }
      return { status: 'awaiting_approval' };
    }

    // Delay pause — persist resume info and schedule a delayed re-run. The
    // execution stays 'running' (the enum has no 'paused' state); the resume
    // metadata lives in output and the delayed BullMQ job carries the replay
    // instructions (__replayFrom / __replayOutputs).
    if (err instanceof PauseExecutionError) {
      const resumeAt = Date.now() + err.resumeDelay;
      const [current] = await database.select({ output: executionsTable.output }).from(executionsTable).where(eqFn(executionsTable.id, executionId)).limit(1);
      const prevOutput = (current?.output as any) || {};
      await database.update(executionsTable).set({
        status: 'running',
        output: { ...err.savedOutputs, _flowSnapshot: prevOutput._flowSnapshot, _delayNodeId: err.nodeId, _delayMs: err.resumeDelay, _delayResumeAt: resumeAt } as any,
      }).where(eqFn(executionsTable.id, executionId));
      await executionQueue.add(
        'execute-flow',
        {
          flow,
          input: { ...flowInput, __executionId: executionId, __replayFrom: err.nodeId, __replayOutputs: err.savedOutputs },
          envOverrides: options.envOverrides,
        },
        { delay: err.resumeDelay, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
      );
      await sandboxManager.teardown(executionId).catch(teardownErr => {
        console.error(`Failed to teardown sandbox for ${executionId}:`, teardownErr);
      });
      return { status: 'running', delayResumeAt: resumeAt };
    }

    // Teardown sandbox on failure/cancellation (but not HITL)
    await sandboxManager.teardown(executionId).catch(err => {
      console.error(`Failed to teardown sandbox for ${executionId}:`, err);
    });

    if (err instanceof FlowStopError) {
      await database.update(executionsTable).set({
        status: err.status as any, error: err.message, completed_at: new Date(),
      }).where(eqFn(executionsTable.id, executionId));
      return { status: err.status as any };
    }
    const error = err instanceof Error ? err.message : String(err);
    await database.update(executionsTable).set({
      status: 'failed', error, completed_at: new Date(),
    }).where(eqFn(executionsTable.id, executionId));
    return { status: 'failed', output: { error } };
  }
}
