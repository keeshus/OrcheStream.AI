import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetRateLimiters } from '../routes/webhook-security.js';

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
  desc: vi.fn((a: any) => ({ op: 'desc', a })),
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
    innerJoin: vi.fn(),
    limit: vi.fn(() => data !== undefined ? data : chain),
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    returning: vi.fn(),
    orderBy: vi.fn(() => chain),
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

// Make a chain thenable so await resolves to the given data
function thenable(chain: any, data: any) {
  chain.then = (onfulfilled: any) => Promise.resolve(data).then(onfulfilled);
  return chain;
}

function makeWebhookFlow(overrides = {}) {
  return {
    id: 'flow-1',
    name: 'My Webhook Flow',
    description: 'A test webhook flow',
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        data: {
          type: 'trigger',
          config: {
            triggerType: 'webhook',
            webhookSecret: 'secret123',
            inputSchema: '{"amount": "number", "currency": "string"}',
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

describe('webhook-openapi routes', () => {
  let router: any;
  let db: any;
  let req: any;
  let res: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimiters();
    db = (await import('../db/connection.js')).db;
    // Set up default chainable mocks for db methods
    db.select.mockReturnValue(mockChain([]));
    db.insert.mockReturnValue(mockChain());
    db.update.mockReturnValue(mockChain());
    const mod = await import('../routes/webhook-openapi.js');
    router = mod.default;
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

  describe('POST /webhook/:slug', () => {
    it('returns 404 when slug does not match any deployment', async () => {
      req.params = { slug: 'unknown' };
      const chain = mockChain([]);
      db.select.mockReturnValue(chain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Webhook endpoint not found' });
    });

    it('returns 401 when no auth credentials provided', async () => {
      req.params = { slug: 'my-flow' };
      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      db.select.mockReturnValue(deployChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Authentication required') }),
      );
    });

    it('executes a webhook flow and returns 202 with polling URL', async () => {
      req.params = { slug: 'my-webhook-flow' };
      req.headers = { authorization: 'Bearer wh_testkey123' };
      req.body = { amount: 100, currency: 'USD' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-webhook-flow' }]);
      const flowChain = mockChain([makeWebhookFlow()]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1', status: 'pending' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'queued',
          executionId: 'exec-1',
          pollingUrl: expect.stringContaining('exec-1'),
        }),
      );
    });

    it('returns 400 when trigger is not a webhook type', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([{
        ...makeWebhookFlow(),
        nodes: [{ id: 't1', type: 'trigger', data: { type: 'trigger', config: { triggerType: 'chat' } } }],
      }]);
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'This flow does not have a webhook trigger' });
    });

    it('validates input against schema', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 'not-a-number' };
      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([makeWebhookFlow()]);
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Input validation failed' }));
    });

    it('authenticates with webhook secret query param', async () => {
      req.params = { slug: 'my-flow' };
      req.query = { secret: 'secret123' };
      req.body = { amount: 100, currency: 'USD' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const authFlowChain = mockChain([makeWebhookFlow()]);
      const handlerFlowChain = mockChain([makeWebhookFlow()]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(authFlowChain)
        .mockReturnValueOnce(handlerFlowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('rejects invalid webhook secret', async () => {
      req.params = { slug: 'my-flow' };
      req.query = { secret: 'wrong-secret' };
      req.body = { amount: 100 };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const flowChain = mockChain([makeWebhookFlow()]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(flowChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid webhook secret' });
    });

    it('returns 401 with invalid API key (hash does not match)', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_badkey' };
      req.body = { amount: 100, currency: 'USD' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([]); // no key record matches this hash
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    });

    it('returns 400 when input has missing required fields', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = {}; // missing both amount and currency

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([makeWebhookFlow()]);
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Input validation failed',
          details: expect.arrayContaining([
            expect.stringContaining('Missing required field'),
          ]),
        }),
      );
    });

    it('skips schema validation and proceeds when inputSchema is invalid JSON', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100 };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([makeWebhookFlow({
        nodes: [{
          id: 'trigger-1', type: 'trigger',
          data: {
            type: 'trigger',
            config: {
              triggerType: 'webhook',
              inputSchema: 'not-valid-json{{{',
            },
          },
        }],
      })]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      // Schema parse error is caught and validation skipped; execution proceeds
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued', executionId: 'exec-1' }),
      );
    });

    it('returns 404 when deployment exists but flow is not found', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100 };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([]); // no flow record
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Flow not found' });
    });

    it('authenticates with the X-Webhook-Secret header', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { 'x-webhook-secret': 'secret123' };
      req.body = { amount: 100, currency: 'USD' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const authFlowChain = mockChain([makeWebhookFlow()]);
      const handlerFlowChain = mockChain([makeWebhookFlow()]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(authFlowChain)
        .mockReturnValueOnce(handlerFlowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('authenticates with the secret in a non-wh_ Authorization Bearer token', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer secret123' };
      req.body = { amount: 100, currency: 'USD' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const authFlowChain = mockChain([makeWebhookFlow()]);
      const handlerFlowChain = mockChain([makeWebhookFlow()]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(authFlowChain)
        .mockReturnValueOnce(handlerFlowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('accepts envOverrides, persists them and enqueues with them', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = {
        amount: 100,
        currency: 'USD',
        envOverrides: { API_KEY: 'sk-123', DB_PASS: { type: 'core_secret', value: 'db-pass' } },
      };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([makeWebhookFlow({ env_vars: [
        { name: 'API_KEY', type: 'static', value: 'configured-key' },
      ] })]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
      // envOverrides stripped from the flow input, persisted as __envOverrides
      expect(execChain.values).toHaveBeenCalledWith(expect.objectContaining({
        input: { amount: 100, currency: 'USD', __envOverrides: { API_KEY: 'sk-123', DB_PASS: { type: 'core_secret', value: 'db-pass' } } },
      }));
      expect(enqueueExecution).toHaveBeenCalledWith(
        expect.objectContaining({ envVars: [{ name: 'API_KEY', type: 'static', value: 'configured-key' }] }),
        { amount: 100, currency: 'USD', __executionId: 'exec-1' },
        { API_KEY: 'sk-123', DB_PASS: { type: 'core_secret', value: 'db-pass' } },
      );
    });

    it('envOverrides do not fail schema validation (extracted before it)', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100, currency: 'USD', envOverrides: { API_KEY: 'sk-123' } };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([makeWebhookFlow()]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('rejects invalid envOverrides with 400', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100, envOverrides: { API_KEY: [1, 2] } };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const flowChain = mockChain([makeWebhookFlow()]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(flowChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Invalid envOverride') }));
      expect(db.insert).not.toHaveBeenCalled();
      expect(enqueueExecution).not.toHaveBeenCalled();
    });

    it('header secret is preferred over a mismatched query secret', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { 'x-webhook-secret': 'secret123' };
      req.query = { secret: 'wrong-secret' };
      req.body = { amount: 100, currency: 'USD' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const authFlowChain = mockChain([makeWebhookFlow()]);
      const handlerFlowChain = mockChain([makeWebhookFlow()]);
      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(authFlowChain)
        .mockReturnValueOnce(handlerFlowChain);
      db.insert.mockReturnValue(execChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('returns 401 asking to configure auth when the deployment has no secret and no API keys', async () => {
      req.params = { slug: 'my-flow' };
      req.body = { amount: 100 };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const authFlowChain = mockChain([makeWebhookFlow({
        nodes: [{
          id: 'trigger-1', type: 'trigger',
          data: { type: 'trigger', config: { triggerType: 'webhook' } }, // no webhookSecret
        }],
      })]);
      const keyChain = mockChain([]); // no API keys
      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(authFlowChain)
        .mockReturnValueOnce(keyChain);

      const next = vi.fn(); getHandler(router, 'post', '/webhook/:slug')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('webhook secret or an API key') }),
      );
    });

    it('returns 429 with Retry-After once the per-deployment rate limit is exceeded', async () => {
      req.params = { slug: 'rate-limited-429' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.body = { amount: 100, currency: 'USD' };

      const execChain = mockChain();
      execChain.returning.mockResolvedValue([{ id: 'exec-1' }]);
      db.insert.mockReturnValue(execChain);

      const run = async () => {
        db.select
          .mockReset()
          .mockReturnValueOnce(mockChain([{ flow_id: 'flow-1', path_slug: 'rate-limited-429', rate_limit: 1 }]))
          .mockReturnValueOnce(mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]))
          .mockReturnValueOnce(mockChain([makeWebhookFlow()]));
        const next = vi.fn();
        getHandler(router, 'post', '/webhook/:slug')(req, res, next);
        await new Promise(r => setTimeout(r, 0));
        if (next.mock.calls.length > 0) throw next.mock.calls[0][0];
      };

      await run();
      expect(res.status).toHaveBeenCalledWith(202);

      res.status.mockClear();
      res.json.mockClear();
      res.setHeader.mockClear();

      await run();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
      expect(res.json).toHaveBeenCalledWith({ error: 'Rate limit exceeded. Try again later.' });

      // The 429 path does not consume the flow-lookup mock; drain the queue so
      // leftover once-implementations cannot leak into later tests.
      db.select.mockReset();
    });
  });

  describe('GET /webhook/:slug/executions/:executionId', () => {
    it('returns completed execution with output', async () => {
      req.params = { slug: 'my-flow', executionId: 'exec-1' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);

      const execChain = mockChain([{
        id: 'exec-1', flow_id: 'flow-1', status: 'completed', input: {},
        output: { result: 'done' }, error: null,
        started_at: new Date('2026-01-01'), completed_at: new Date('2026-01-02'), created_at: new Date('2026-01-01'),
      }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        id: 'exec-1', status: 'completed', output: { result: 'done' },
      }));
    });

    it('returns 404 when slug does not match', async () => {
      req.params = { slug: 'unknown', executionId: 'exec-1' };
      const chain = mockChain([]);
      db.select.mockReturnValue(chain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Webhook endpoint not found' });
    });

    it('returns 404 when execution does not exist', async () => {
      req.params = { slug: 'my-flow', executionId: 'nonexistent' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain([]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Execution not found' });
    });

    it('includes error field for failed execution', async () => {
      req.params = { slug: 'my-flow', executionId: 'exec-1' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain([{
        id: 'exec-1', flow_id: 'flow-1', status: 'failed', input: {},
        output: null, error: 'Something went wrong',
        started_at: new Date(), completed_at: new Date(), created_at: new Date(),
      }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed', error: 'Something went wrong',
      }));
    });

    it('shows awaiting_approval message', async () => {
      req.params = { slug: 'my-flow', executionId: 'exec-1' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain([{
        id: 'exec-1', flow_id: 'flow-1', status: 'awaiting_approval', input: {},
        output: null, error: null,
        started_at: new Date(), completed_at: null, created_at: new Date(),
      }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'awaiting_approval',
        message: 'Execution is paused awaiting human approval',
      }));
    });

    it('returns minimal response for running execution', async () => {
      req.params = { slug: 'my-flow', executionId: 'exec-1' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain([{
        id: 'exec-1', flow_id: 'flow-1', status: 'running', input: {},
        output: null, error: null,
        started_at: new Date(), completed_at: null, created_at: new Date(),
      }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.status).toBe('running');
      expect(call.output).toBeUndefined();
      expect(call.error).toBeUndefined();
      expect(call.completedAt).toBeUndefined();
    });

    it('returns 401 when no auth credentials provided', async () => {
      req.params = { slug: 'my-flow', executionId: 'exec-1' };
      // No authorization header, no secret

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      db.select.mockReturnValueOnce(deployChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Authentication required') }),
      );
    });

    it('returns minimal response for pending execution', async () => {
      req.params = { slug: 'my-flow', executionId: 'exec-1' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain([{
        id: 'exec-1', flow_id: 'flow-1', status: 'pending', input: {},
        output: null, error: null,
        started_at: new Date(), completed_at: null, created_at: new Date(),
      }]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions/:executionId')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.status).toBe('pending');
      expect(call.output).toBeUndefined();
      expect(call.error).toBeUndefined();
    });
  });

  describe('GET /webhook/:slug/executions', () => {
    it('lists recent executions for a flow', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.query = { limit: '5' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);

      const execChain = mockChain();
      execChain.orderBy.mockReturnValue(execChain);
      execChain.limit.mockResolvedValue([
        { id: 'exec-2', status: 'completed', created_at: new Date(), started_at: new Date(), completed_at: new Date() },
        { id: 'exec-1', status: 'running', created_at: new Date(), started_at: new Date(), completed_at: null },
      ]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.json).toHaveBeenCalledWith({
        executions: [
          expect.objectContaining({ id: 'exec-2', status: 'completed' }),
          expect.objectContaining({ id: 'exec-1', status: 'running' }),
        ],
      });
    });

    it('returns empty list when no executions exist', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);

      const execChain = mockChain();
      execChain.orderBy.mockReturnValue(execChain);
      execChain.limit.mockResolvedValue([]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.json).toHaveBeenCalledWith({ executions: [] });
    });

    it('returns 404 when slug does not match', async () => {
      req.params = { slug: 'unknown' };
      const chain = mockChain([]);
      db.select.mockReturnValue(chain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Webhook endpoint not found' });
    });

    it('caps limit to 50 when request exceeds maximum', async () => {
      req.params = { slug: 'my-flow' };
      req.headers = { authorization: 'Bearer wh_testkey' };
      req.query = { limit: '100' };

      const deployChain = mockChain([{ flow_id: 'flow-1', path_slug: 'my-flow' }]);
      const keyChain = mockChain([{ id: 'key-1', flow_id: 'flow-1', enabled: true }]);
      const execChain = mockChain();
      execChain.orderBy.mockReturnValue(execChain);
      execChain.limit.mockResolvedValue([]);

      db.select
        .mockReturnValueOnce(deployChain)
        .mockReturnValueOnce(keyChain)
        .mockReturnValueOnce(execChain);

      const next = vi.fn(); getHandler(router, 'get', '/webhook/:slug/executions')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(execChain.limit).toHaveBeenCalledWith(50);
    });
  });

  describe('GET /openapi.json', () => {
    it('returns OpenAPI spec with webhook flow paths', async () => {
      const rows = [{
        deployment: { path_slug: 'my-flow', rate_limit: 10, summary: 'Test flow' },
        flow: makeWebhookFlow({ name: 'My Flow' }),
      }];

      db.select.mockImplementation(() => ({
        from: () => ({
          innerJoin: vi.fn().mockResolvedValue(rows),
        }),
      }));

      const next = vi.fn(); getHandler(router, 'get', '/openapi.json')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const spec = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(spec.openapi).toBe('3.0.3');
      expect(spec.info.title).toBe('OrcheStream.AI — Webhook Flows API');
      expect(spec.paths).toHaveProperty('/api/webhook/my-flow');
      expect(spec.paths).toHaveProperty('/api/webhook/my-flow/executions/{executionId}');
      expect(spec.paths).toHaveProperty('/api/webhook/my-flow/executions');
      expect(spec.components.securitySchemes.apiKey).toBeDefined();
      expect(spec.components.schemas).toHaveProperty('my-flow_input');
      expect(spec.components.schemas).toHaveProperty('my-flow_execution_status');
    });

    it('includes input schema in the spec', async () => {
      const rows = [{
        deployment: { path_slug: 'my-flow', rate_limit: 0, summary: '' },
        flow: makeWebhookFlow(),
      }];

      db.select.mockImplementation(() => ({
        from: () => ({
          innerJoin: vi.fn().mockResolvedValue(rows),
        }),
      }));

      const next = vi.fn(); getHandler(router, 'get', '/openapi.json')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const spec = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const schema = spec.paths['/api/webhook/my-flow'].post.requestBody.content['application/json'].schema;
      expect(schema).toMatchObject({
        type: 'object',
        properties: { amount: { type: 'number' }, currency: { type: 'string' } },
      });
    });

    it('documents the envOverrides field in the request schema', async () => {
      const rows = [{
        deployment: { path_slug: 'my-flow', rate_limit: 0, summary: '' },
        flow: makeWebhookFlow(),
      }];

      db.select.mockImplementation(() => ({
        from: () => ({
          innerJoin: vi.fn().mockResolvedValue(rows),
        }),
      }));

      const next = vi.fn(); getHandler(router, 'get', '/openapi.json')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const spec = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const schema = spec.paths['/api/webhook/my-flow'].post.requestBody.content['application/json'].schema;
      expect(schema.properties.envOverrides).toBeDefined();
      expect(schema.properties.envOverrides.additionalProperties.anyOf).toHaveLength(2);
      expect(schema.properties.envOverrides.additionalProperties.anyOf[1].properties.type.enum).toEqual(['core_secret', 'cyberark']);
      // The flow's own fields are still documented alongside
      expect(schema.properties.amount).toEqual({ type: 'number' });
    });

    it('allows additional properties when no inputSchema configured', async () => {
      const rows = [{
        deployment: { path_slug: 'no-schema', rate_limit: 0, summary: '' },
        flow: makeWebhookFlow({
          nodes: [{
            id: 'trigger-1', type: 'trigger',
            data: { type: 'trigger', config: { triggerType: 'webhook' } },
          }],
        }),
      }];

      db.select.mockImplementation(() => ({
        from: () => ({
          innerJoin: vi.fn().mockResolvedValue(rows),
        }),
      }));

      const next = vi.fn(); getHandler(router, 'get', '/openapi.json')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const spec = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const schema = spec.paths['/api/webhook/no-schema'].post.requestBody.content['application/json'].schema;
      expect(schema.additionalProperties).toBe(true);
    });

    it('skips flows without a webhook trigger node', async () => {
      const rows = [{
        deployment: { path_slug: 'chat-flow', rate_limit: 0, summary: '' },
        flow: makeWebhookFlow({
          nodes: [{ id: 't1', type: 'trigger', data: { type: 'trigger', config: { triggerType: 'chat' } } }],
        }),
      }];

      db.select.mockImplementation(() => ({
        from: () => ({
          innerJoin: vi.fn().mockResolvedValue(rows),
        }),
      }));

      const next = vi.fn(); getHandler(router, 'get', '/openapi.json')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const spec = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(Object.keys(spec.paths)).toHaveLength(0);
    });

    it('returns empty paths when no deployments exist', async () => {
      db.select.mockImplementation(() => ({
        from: () => ({
          innerJoin: vi.fn().mockResolvedValue([]),
        }),
      }));

      const next = vi.fn(); getHandler(router, 'get', '/openapi.json')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      const spec = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(Object.keys(spec.paths)).toHaveLength(0);
      expect(spec.components.securitySchemes.apiKey).toBeDefined();
    });
  });

  describe('GET /docs', () => {
    it('returns Swagger UI HTML page', async () => {
      const next = vi.fn(); getHandler(router, 'get', '/docs')(req, res, next); await new Promise(r => setTimeout(r, 0)); if (next.mock.calls.length > 0) throw next.mock.calls[0][0];

      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('swagger-ui'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('/api/openapi.json'));
    });
  });
});
