import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildExecutionContext } from '../executor/context.js';

// Tables are imported dynamically from the shared package inside
// buildExecutionContext; the drizzle operators likewise. Provide table
// identifiers (with a __name marker the mock DB reads) plus the crypto /
// Conjur functions.
const { tables } = vi.hoisted(() => {
  const tables = {
    llmEndpoints: { __name: 'llmEndpoints' },
    mcpServers: { __name: 'mcpServers' },
    embeddingProviders: { __name: 'embeddingProviders' },
    vectorStores: { __name: 'vectorStores' },
    flows: { __name: 'flows' },
    groups: { __name: 'groups' },
    agentContexts: { __name: 'agentContexts' },
    agentStore: { __name: 'agentStore' },
    secrets: {
      __name: 'secrets',
      name: { name: 'name' },
      scope: { name: 'scope' },
      scope_id: { name: 'scope_id' },
      encrypted_value: { name: 'encrypted_value' },
      encryption_iv: { name: 'encryption_iv' },
      encryption_tag: { name: 'encryption_tag' },
      key_version: { name: 'key_version' },
    },
    secretVaults: {
      __name: 'secretVaults',
      id: { name: 'id' },
      is_connected: { name: 'is_connected' },
      api_key: { name: 'api_key' },
      base_url: { name: 'base_url' },
      account: { name: 'account' },
      login: { name: 'login' },
      ca_cert: { name: 'ca_cert' },
      self_hosted: { name: 'self_hosted' },
    },
    groupVaultConfig: {
      __name: 'groupVaultConfig',
      group_id: { name: 'group_id' },
      vault_id: { name: 'vault_id' },
    },
  };
  return { tables };
});

vi.mock('orchestream-ai-shared', () => ({
  ...tables,
  decrypt: vi.fn(async (encryptedValue: string) => 'dec:' + encryptedValue),
  getSecret: vi.fn(async (_opts: any, variableId: string) => 'conjur:' + variableId),
  getStore: vi.fn(() => undefined),
  listStores: vi.fn(() => []),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: any, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  isNull: vi.fn((col: any) => ({ op: 'isNull', col })),
}));

function matches(cond: any, row: any): boolean {
  if (cond.op === 'and') return cond.args.every((c: any) => matches(c, row));
  if (cond.op === 'eq') {
    const col = cond.col?.name;
    if (cond.val === null) return row[col] == null;
    return row[col] === cond.val;
  }
  if (cond.op === 'isNull') return row[cond.col?.name] == null;
  return true;
}

function makeDb(fixtures: Record<string, any[]>) {
  return {
    select: vi.fn((_cols?: any) => ({
      from: vi.fn((table: any) => ({
        where: vi.fn((cond: any) => ({
          limit: vi.fn(async () => {
            const rows = fixtures[table?.__name] || [];
            if (!cond) return rows.slice(0, 1);
            return rows.filter(r => matches(cond, r)).slice(0, 1);
          }),
        })),
      })),
    })),
  };
}

const SECRET = { encryption_iv: 'iv', encryption_tag: 'tag', key_version: 1 };

function makeFlow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'flow-1', name: 'Test', description: '', nodes: [], edges: [], version: 1,
    groupId: 'group-G',
    envVars: [
      { name: 'API_KEY', type: 'static', value: 'configured-key' },
      { name: 'DB_PASS', type: 'core_secret', value: 'db-pass' },
      { name: 'VAULT_TOKEN', type: 'cyberark', value: 'prod/token' },
      { name: 'KEEP', type: 'static', value: 'keep-value' },
    ],
    ...overrides,
  } as any;
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    db: makeDb({}),
    flow: makeFlow(),
    input: { message: 'hi' },
    executionId: 'exec-1',
    sandboxEnv: {},
    onSubExecution: async () => 'sub-1',
    completeSubExecution: async () => {},
    logSecretAccess: vi.fn(),
    ...overrides,
  } as any;
}

