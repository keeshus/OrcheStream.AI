import { Router } from 'express';
import { eq, and, desc, sql, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { executions, executionSteps, flows, groups, groupMembers, users, agentContexts, agentStore, secretAccessLog, userAssignments } from '../db/schema.js';
import { FlowExecutor, HitlPauseError, FlowStopError, PauseExecutionError } from '../../../worker/src/executor/engine.js';
import { executionQueue, enqueueExecution } from '../../../worker/src/queue.js';
import { buildExecutionContext } from '../../../worker/src/executor/context.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { logger } from '../utils/logger.js';
import type { SSEEvent, FlowDefinition, ExecutionStep, EnvVarEntry } from 'orchestream-ai-shared';
import { createSidecarClient, createSandboxManager } from '../../../worker/src/sandbox/index.js';

const router = Router();

// In-memory registry of active executors for cancellation
const activeExecutors = new Map<string, FlowExecutor>();

// Debug (in-process) runs persist nothing, so their HITL pauses are resumed
// in-process too — the approve endpoint resumes these instead of looking up
// an execution record. Keyed by the debug execution id.
interface PausedDebugExecution {
  flow: FlowDefinition;
  input: Record<string, unknown>;
  context: import('../../../worker/src/executor/engine.js').ExecutionContext;
  savedOutputs: Record<string, unknown>;
  hitlNodeId: string;
  buttons: Array<{ label: string; value: string; icon?: string }>;
  prompt: string;
  allowFeedback: boolean;
  sandboxExecutionId: string;
  sandboxManager: ReturnType<typeof createSandboxManager>;
}
const pausedDebugExecutions = new Map<string, PausedDebugExecution>();

interface FlowScopeRow {
  created_by: string | null;
  group_id: string | null;
}

async function getUserGroupIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: groupMembers.group_id })
    .from(groupMembers)
    .where(eq(groupMembers.user_id, userId));
  return rows.map(r => r.groupId);
}

// Mirrors the list-endpoint visibility rule: admins, flow owners, unassigned
// flows (no group), and members of the flow's group can access.
async function canAccessFlow(user: { userId: string; permissions: string[] }, flow: FlowScopeRow | undefined | null): Promise<boolean> {
  if (!flow) return false;
  if (user.permissions.includes('admin')) return true;
  if (flow.created_by === user.userId) return true;
  if (!flow.group_id) return true;
  const groupIds = await getUserGroupIds(user.userId);
  return groupIds.includes(flow.group_id);
}

// Destructive operations additionally require group-admin / flow-owner.
async function canManageFlow(user: { userId: string; permissions: string[] }, flow: FlowScopeRow | undefined | null): Promise<boolean> {
  if (!flow) return false;
  if (user.permissions.includes('admin')) return true;
  if (flow.created_by === user.userId) return true;
  if (!flow.group_id) return false;
  const [membership] = await db.select({ role: groupMembers.role })
    .from(groupMembers)
    .where(and(eq(groupMembers.group_id, flow.group_id), eq(groupMembers.user_id, user.userId)))
    .limit(1);
  return !!membership && membership.role === 'admin';
}

// GET /api/executions/pending — list executions awaiting approval (for approvals page)
router.get('/executions/pending', requirePermission('execution:approve'), asyncHandler(async (req, res) => {
  const isAdmin = req.user?.permissions?.includes('admin');
  let conditions = [eq(executions.status, 'awaiting_approval')];

  if (!isAdmin) {
    const userGroupIds = await db
      .select({ groupId: groupMembers.group_id })
      .from(groupMembers)
      .where(eq(groupMembers.user_id, req.user!.userId));
    const groupIdList = userGroupIds.map(g => g.groupId);

    const accessibleFlows = await db.select({ id: flows.id })
      .from(flows)
      .where(
        groupIdList.length > 0
          ? or(isNull(flows.group_id), inArray(flows.group_id, groupIdList))
          : isNull(flows.group_id)
      );
    const accessibleFlowIds = accessibleFlows.map(f => f.id);
    conditions.push(inArray(executions.flow_id, accessibleFlowIds));
  }

  const result = await db
    .select()
    .from(executions)
    .where(and(...conditions))
    .orderBy(desc(executions.created_at));
  // Filter out debug runs
  const filtered = result.filter((r: any) => !r.input?._debug);
  res.json(filtered);
}));

