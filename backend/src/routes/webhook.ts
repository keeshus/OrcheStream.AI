import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/connection.js';
import { flows, apiDeployments, executions } from '../db/schema.js';
import { enqueueExecution } from '../../../worker/src/queue.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticateWebhookRequest, enforceWebhookRateLimit, enforceWebhookIpRateLimit } from './webhook-security.js';
import type { NodeData, FlowDefinition, EnvOverrides } from 'orchestream-ai-shared';
import { parseEnvOverrides } from 'orchestream-ai-shared';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/webhook/:flowId — trigger a flow via webhook (UUID or slug)
// Auth: X-Webhook-Secret header or Authorization: Bearer <wh_ API key or secret>.
// ?secret=... is still accepted for backward compatibility, but the header is
// preferred so the secret does not end up in logs/history.
router.post(
  '/webhook/:flowId',
  asyncHandler(async (req, res) => {
    // Per-IP throttle BEFORE any DB work — unauthenticated spam must not
    // burn flow lookups at full speed (see webhook-security.ts).
    const ipRetryAfter = enforceWebhookIpRateLimit(req.ip || '');
    if (ipRetryAfter !== null) {
      res.setHeader('Retry-After', String(ipRetryAfter));
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    let flowId = req.params.flowId as string;

    // If not a UUID, try resolving as a slug
    if (!UUID_RE.test(flowId)) {
      const [deployment] = await db.select().from(apiDeployments).where(eq(apiDeployments.path_slug, flowId));
      if (deployment) {
        flowId = deployment.flow_id;
      }
    }

    // Load flow
    const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
    if (!flow) {
      res.status(404).json({ error: 'Flow not found' });
      return;
    }

    // Find trigger node and verify it's a webhook trigger
    const nodes = (flow.nodes || []) as Array<{ type: string; data: NodeData }>;
    const triggerNode = nodes.find(n => n.data?.type === 'trigger');
    if (!triggerNode || (triggerNode.data as any).config?.triggerType !== 'webhook') {
      res.status(400).json({ error: 'This flow does not have a webhook trigger' });
      return;
    }

    // Verify credentials (API key or webhook secret) — deployments without
    // either configured are never publicly triggerable
    const authError = await authenticateWebhookRequest(req, flowId, flow);
    if (authError) {
      res.status(authError.status).json({ error: authError.message });
      return;
    }

    // Enforce per-deployment rate limit (keyed by slug, or flowId for UUID calls)
    const [deployment] = await db.select().from(apiDeployments).where(eq(apiDeployments.flow_id, flowId)).limit(1);
    const retryAfter = enforceWebhookRateLimit(deployment?.path_slug || flowId, deployment?.rate_limit || 0);
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    // Per-run env overrides: extracted before schema validation, validated,
    // then stripped from the flow input (mirrors webhook-openapi.ts).
    const rawOverrides = (req.body && typeof req.body === 'object') ? req.body.envOverrides : undefined;
    const parsedOverrides = parseEnvOverrides(rawOverrides);
    if (!parsedOverrides.ok) {
      res.status(400).json({ error: parsedOverrides.error });
      return;
    }
    const envOverrides: EnvOverrides | undefined = Object.keys(parsedOverrides.value).length > 0 ? parsedOverrides.value : undefined;
    const flowBody = { ...req.body };
    delete flowBody.envOverrides;

    // Validate input schema if defined
    const inputSchema = (triggerNode.data as any).config?.inputSchema;
    if (inputSchema) {
      try {
        const schema = typeof inputSchema === 'string' ? JSON.parse(inputSchema) : inputSchema;
        const errors = validateInput(flowBody, schema);
        if (errors.length > 0) {
          res.status(400).json({
            error: 'Input validation failed',
            details: errors,
            expectedSchema: schema,
          });
          return;
        }
      } catch {
        // Schema parse error — skip validation, log warning
        console.warn('Webhook: could not parse inputSchema, skipping validation');
      }
    }

    const input = { ...flowBody };
    if (req.headers['content-type']?.includes('text/plain')) {
      input.message = (req as any).body || '';
    }

    // Create execution record and enqueue via BullMQ. The overrides are
    // persisted on the record exactly as supplied (never resolved plaintext)
    // for auditing.
    const [exec] = await db.insert(executions).values({
      flow_id: flowId, status: 'pending',
      input: envOverrides ? { ...input, __envOverrides: envOverrides } : input,
      started_at: new Date(),
    }).returning();

    const flowDef: FlowDefinition = {
      id: flow.id, name: flow.name, description: flow.description || '',
      nodes: flow.nodes as any[], edges: flow.edges as any[],
      version: flow.version,
      createdAt: flow.created_at?.toISOString() || '', updatedAt: flow.updated_at?.toISOString() || '',
      flowContext: flow.flow_context || '',
      groupId: flow.group_id || undefined,
      envVars: (flow.env_vars as any[]) || [],
    };

    await enqueueExecution(flowDef, { ...input, __executionId: exec.id }, envOverrides);

    res.json({ status: 'queued', executionId: exec.id });
  }),
);

// Simple schema validator for webhook input
// Schema format: { "fieldName": "expectedType" }
// Supported types: string, number, boolean, array, object
function validateInput(body: any, schema: Record<string, string>): string[] {
  const errors: string[] = [];

  for (const [field, expectedType] of Object.entries(schema)) {
    const value = body[field];

    // Check presence
    if (value === undefined || value === null) {
      errors.push(`Missing required field: "${field}" (expected ${expectedType})`);
      continue;
    }

    // Check type
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== expectedType) {
      errors.push(`Field "${field}": expected ${expectedType}, got ${actualType}`);
    }
  }

  return errors;
}

export default router;
