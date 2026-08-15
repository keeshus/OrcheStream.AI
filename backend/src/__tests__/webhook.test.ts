import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js', () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() } }));

vi.mock('orchestream-ai-shared', () => ({
  flows: { _: { name: 'flows' } },
  apiDeployments: { _: { name: 'api_deployments' } },
  apiKeys: { _: { name: 'api_keys' } },
  executions: { _: { name: 'executions' } },
  parseEnvOverrides: (raw: unknown) => {
    if (raw === undefined || raw === null) return { ok: true, value: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'envOverrides must be a flat object mapping variable names to strings or { type, value } objects' };
    }
    const value: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof val === 'string') { value[name] = val; continue; }
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const { type, value: v } = val as { type?: unknown; value?: unknown };
        if ((type === 'core_secret' || type === 'cyberark') && typeof v === 'string') { value[name] = { type, value: v }; continue; }
        return { ok: false, error: `Invalid envOverride for "${name}": expected { type: 'core_secret' | 'cyberark', value: string }` };
      }
      return { ok: false, error: `Invalid envOverride for "${name}": expected a string or { type, value } object` };
    }
    return { ok: true, value };
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: any, b: any) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: any[]) => ({ op: 'and', args })),
}));

vi.mock('../../../worker/src/queue.js', () => ({
  enqueueExecution: vi.fn(async () => {}),
}));

import { enqueueExecution } from '../../../worker/src/queue.js';

function getHandler(router: any, method: string, path: string) {
  for (const layer of router.stack) {
    const r = layer.route;
    if (r?.path === path && r.methods?.[method]) {
      return r.stack.at(-1).handle;
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
}

function mockChain(data?: any) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => data !== undefined ? data : chain),
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    returning: vi.fn(),
    then: undefined as any,
    catch: vi.fn(),
  };
  if (data !== undefined) {
    chain.then = (onfulfilled: any) => {
      const result = onfulfilled(data);
      return result instanceof Promise ? result : Promise.resolve(result);
    };
  }
  return chain;
}

function makeWebhookFlow(overrides = {}) {
  return {
    id: 'flow-1',
    name: 'Test Webhook Flow',
    description: 'A test flow',
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        data: {
          type: 'trigger',
          config: {
            triggerType: 'webhook',
          },
        },
      },
    ],
    edges: [],
    version: 1,
    created_by: 'user-1',
    group_id: null,
    is_subflow: false,
    flow_context: '',
    env_vars: [],
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

async function callHandler(handler: any, req: any, res: any) {
  const next = vi.fn();
  handler(req, res, next);
  await new Promise(r => setTimeout(r, 0));
  if (next.mock.calls.length > 0) throw next.mock.calls[0][0];
}