describe('buildExecutionContext — env override merge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('plaintext override wins over the configured static value', async () => {
    const options = makeOptions({
      envOverrides: { API_KEY: 'sk-override' },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv!.API_KEY).toBe('sk-override');
    expect(context.sandboxEnv!.KEEP).toBe('keep-value');
  });

  it('plaintext override replaces a secret-typed flow var', async () => {
    const options = makeOptions({
      envOverrides: { DB_PASS: 'plain-xyz' },
    });
    const context = await buildExecutionContext(options);
    // The flow's own resolution put the core secret in first; the plaintext
    // override then wins.
    expect(context.sandboxEnv!.DB_PASS).toBe('plain-xyz');
  });

  it('core_secret override resolves group-scoped before app-wide', async () => {
    const db = makeDb({
      secrets: [
        { name: 'db-pass', scope: 'group', scope_id: 'group-G', encrypted_value: 'ev-group', ...SECRET },
        { name: 'db-pass', scope: 'app', scope_id: null, encrypted_value: 'ev-app', ...SECRET },
      ],
    });
    const options = makeOptions({
      db,
      envOverrides: { DB_PASS: { type: 'core_secret', value: 'db-pass' } },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv!.DB_PASS).toBe('dec:ev-group');
  });

  it('core_secret override prefers flow-scoped secrets over group/app', async () => {
    const db = makeDb({
      secrets: [
        { name: 'db-pass', scope: 'flow', scope_id: 'flow-1', encrypted_value: 'ev-flow', ...SECRET },
        { name: 'db-pass', scope: 'group', scope_id: 'group-G', encrypted_value: 'ev-group', ...SECRET },
        { name: 'db-pass', scope: 'app', scope_id: null, encrypted_value: 'ev-app', ...SECRET },
      ],
    });
    const options = makeOptions({
      db,
      envOverrides: { DB_PASS: { type: 'core_secret', value: 'db-pass' } },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv!.DB_PASS).toBe('dec:ev-flow');
  });

  it('a group-scoped secret of another group never resolves (scope_id filtered)', async () => {
    // The only 'g2-secret' lives in group-H — a flow in group-G must not see it.
    const db = makeDb({
      secrets: [
        { name: 'g2-secret', scope: 'group', scope_id: 'group-H', encrypted_value: 'ev-H', ...SECRET },
      ],
    });
    const options = makeOptions({
      db,
      flow: makeFlow({ envVars: [{ name: 'G2', type: 'static', value: 'fallback' }] }),
      envOverrides: { G2: { type: 'core_secret', value: 'g2-secret' } },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv!.G2).toBe('fallback');
  });

  it('unknown names are silently ignored (allowlist)', async () => {
    const db = makeDb({
      secrets: [{ name: 'api-key', scope: 'app', scope_id: null, encrypted_value: 'ev', ...SECRET }],
    });
    const options = makeOptions({
      db,
      envOverrides: {
        NOT_ON_FLOW: 'injected',
        OTHER: { type: 'core_secret', value: 'api-key' },
      },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv).not.toHaveProperty('NOT_ON_FLOW');
    expect(context.sandboxEnv).not.toHaveProperty('OTHER');
  });

  it('unresolved secret references are silently skipped', async () => {
    const options = makeOptions({
      envOverrides: { DB_PASS: { type: 'core_secret', value: 'missing-secret' } },
    });
    const context = await buildExecutionContext(options);
    // The flow's own configured value remains (getSecret default app scope
    // lookup also misses here, so DB_PASS is simply absent).
    expect(context.sandboxEnv!.DB_PASS).toBeUndefined();
    expect(options.logSecretAccess).not.toHaveBeenCalled();
  });

  it('cyberark override resolves via the flow group vault and wins', async () => {
    const db = makeDb({
      groupVaultConfig: [{ group_id: 'group-G', vault_id: 'vault-1' }],
      secretVaults: [{
        id: 'vault-1', is_connected: true, api_key: 'k1:k2:k3:1',
        base_url: 'https://conjur', account: 'acct', login: 'svc', self_hosted: false,
      }],
    });
    const options = makeOptions({
      db,
      flow: makeFlow({ envVars: [{ name: 'VAULT_TOKEN', type: 'static', value: 'static-token' }] }),
      envOverrides: { VAULT_TOKEN: { type: 'cyberark', value: 'prod/override' } },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv!.VAULT_TOKEN).toBe('conjur:prod/override');
    expect(options.logSecretAccess).toHaveBeenCalledWith({
      name: 'prod/override', action: 'resolve', source: 'env_override_cyberark',
    });
  });

  it('logs core_secret override resolutions to the secret access log', async () => {
    const db = makeDb({
      secrets: [
        { name: 'db-pass', scope: 'group', scope_id: 'group-G', encrypted_value: 'ev-group', ...SECRET },
      ],
    });
    const options = makeOptions({
      db,
      envOverrides: { DB_PASS: { type: 'core_secret', value: 'db-pass' } },
    });
    await buildExecutionContext(options);
    expect(options.logSecretAccess).toHaveBeenCalledWith({
      name: 'db-pass', action: 'resolve', source: 'env_override',
    });
  });

  it('does not resolve overrides when the flow has no env vars', async () => {
    const db = makeDb({
      secrets: [{ name: 'api-key', scope: 'app', scope_id: null, encrypted_value: 'ev', ...SECRET }],
    });
    const options = makeOptions({
      db,
      flow: makeFlow({ envVars: [] }),
      envOverrides: { API_KEY: { type: 'core_secret', value: 'api-key' } },
    });
    const context = await buildExecutionContext(options);
    expect(context.sandboxEnv).toEqual({});
    expect(options.logSecretAccess).not.toHaveBeenCalled();
  });
});

// ── Hardening: scope-aware getSecret (template resolution path) ──────────────

describe('buildExecutionContext — getSecret scope isolation (hardening)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('group-scoped template lookup resolves only the flow\'s own group secret', async () => {
    // The other group's same-named secret exists and would be matched by an
    // unscoped lookup — the scope_id filter must exclude it.
    const db = makeDb({
      secrets: [
        { name: 'db-pass', scope: 'group', scope_id: 'group-G', encrypted_value: 'ev-own', ...SECRET },
        { name: 'db-pass', scope: 'group', scope_id: 'group-H', encrypted_value: 'ev-other', ...SECRET },
      ],
    });
    const context = await buildExecutionContext(makeOptions({ db }));
    const value = await context.getSecret!('db-pass', { scope: 'group' });
    expect(value).toBe('dec:ev-own');
  });

  it('group-scoped template lookup never resolves another group\'s secret', async () => {
    const db = makeDb({
      secrets: [
        { name: 'db-pass', scope: 'group', scope_id: 'group-H', encrypted_value: 'ev-other', ...SECRET },
      ],
    });
    const context = await buildExecutionContext(makeOptions({ db }));
    const value = await context.getSecret!('db-pass', { scope: 'group' });
    expect(value).toBeNull();
  });

  it('group-scoped template lookup returns null for global flows (no group)', async () => {
    const db = makeDb({
      secrets: [{ name: 'db-pass', scope: 'group', scope_id: 'group-H', encrypted_value: 'ev-other', ...SECRET }],
    });
    const context = await buildExecutionContext(makeOptions({ flow: makeFlow({ groupId: undefined }) }));
    const value = await context.getSecret!('db-pass', { scope: 'group' });
    expect(value).toBeNull();
  });

  it('flow-scoped template lookup resolves only the flow\'s own secret', async () => {
    const db = makeDb({
      secrets: [
        { name: 'flow-token', scope: 'flow', scope_id: 'flow-1', encrypted_value: 'ev-own', ...SECRET },
        { name: 'flow-token', scope: 'flow', scope_id: 'flow-2', encrypted_value: 'ev-other', ...SECRET },
      ],
    });
    const context = await buildExecutionContext(makeOptions({ db }));
    const value = await context.getSecret!('flow-token', { scope: 'flow' });
    expect(value).toBe('dec:ev-own');
  });

  it('flow-scoped template lookup never resolves another flow\'s secret', async () => {
    const db = makeDb({
      secrets: [{ name: 'flow-token', scope: 'flow', scope_id: 'flow-2', encrypted_value: 'ev-other', ...SECRET }],
    });
    const context = await buildExecutionContext(makeOptions({ db }));
    const value = await context.getSecret!('flow-token', { scope: 'flow' });
    expect(value).toBeNull();
  });

  it('app-scoped template lookup stays app-wide (unchanged behavior)', async () => {
    const db = makeDb({
      secrets: [
        { name: 'app-key', scope: 'app', scope_id: null, encrypted_value: 'ev-app', ...SECRET },
        { name: 'app-key', scope: 'group', scope_id: 'group-G', encrypted_value: 'ev-group', ...SECRET },
      ],
    });
    const context = await buildExecutionContext(makeOptions({ db }));
    const value = await context.getSecret!('app-key');
    expect(value).toBe('dec:ev-app');
  });
});