// GET /api/executions — list executions with optional status filter (admin only)
router.get('/executions', requirePermission('admin'), asyncHandler(async (req, res) => {
  const status = req.query.status as string | undefined;
  const limit = parseInt((req.query.limit as string) || '50');
  const offset = parseInt((req.query.offset as string) || '0');
  const conditions: any[] = [];
  if (status) conditions.push(sql`${executions.status} = ${status}`);

  const results = await db.select({
    id: executions.id,
    flow_id: executions.flow_id,
    status: executions.status,
    input: executions.input,
    output: executions.output,
    error: executions.error,
    started_at: executions.started_at,
    completed_at: executions.completed_at,
    created_at: executions.created_at,
    pending_hitls: executions.pending_hitls,
  })
    .from(executions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(executions.created_at))
    .limit(limit)
    .offset(offset);

  // Enhance with flow names
  const flowIds = [...new Set(results.map(r => r.flow_id))];
  const flowMap: Record<string, string> = {};
  if (flowIds.length > 0) {
    const flowRows = await db.select({ id: flows.id, name: flows.name }).from(flows).where(inArray(flows.id, flowIds));
    for (const f of flowRows) { flowMap[f.id] = f.name; }
  }

  res.json(results.map(r => ({
    ...r,
    flow_name: flowMap[r.flow_id] || 'Unknown',
  })));
}));

// GET /api/executions/:id — get single execution
router.get('/executions/:id', requirePermission('execution:approve'), asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const [exec] = await db.select({
    id: executions.id,
    flow_id: executions.flow_id,
    status: executions.status,
    input: executions.input,
    output: executions.output,
    error: executions.error,
    started_at: executions.started_at,
    completed_at: executions.completed_at,
    created_at: executions.created_at,
    pending_hitls: executions.pending_hitls,
  }).from(executions).where(eq(executions.id, id)).limit(1);
  if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
  const [flow] = await db.select({ name: flows.name, created_by: flows.created_by, group_id: flows.group_id })
    .from(flows).where(eq(flows.id, exec.flow_id)).limit(1);
  if (!(await canAccessFlow(req.user!, flow))) { res.status(404).json({ error: 'Execution not found' }); return; }
  const steps = await db.select().from(executionSteps).where(eq(executionSteps.execution_id, id)).orderBy(executionSteps.started_at);
  res.json({ ...exec, flow_name: flow?.name || 'Unknown', steps });
}));

// POST /api/executions/:executionId/cancel — cancel a running execution
router.post('/executions/:executionId/cancel', requirePermission('flow:edit'), asyncHandler(async (req, res) => {
  const executionId = req.params.executionId as string;

  const [exec] = await db.select({ flow_id: executions.flow_id }).from(executions).where(eq(executions.id, executionId)).limit(1);
  if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
  const [flow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
    .from(flows).where(eq(flows.id, exec.flow_id)).limit(1);
  if (!(await canManageFlow(req.user!, flow))) {
    res.status(403).json({ error: 'Only the flow owner or a group admin can cancel executions' });
    return;
  }

  // Abort in-process if available
  const executor = activeExecutors.get(executionId);
  if (executor) {
    executor.abort();
    activeExecutors.delete(executionId);
  }

  // Mark as cancelled in DB
  await db
    .update(executions)
    .set({ status: 'cancelled', completed_at: new Date() })
    .where(eq(executions.id, executionId));

  res.json({ status: 'cancelled' });
}));

// POST /api/executions/:id/admin-cancel — force-cancel a stuck execution (admin only)
router.post('/executions/:id/admin-cancel', requirePermission('admin'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  await db.update(executions).set({
    status: 'cancelled',
    error: 'Cancelled by admin',
    completed_at: new Date(),
  }).where(eq(executions.id, String(req.params.id)));
  res.json({ status: 'cancelled' });
}));

// ── POST /api/flows/:flowId/execute — SSE-streamed execution ───────────────────

