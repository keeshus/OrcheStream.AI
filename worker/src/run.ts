/**
 * Worker consumer entry point.
 * Listens to the BullMQ queue and executes flows as jobs arrive.
 * Handles both direct enqueue ({ flow, input }) and repeatable schedule jobs ({ flowId }).
 */
import { createExecutionWorker } from './queue.js';
import { executeFlowWithPersistence } from './executor/runner.js';
import { createSidecarClient, createReaper } from './sandbox/index.js';
import { startReconciliation, stopReconciliation } from './schedule-reconciliation.js';

async function main() {
  console.log('Worker started, waiting for jobs...');

  const { getDb, flows, executions, executionSteps, agentContexts, agentStore, groups, userAssignments, secretAccessLog } = await import('orchestream-ai-shared');
  const { db } = getDb();
  const { eq, and, inArray } = await import('drizzle-orm');

  const sidecarClient = createSidecarClient();
  const reaper = createReaper(sidecarClient, db, executions);

  // Register vector stores so retriever nodes work in worker-executed runs
  // (the backend does the same at startup).
  const { initVectorStores } = await import('orchestream-ai-shared');
  initVectorStores(db).catch(() => {});

  const worker = createExecutionWorker(async (job) => {
    const { flow, input, flowId } = job;
    const executionId = (input as any)?.__executionId as string | undefined;

    // Resolve flow definition — either from direct payload or load from DB (repeatable schedule)
    let flowDef: any;
    if (flow) {
      flowDef = flow;
    } else if (flowId) {
      const [dbFlow] = await db.select().from(flows).where(eq(flows.id, flowId));
      if (!dbFlow) {
        console.error(`Flow ${flowId} not found for scheduled execution`);
        return;
      }
      flowDef = {
        id: dbFlow.id,
        name: dbFlow.name,
        description: dbFlow.description || '',
        nodes: dbFlow.nodes,
        edges: dbFlow.edges,
        version: dbFlow.version,
        createdAt: '',
        updatedAt: '',
        flowContext: dbFlow.flow_context || '',
        groupId: dbFlow.group_id || undefined,
        envVars: dbFlow.env_vars || [],
      };
    } else {
      console.error('Invalid job: missing both flow and flowId');
      return;
    }

    // Direct jobs carry an explicit input; schedule jobs merge the trigger's
    // configured inputMessage (parsed JSON) with the schedule context fields.
    const resolvedInput = input
      || { ...(job.inputMessage || {}), triggerType: 'schedule', timestamp: new Date().toISOString() };

    console.log(`Executing flow: ${flowDef.name} (${flowDef.id})${executionId ? ' exec=' + executionId : ''}`);

    let execId = executionId;
    if (!execId) {
      const [exec] = await db.insert(executions).values({
        flow_id: flowDef.id, status: 'running', input: resolvedInput, started_at: new Date(),
      }).returning();
      execId = exec.id;
    } else {
      await db.update(executions).set({ status: 'running', started_at: new Date() })
        .where(eq(executions.id, execId));
    }

    try {
      const result = await executeFlowWithPersistence({
        flow: flowDef,
        input: resolvedInput,
        executionId: execId,
        db,
        executionsTable: executions,
        executionStepsTable: executionSteps,
        eq,
        and,
        inArray,
        agentContextsTable: agentContexts,
        agentStoreTable: agentStore,
        groupsTable: groups,
        userAssignmentsTable: userAssignments,
        secretAccessLogTable: secretAccessLog,
        flowsTable: flows,
      });

      console.log(`Flow ${flowDef.id}: ${result.status} (exec ${execId})`);
    } catch (err) {
      // The runner handles most failures internally; anything escaping it (e.g.
      // a DB failure) must not leave the execution stuck in 'running'.
      const error = err instanceof Error ? err.message : String(err);
      console.error(`Flow ${flowDef.id} failed with unhandled error (exec ${execId}):`, error);
      await db.update(executions).set({
        status: 'failed', error, completed_at: new Date(),
      }).where(eq(executions.id, execId)).catch(() => {});
      throw err;
    }
  });

  reaper.start();

  startReconciliation(db, flows, eq);

  process.on('SIGTERM', () => {
    console.log('Worker: shutting down...');
    stopReconciliation();
    reaper.stop();
    worker.close();
  });
  process.on('SIGINT', () => {
    console.log('Worker: shutting down...');
    stopReconciliation();
    reaper.stop();
    worker.close();
  });
}

main().catch((err) => {
  console.error('Worker: failed to start:', err);
  process.exit(1);
});