describe('webhook routes (slug resolution)', () => {
  let router: any;
  let db: any;
  let req: any;
  let res: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    db = (await import('../db/connection.js')).db;
    db.select.mockReturnValue(mockChain([]));
    db.insert.mockReturnValue(mockChain());
    db.update.mockReturnValue(mockChain());
    const mod = await import('../routes/webhook.js');
    router = mod.default;
    const { resetRateLimiters } = await import('../routes/webhook-security.js');
    resetRateLimiters();
    req = {
      params: {},
      query: {},
      body: {},
      headers: {},
      protocol: 'http',
      get: vi.fn().mockReturnValue('localhost:3001'),
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
      end: vi.fn(),
      setHeader: vi.fn(),
    };
  });

  describe('POST /webhook/:flowId', () => {
    it('UUID flowId passes through and executes with a valid secret', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440000';
      req.params = { flowId };
      req.query = { secret: 'test-secret' };
      req.body = { amount: 100 };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'test-secret' } },
      }] })]);
      const deployChain = mockChain([]); // no deployment row → default rate limit
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(deployChain);
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      // Flow lookup + deployment lookup (no auth DB lookups — flow preloaded, secret matched)
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });
    });

    it('UUID flowId executes with a valid personal API key', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440000';
      req.params = { flowId };
      req.headers = { authorization: 'Bearer wh_testkey123' };
      req.body = { amount: 100 };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId })]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: flowId, enabled: true }]);
      const deployChain = mockChain([]);
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(keyChain).mockReturnValueOnce(deployChain);
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      // Flow + API key + deployment
      expect(db.select).toHaveBeenCalledTimes(3);
      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });
    });

    it('non-UUID slug resolves via apiDeployments lookup and executes with API key', async () => {
      req.params = { flowId: 'my-slug' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100 };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-slug', rate_limit: 0 }]);
      const flowChain = mockChain([makeWebhookFlow()]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const deployByFlowChain = mockChain([{ path_slug: 'my-slug', rate_limit: 0 }]);
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(flowChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(deployByFlowChain);
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      // Slug resolution + flow + API key + deployment rate limit lookup
      expect(db.select).toHaveBeenCalledTimes(4);
      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });
    });

    it('non-UUID slug not found returns 404', async () => {
      req.params = { flowId: 'unknown-slug' };

      const deployChain = mockChain([]);
      db.select.mockReturnValue(deployChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      // Slug lookup + flow lookup both empty → 404
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Flow not found' });
    });

    it('returns 401 when flow has no secret and no API keys (not publicly triggerable)', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440001';
      req.params = { flowId };
      req.body = { amount: 100 };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId })]); // no webhookSecret
      const keyChain = mockChain([]); // no keys
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(keyChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Authentication required') }),
      );
    });

    it('returns 403 for an invalid webhook secret', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440002';
      req.params = { flowId };
      req.query = { secret: 'wrong-secret' };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'right-secret' } },
      }] })]);
      db.select.mockReturnValueOnce(flowChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid webhook secret' });
    });

    it('accepts the secret via the X-Webhook-Secret header', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440003';
      req.params = { flowId };
      req.headers = { 'x-webhook-secret': 'test-secret' };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'test-secret' } },
      }] })]);
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(mockChain([]));
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });
    });

    it('returns 429 with Retry-After when the deployment rate limit is exceeded', async () => {
      req.params = { flowId: 'my-slug' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100 };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'rate-limited', rate_limit: 1 }]);
      const flowChain = mockChain([makeWebhookFlow()]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const deployByFlowChain = mockChain([{ path_slug: 'rate-limited', rate_limit: 1 }]);
      const chains = [deployChain, flowChain, keyChain, deployByFlowChain];
      let selectIndex = 0;
      db.select.mockImplementation(() => chains[selectIndex++ % chains.length]);
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);
      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });

      // Second call within the window → 429
      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({ error: 'Rate limit exceeded. Try again later.' });
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    it('accepts plaintext envOverrides, persists them on the record and enqueues with them', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440004';
      req.params = { flowId };
      req.query = { secret: 'test-secret' };
      req.body = { amount: 100, envOverrides: { API_KEY: 'sk-123' } };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, env_vars: [
        { name: 'API_KEY', type: 'static', value: 'configured-key' },
        { name: 'DB_PASS', type: 'core_secret', value: 'db-pass' },
      ], nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'test-secret' } },
      }] })]);
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(mockChain([]));
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });
      // envOverrides stripped from the flow input, persisted as __envOverrides
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
        flow_id: flowId,
        input: { amount: 100, __envOverrides: { API_KEY: 'sk-123' } },
      }));
      // Enqueued with the overrides and the flowDef now carries env_vars
      expect(enqueueExecution).toHaveBeenCalledWith(
        expect.objectContaining({ envVars: [
          { name: 'API_KEY', type: 'static', value: 'configured-key' },
          { name: 'DB_PASS', type: 'core_secret', value: 'db-pass' },
        ] }),
        { amount: 100, __executionId: 'exec-1' },
        { API_KEY: 'sk-123' },
      );
    });

    it('accepts core_secret and cyberark reference overrides', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440005';
      req.params = { flowId };
      req.query = { secret: 'test-secret' };
      req.body = {
        amount: 100,
        envOverrides: {
          DB_PASS: { type: 'core_secret', value: 'db-pass' },
          VAULT_TOKEN: { type: 'cyberark', value: 'prod/token' },
        },
      };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'test-secret' } },
      }] })]);
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(mockChain([]));
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(res.json).toHaveBeenCalledWith({ status: 'queued', executionId: 'exec-1' });
      expect(enqueueExecution).toHaveBeenCalledWith(
        expect.anything(),
        { amount: 100, __executionId: 'exec-1' },
        {
          DB_PASS: { type: 'core_secret', value: 'db-pass' },
          VAULT_TOKEN: { type: 'cyberark', value: 'prod/token' },
        },
      );
    });

    it('rejects invalid envOverrides with 400', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440006';
      req.params = { flowId };
      req.query = { secret: 'test-secret' };
      req.body = { amount: 100, envOverrides: { API_KEY: { type: 'bogus', value: 'x' } } };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'test-secret' } },
      }] })]);
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(mockChain([]));

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Invalid envOverride') }));
      expect(db.insert).not.toHaveBeenCalled();
      expect(enqueueExecution).not.toHaveBeenCalled();
    });

    it('includes flow env vars in the enqueued flowDef (regression: webhook runs previously resolved none)', async () => {
      const flowId = '550e8400-e29b-41d4-a716-446655440007';
      req.params = { flowId };
      req.query = { secret: 'test-secret' };
      req.body = { amount: 100 };

      const flowChain = mockChain([makeWebhookFlow({ id: flowId, env_vars: [
        { name: 'GITLAB_TOKEN', type: 'core_secret', value: 'gitlab-token' },
      ], nodes: [{
        id: 'trigger-1', type: 'trigger',
        data: { type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'test-secret' } },
      }] })]);
      db.select.mockReturnValueOnce(flowChain).mockReturnValueOnce(mockChain([]));
      const insertChain = mockChain();
      insertChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(insertChain);

      await callHandler(getHandler(router, 'post', '/webhook/:flowId'), req, res);

      expect(enqueueExecution).toHaveBeenCalledWith(
        expect.objectContaining({ envVars: [{ name: 'GITLAB_TOKEN', type: 'core_secret', value: 'gitlab-token' }] }),
        expect.anything(),
        undefined,
      );
    });
  });
});