router.post(
  '/flows/:flowId/execute',
  requirePermission('flow:create'),
  asyncHandler(async (req, res) => {
    const flowId = req.params.flowId as string;
    const { input = {}, nodes: canvasNodes, edges: canvasEdges } = req.body;

    // Strip client-supplied sandbox env: the execution environment must come
    // exclusively from the flow's own env_vars configuration.
    if (input && typeof input === 'object') {
      delete (input as any).__env;
    }

    // The target flow must be in the requester's scope (own group / unassigned).
    const [scopeFlow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
      .from(flows).where(eq(flows.id, flowId)).limit(1);
    if (!(await canAccessFlow(req.user!, scopeFlow))) {
      res.status(404).json({ error: 'Flow not found' });
      return;
    }

    // SSE headers ------------------------------------------------
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Helper to emit SSE data frames ------------------------------
    // Persisted runs are fire-and-forget: the frontend cancels the SSE stream
    // after confirming the run started, so the socket closes while the
    // execution is still running. Skip writes once the client is gone instead
    // of crashing on a destroyed stream — the DB persistence happens in the
    // onEvent callback before emitSSE, so nothing is lost.
    let clientGone = false;
    const emitSSE = (data: SSEEvent) => {
      if (clientGone || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientGone = true;
      }
    };

    // Use canvas state if provided (debug runs from editor), otherwise load from DB
    let flowNodes = canvasNodes;
    let flowEdges = canvasEdges;
    let flowName = '';
    let flowContext = '';
    let flowGroupId: string | undefined;
    let flowDefEnvVars: any[] | undefined;

    if (!flowNodes || !flowEdges) {
      const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
      if (!flow) {
        emitSSE({
          type: 'execution.failed',
          executionId: '',
          data: { error: 'Flow not found' },
          timestamp: new Date().toISOString(),
        });
        res.end();
        return;
      }
      flowNodes = flow.nodes;
      flowEdges = flow.edges;
      flowName = flow.name;
      flowContext = flow.flow_context || '';
      flowGroupId = flow.group_id || undefined;
      flowDefEnvVars = flow.env_vars as any[] | undefined;
    } else {
      // Canvas nodes provided (debug from editor) — still load envVars from DB
      const [envFlow] = await db.select({ env_vars: flows.env_vars }).from(flows).where(eq(flows.id, flowId)).limit(1);
      if (envFlow) {
        flowDefEnvVars = envFlow.env_vars as any[] | undefined;
      }
    }

    // Create execution record ------------------------------------
    const isDebug = (input as any)?._debug === true;
    // Store a snapshot of the flow definition so HITL replay uses the original flow
    const flowSnapshot = { nodes: flowNodes, edges: flowEdges, version: 0 };

    let execId: string;
    let exec: any;
    if (isDebug) {
      // Debug runs: don't persist to DB, just generate a temp ID for SSE
      execId = `debug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    } else {
      const inserted = await db
        .insert(executions)
        .values({
          flow_id: flowId,
          status: 'running',
          input,
          output: { _flowSnapshot: flowSnapshot } as any,
          started_at: new Date(),
        })
        .returning();
      exec = inserted[0];
      execId = exec.id;
    }

    // Emit started event
    emitSSE({
      type: 'execution.started',
      executionId: execId,
      data: { flowId, flowName: flowName || 'Debug Run' },
      timestamp: new Date().toISOString(),
    });

    // Map Drizzle row (snake_case) to FlowDefinition (camelCase)
    const flowDef: FlowDefinition = {
      id: flowId,
      name: flowName,
      description: '',
      nodes: flowNodes as any,
      edges: flowEdges as any,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      flowContext: flowContext,
      groupId: flowGroupId,
      envVars: flowDefEnvVars as EnvVarEntry[] | undefined,
    };

    if (isDebug) {
      // ── Debug runs: execute in-process, stream every event to the overlay ──
      // Initialize sandbox for this execution
      const sidecarClient = createSidecarClient();
      const sandboxManager = createSandboxManager(sidecarClient);
      const sandboxExecutionId = execId;

      try {
        await sandboxManager.setup(sandboxExecutionId);
      } catch (err) {
        console.error(`Sandbox setup failed for ${sandboxExecutionId}:`, err);
        // Non-fatal
      }

      // Build the execution context — shared with the worker runner, so debug
      // and persisted runs behave identically.
      const executionContext: import('../../../worker/src/executor/engine.js').ExecutionContext = await buildExecutionContext({
        db,
        flow: flowDef,
        input: input as Record<string, unknown>,
        executionId: execId,
        sandboxEnv: {},
        onSubExecution: async () => `debug_sub_${Date.now()}`,
        completeSubExecution: async () => {},
        logSecretAccess: (entry) => {
          db.insert(secretAccessLog).values({
            action: entry.action,
            metadata: { secretName: entry.name, source: entry.source, executionId: flowId },
            created_at: new Date(),
          }).catch(() => {});
        },
      });

      const executor = new FlowExecutor();
      activeExecutors.set(execId, executor);

      res.on('close', () => {
        executor.abort();
        activeExecutors.delete(execId);
      });

      let skipTeardown = false;
      try {
        const result = await executor.execute(
          flowDef,
          input as Record<string, unknown>,
          // onEvent: stream events to the debug overlay (no persistence)
          async (nodeId, event) => {
            const richEvent: SSEEvent = { ...event, executionId: execId };
            emitSSE(richEvent);
          },
          executionContext,
        );

        activeExecutors.delete(execId);
        emitSSE({
          type: 'execution.completed',
          executionId: execId,
          data: { output: result.output, steps: result.steps },
          timestamp: new Date().toISOString(),
        });
      } catch (err: unknown) {
        // Handle FlowStop — terminate execution immediately
        if (err instanceof FlowStopError) {
          activeExecutors.delete(execId);
          emitSSE({
            type: 'execution.stopped',
            executionId: execId,
            data: { status: err.status, message: err.message },
            timestamp: new Date().toISOString(),
          });
          res.end();
          return;
        }

        // Handle HITL pause — the overlay shows the approval prompt
        if (err instanceof HitlPauseError) {
          skipTeardown = true;
          activeExecutors.delete(execId);
          const hitlCfg = (flowDef.nodes || []).find((n: any) => n.id === err.nodeId)?.data?.config || {};
          // Keep the pause state so the approve endpoint can resume this
          // in-process run (no persisted record exists for debug runs).
          pausedDebugExecutions.set(execId, {
            flow: flowDef,
            input: input as Record<string, unknown>,
            context: executionContext,
            savedOutputs: err.savedOutputs || {},
            hitlNodeId: err.nodeId,
            buttons: err.buttons || [],
            prompt: err.prompt || 'Waiting for approval',
            allowFeedback: (hitlCfg as any).allowFeedback !== false,
            sandboxExecutionId,
            sandboxManager,
          });
          emitSSE({
            type: 'execution.paused',
            executionId: execId,
            data: { nodeId: err.nodeId, savedOutputs: err.savedOutputs, buttons: err.buttons, prompt: err.prompt, allowFeedback: (hitlCfg as any).allowFeedback !== false, message: 'Waiting for human approval' },
            timestamp: new Date().toISOString(),
          });
          res.end();
          return;
        }

        // Handle delay pause in debug — just inform the client
        if (err instanceof PauseExecutionError) {
          activeExecutors.delete(execId);
          emitSSE({
            type: 'execution.paused',
            executionId: execId,
            data: { nodeId: err.nodeId, delayMs: err.resumeDelay, resumeAt: Date.now() + err.resumeDelay, message: 'Waiting for delay' },
            timestamp: new Date().toISOString(),
          });
          res.end();
          return;
        }

        const error = err instanceof Error ? err.message : String(err);
        console.error('Flow execution failed:', error);
        activeExecutors.delete(execId);

        emitSSE({
          type: 'execution.failed',
          executionId: execId,
          data: { error },
          timestamp: new Date().toISOString(),
        });
      } finally {
        if (!skipTeardown) {
          sandboxManager.teardown(sandboxExecutionId).catch(err => {
            console.error(`Sandbox teardown failed for ${sandboxExecutionId}:`, err);
          });
        }
      }

      res.end();
      return;
    }

    // ── Persisted runs: fire-and-forget via the worker queue ──────────
    // The worker executes the flow with the same shared context builder and
    // persists steps/HITL/delays. The SSE stream only confirms the start —
    // the frontend cancels it right after (api.flows.execute).
    await enqueueExecution(flowDef, { ...(input as Record<string, unknown>), __executionId: execId });
    res.end();
  }),
);


// ── POST /api/executions/:executionId/approve — approve HITL and resume flow ──

router.post('/executions/:executionId/approve', asyncHandler(async (req, res) => {
  const executionId = req.params.executionId as string;
  const { feedback = '', decision = 'approved', data: userData = {}, hitlNodeId } = req.body || {};

  // ── Debug (in-process) executions have no persisted record — resume here ──
  const pausedDebug = pausedDebugExecutions.get(executionId);
  if (pausedDebug) {
    pausedDebugExecutions.delete(executionId);
    const { flow, input, context, savedOutputs, hitlNodeId: pauseNodeId, buttons, sandboxExecutionId, sandboxManager } = pausedDebug;
    const validDecisions = (buttons || [])
      .map((b: any) => b?.value)
      .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
    if (validDecisions.length > 0 && !validDecisions.includes(decision)) {
      sandboxManager.teardown(sandboxExecutionId).catch(() => {});
      res.status(400).json({ error: `Invalid decision. Valid options: ${validDecisions.join(', ')}` });
      return;
    }
    const resumeExecutor = new FlowExecutor();
    try {
      const result = await resumeExecutor.execute(
        flow,
        input,
        // No live SSE stream for the resumed run — the overlay renders from
        // the approve response (steps + final output) instead.
        async () => {},
        context,
        {
          replayFrom: pauseNodeId,
          replayOutputs: { ...savedOutputs, [`${pauseNodeId}:__approved`]: { decision, feedback } },
          initialIteration: (savedOutputs as any)?._nextIteration ?? 1,
        },
      );
      sandboxManager.teardown(sandboxExecutionId).catch(() => {});
      res.json({ status: 'completed', output: result.output, steps: result.steps });
      return;
    } catch (err: unknown) {
      // Another HITL node paused — park the new pause state and tell the
      // overlay to show the next approval card.
      if (err instanceof HitlPauseError) {
        const cfg = (flow.nodes || []).find((n: any) => n.id === err.nodeId)?.data?.config || {};
        pausedDebugExecutions.set(executionId, {
          ...pausedDebug,
          savedOutputs: err.savedOutputs || savedOutputs,
          hitlNodeId: err.nodeId,
          buttons: err.buttons || [],
          prompt: err.prompt || 'Waiting for approval',
          allowFeedback: (cfg as any).allowFeedback !== false,
        });
        res.json({ status: 'paused', executionId, nodeId: err.nodeId, prompt: err.prompt, buttons: err.buttons });
        return;
      }
      sandboxManager.teardown(sandboxExecutionId).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ status: 'failed', error: message });
      return;
    }
  }

  const [exec] = await db.select().from(executions).where(eq(executions.id, executionId));
  if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
  if (exec.status !== 'awaiting_approval') { res.status(400).json({ error: 'Not awaiting approval' }); return; }

  // Find the hitlNodeId — use provided one or fall back to first pending
  const pendingHitls = (exec.pending_hitls || []) as any[];
  const hitlEntry = hitlNodeId
    ? pendingHitls.find((h: any) => h.nodeId === hitlNodeId)
    : pendingHitls[0];
  if (!hitlEntry) { res.status(400).json({ error: 'No pending HITL found' }); return; }

  const userId = req.user!.userId;

  // Resolve the execution's flow for group scoping
  const [approveFlow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
    .from(flows).where(eq(flows.id, exec.flow_id)).limit(1);

  // Validate `decision` against the buttons configured on the HITL node
  const validDecisions = (hitlEntry.buttons || [])
    .map((b: any) => b?.value)
    .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
  if (validDecisions.length > 0 && !validDecisions.includes(decision)) {
    res.status(400).json({ error: `Invalid decision. Valid options: ${validDecisions.join(', ')}` });
    return;
  }

  // When no assignment is configured, require at least membership of the
  // flow's group. Configured assignments are enforced by the checks below.
  if (!hitlEntry.assignmentType) {
    const flowAccessible = req.user!.permissions.includes('admin') || await canAccessFlow(req.user!, approveFlow);
    if (!flowAccessible) {
      res.status(403).json({ error: 'You are not authorized to approve this request' });
      return;
    }
  }

  // Resolve group members for group-type assignments
  if (hitlEntry.assignmentType === 'group' || hitlEntry.assignees?.groupIds?.length) {
    if (!hitlEntry.assignees) hitlEntry.assignees = { userIds: [], roleIds: [], groupIds: [] };
    const groupIdToResolve = hitlEntry.assignedGroupId || hitlEntry.assignees?.groupIds?.[0];
    if (groupIdToResolve) {
      if (!hitlEntry.assignees.groupIds.includes(groupIdToResolve)) {
        hitlEntry.assignees.groupIds.push(groupIdToResolve);
      }
      const members = await db.select({ userId: groupMembers.user_id })
        .from(groupMembers)
        .where(eq(groupMembers.group_id, groupIdToResolve));
      for (const m of members) {
        if (!hitlEntry.assignees.userIds.includes(m.userId)) {
          hitlEntry.assignees.userIds.push(m.userId);
        }
      }
    }
  }

  // ── Single-user, single-role, or single-group assignment: resolve and enforce ──
  if (hitlEntry.assignmentType && hitlEntry.assignmentType !== 'multi') {
    let authorizedUserIds: string[] = [];

    if (hitlEntry.assignmentType === 'user' && hitlEntry.assignedUserId) {
      authorizedUserIds = [hitlEntry.assignedUserId];
    } else if (hitlEntry.assignmentType === 'role' && hitlEntry.assignedRoleId) {
      const roleUsers = await db.select({ id: users.id }).from(users).where(eq(users.role_id, hitlEntry.assignedRoleId));
      authorizedUserIds = roleUsers.map(u => u.id);
    } else if (hitlEntry.assignmentType === 'group') {
      const groupId = hitlEntry.assignedGroupId || hitlEntry.assignees?.groupIds?.[0];
      if (groupId) {
        const members = await db.select({ userId: groupMembers.user_id })
          .from(groupMembers)
          .where(eq(groupMembers.group_id, groupId));
        authorizedUserIds = members.map(m => m.userId);
      }
    }

    if (authorizedUserIds.length > 0 && !authorizedUserIds.includes(userId)) {
      res.status(403).json({ error: 'You are not assigned to this approval request' });
      return;
    }

    // Assignment type configured but no assignees resolvable (malformed stored
    // state) — fall back to group membership instead of skipping the check.
    if (authorizedUserIds.length === 0) {
      const flowAccessible = req.user!.permissions.includes('admin') || await canAccessFlow(req.user!, approveFlow);
      if (!flowAccessible) {
        res.status(403).json({ error: 'You are not authorized to approve this request' });
        return;
      }
    }
  }

  // ── Resolve group-to-user for assignees (used by multi) ──
  if (hitlEntry.assignees?.groupIds?.length && hitlEntry.assignmentType !== 'group') {
    if (!hitlEntry.assignees.userIds) hitlEntry.assignees.userIds = [];
    for (const groupId of hitlEntry.assignees.groupIds) {
      const members = await db.select({ userId: groupMembers.user_id })
        .from(groupMembers)
        .where(eq(groupMembers.group_id, groupId));
      for (const m of members) {
        if (!hitlEntry.assignees.userIds.includes(m.userId)) {
          hitlEntry.assignees.userIds.push(m.userId);
        }
      }
    }
  }

  // ── Multi-approver logic ──────────────────────────────────────────────────
  if (hitlEntry.assignmentType === 'multi') {
    const currentApprovals: Array<{ userId: string; decision: string; feedback: string }> = hitlEntry.approvals || [];

    // Check if user already voted
    const existing = currentApprovals.find(a => a.userId === userId);
    if (existing) {
      res.status(400).json({ error: 'You have already responded to this request' });
      return;
    }

    // Multi-approval with no assignees configured still requires flow access
    if (!hitlEntry.assignees?.userIds?.length) {
      const flowAccessible = req.user!.permissions.includes('admin') || await canAccessFlow(req.user!, approveFlow);
      if (!flowAccessible) {
        res.status(403).json({ error: 'You are not authorized to approve this request' });
        return;
      }
    }

    // Check if user is in the resolved assignees list
    if (hitlEntry.assignees?.userIds?.length && !hitlEntry.assignees.userIds.includes(userId)) {
      res.status(403).json({ error: 'You are not assigned to this approval request' });
      return;
    }

    currentApprovals.push({ userId, decision, feedback });

    if (decision === 'rejected') {
      // Immediate rejection
      hitlEntry.approvals = currentApprovals;
      await db.update(executions).set({
        status: 'cancelled',
        error: `Rejected by user ${userId}`,
        pending_hitls: JSON.stringify(pendingHitls) as any,
        completed_at: new Date(),
      }).where(eq(executions.id, exec.id));
      res.json({ status: 'rejected', executionId: exec.id });
      return;
    }

    // Count unique approving users
    const approvedCount = currentApprovals.filter(a => a.decision === 'approved').length;
    const required = hitlEntry.requiredApprovals || 1;

    if (approvedCount < required) {
      // Not enough approvals yet — update pending_hitls with the new approval
      hitlEntry.approvals = currentApprovals;
      const otherPending = pendingHitls.filter((h: any) => h.nodeId !== hitlEntry.nodeId);
      await db.update(executions).set({
        pending_hitls: JSON.stringify([...otherPending, hitlEntry]) as any,
      }).where(eq(executions.id, exec.id));
      res.json({ status: 'pending', message: `Approval recorded (${approvedCount}/${required} required)`, executionId: exec.id });
      return;
    }
    // Enough approvals — fall through to resume the flow
  }

  // Use the flow snapshot from when execution started, not the current flow definition
  const snapshot = (exec.output as any)?._flowSnapshot;
  let flowDef: FlowDefinition;
  if (snapshot) {
    flowDef = {
      id: exec.flow_id, name: '', description: '',
      nodes: snapshot.nodes as any, edges: snapshot.edges as any, version: snapshot.version || 1,
      createdAt: '', updatedAt: '',
    };
  } else {
    // Fallback to current flow (legacy executions without snapshot)
    const [flow] = await db.select().from(flows).where(eq(flows.id, exec.flow_id));
    if (!flow) { res.status(404).json({ error: 'Flow not found' }); return; }
    flowDef = {
      id: flow.id, name: flow.name, description: flow.description || '',
      nodes: flow.nodes as any, edges: flow.edges as any, version: flow.version,
      createdAt: flow.created_at?.toISOString() || '', updatedAt: flow.updated_at?.toISOString() || '',
      flowContext: flow.flow_context || '',
      groupId: flow.group_id || undefined,
    };
  }

  const savedOutputs = hitlEntry.savedOutputs || {};
  const mergedInput = { ...(exec.input || {}), _approved: true, _feedback: feedback, _decision: decision, ...userData };

  // Mirror the decision into the assignments table so the co-pilot's
  // decide_assignment flow stays in sync with the execution-level approval.
  if (decision === 'approved') {
    await db.update(userAssignments)
      .set({ status: 'approved', decided_by_user_id: userId, decided_at: new Date(), feedback: feedback || null })
      .where(and(eq(userAssignments.execution_id, exec.id), eq(userAssignments.status, 'pending')))
      .catch((e: any) => console.error('Failed to mark assignments approved:', e));
  }
  // Node-scoped approval: attach the decision to the exact HITL node being
  // replayed (keyed by its hierarchical node id, e.g. 'h1' or 'subflow:c3') so
  // the engine only resumes that node — other HITL nodes further downstream
  // still pause for their own approval.
  const replayOutputs = { ...savedOutputs, [`${hitlEntry.nodeId}:__approved`]: { decision, feedback } };

  // Resume via the worker queue — the runner replays from the HITL node with
  // the saved outputs, the decision override, and the accumulated iteration.
  await executionQueue.add(
    'execute-flow',
    {
      flow: flowDef,
      input: {
        ...(exec.input || {}),
        __executionId: exec.id,
        __replayFrom: hitlEntry.nodeId,
        __replayOutputs: replayOutputs,
        __replayOverride: mergedInput,
        __initialIteration: (exec.output as any)?._nextIteration ?? 1,
      },
    },
    { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  );

  res.json({ status: 'running', executionId: exec.id, message: 'Execution resumed via worker' });
}));


// ── DELETE /api/executions/:executionId — delete an execution ──────────────────

router.delete('/executions/:executionId', requirePermission('execution:approve'), asyncHandler(async (req, res) => {
  const executionId = req.params.executionId as string;

  const [exec] = await db.select({ flow_id: executions.flow_id }).from(executions).where(eq(executions.id, executionId)).limit(1);
  if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
  const [flow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
    .from(flows).where(eq(flows.id, exec.flow_id)).limit(1);
  if (!(await canManageFlow(req.user!, flow))) {
    res.status(403).json({ error: 'Only the flow owner or a group admin can delete executions' });
    return;
  }

  // Delete steps first (FK constraint)
  await db.delete(executionSteps).where(eq(executionSteps.execution_id, executionId));
  await db.delete(executions).where(eq(executions.id, executionId));

  res.json({ status: 'deleted' });
}));

// ── POST /api/executions/:executionId/reject — reject HITL ──────────────────────

router.post('/executions/:executionId/reject', asyncHandler(async (req, res) => {
  const executionId = req.params.executionId as string;

  // Debug (in-process) executions: nothing to persist — tear down and ack.
  const pausedDebug = pausedDebugExecutions.get(executionId);
  if (pausedDebug) {
    pausedDebugExecutions.delete(executionId);
    pausedDebug.sandboxManager.teardown(pausedDebug.sandboxExecutionId).catch(() => {});
    res.json({ status: 'rejected' });
    return;
  }

  const [exec] = await db.select().from(executions).where(eq(executions.id, executionId));
  if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
  if (exec.status !== 'awaiting_approval') { res.status(400).json({ error: 'Not awaiting approval' }); return; }

  const pendingHitls = (exec.pending_hitls || []) as any[];
  const hitlEntry = pendingHitls[0];

  // Resolve the execution's flow for group scoping
  const [rejectFlow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
    .from(flows).where(eq(flows.id, exec.flow_id)).limit(1);

  // Authorization: enforce the same rules as approve — assignment checks when
  // configured, otherwise at least group membership of the flow's group.
  if (hitlEntry && hitlEntry.assignmentType && hitlEntry.assignmentType !== 'multi') {
    let authorizedUserIds: string[] = [];
    if (hitlEntry.assignmentType === 'user' && hitlEntry.assignedUserId) {
      authorizedUserIds = [hitlEntry.assignedUserId];
    } else if (hitlEntry.assignmentType === 'role' && hitlEntry.assignedRoleId) {
      const roleUsers = await db.select({ id: users.id }).from(users).where(eq(users.role_id, hitlEntry.assignedRoleId));
      authorizedUserIds = roleUsers.map(u => u.id);
    } else if (hitlEntry.assignmentType === 'group') {
      const groupId = hitlEntry.assignedGroupId || hitlEntry.assignees?.groupIds?.[0];
      if (groupId) {
        const members = await db.select({ userId: groupMembers.user_id })
          .from(groupMembers)
          .where(eq(groupMembers.group_id, groupId));
        authorizedUserIds = members.map(m => m.userId);
      }
    }
    if (authorizedUserIds.length > 0 && !authorizedUserIds.includes(req.user!.userId)) {
      res.status(403).json({ error: 'You are not assigned to this approval request' });
      return;
    }

    // Assignment type configured but no assignees resolvable (malformed stored
    // state) — fall back to group membership instead of skipping the check.
    if (authorizedUserIds.length === 0) {
      const flowAccessible = req.user!.permissions.includes('admin') || await canAccessFlow(req.user!, rejectFlow);
      if (!flowAccessible) {
        res.status(403).json({ error: 'You are not authorized to reject this request' });
        return;
      }
    }
  } else if (hitlEntry?.assignmentType === 'multi') {
    const assigneeIds: string[] = hitlEntry.assignees?.userIds || [];
    if (assigneeIds.length > 0 && !assigneeIds.includes(req.user!.userId)) {
      res.status(403).json({ error: 'You are not assigned to this approval request' });
      return;
    }
  } else {
    const flowAccessible = req.user!.permissions.includes('admin') || await canAccessFlow(req.user!, rejectFlow);
    if (!flowAccessible) {
      res.status(403).json({ error: 'You are not authorized to reject this request' });
      return;
    }
  }

  await db.update(executions)
    .set({ status: 'cancelled', error: 'Rejected by user', completed_at: new Date() })
    .where(eq(executions.id, executionId));

  await db.update(userAssignments)
    .set({ status: 'rejected', decided_by_user_id: req.user!.userId, decided_at: new Date() })
    .where(and(eq(userAssignments.execution_id, executionId), eq(userAssignments.status, 'pending')))
    .catch((e: any) => console.error('Failed to mark assignments rejected:', e));

  res.json({ status: 'rejected' });
}));

// ── GET /api/flows/:flowId/executions — list past executions ───────────────────

router.get(
  '/flows/:flowId/executions',
  asyncHandler(async (req, res) => {
    const flowId = req.params.flowId as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const [scopeFlow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
      .from(flows).where(eq(flows.id, flowId)).limit(1);
    if (!(await canAccessFlow(req.user!, scopeFlow))) {
      res.status(404).json({ error: 'Flow not found' });
      return;
    }

    const [result, countResult] = await Promise.all([
      db.select().from(executions).where(eq(executions.flow_id, flowId)).orderBy(desc(executions.created_at)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(executions).where(eq(executions.flow_id, flowId)),
    ]);
    // Filter out debug runs
    const filtered = result.filter((r: any) => !r.input?._debug);
    res.json({ data: filtered, total: Number(countResult[0].count), limit, offset });
  }),
);

// ── GET /api/flows/:flowId/executions/:executionId — execution with steps ──────

router.get(
  '/flows/:flowId/executions/:executionId',
  asyncHandler(async (req, res) => {
    const executionId = req.params.executionId as string;

    const [exec] = await db
      .select()
      .from(executions)
      .where(eq(executions.id, executionId));
    if (!exec) {
      res.status(404).json({ message: 'Execution not found' });
      return;
    }

    const [flow] = await db.select({ created_by: flows.created_by, group_id: flows.group_id })
      .from(flows).where(eq(flows.id, exec.flow_id)).limit(1);
    if (!(await canAccessFlow(req.user!, flow))) {
      res.status(404).json({ message: 'Execution not found' });
      return;
    }

    const steps = await db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, executionId))
      .orderBy(executionSteps.started_at);

    res.json({ ...exec, steps });
  }),
);

export default router;
