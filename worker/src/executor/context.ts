// ── Shared execution context builder ──────────────────────────────────
// Builds the full ExecutionContext (LLM endpoints, MCP servers, embedding
// providers, vector stores, flows, secrets, CyberArk, contexts, sandbox env)
// from the database. Used by BOTH the backend (debug runs) and the worker
// (all persisted runs), so the two can never drift.

import type { ExecutionContext } from './engine.js';
import type { FlowDefinition } from 'orchestream-ai-shared';
import { decrypt, getSecret as conjurGetSecret, getStore, listStores } from 'orchestream-ai-shared';

export interface ContextBuilderOptions {
  db: any;
  flow: FlowDefinition;
  input: Record<string, unknown>;
  executionId: string;
  /** Flow-level env vars already resolved to static values (for the sandbox). */
  sandboxEnv: Record<string, string>;
  /** Hooks that differ between the backend and the worker. */
  onSubExecution: (data: { parentExecutionId: string; subflowNodeId: string; subflowId: string; input: Record<string, unknown>; depth: number; path: string }) => Promise<string>;
  completeSubExecution: (subExecutionId: string, output: Record<string, unknown>, status: 'completed' | 'failed', error?: string) => Promise<void>;
  logSecretAccess?: (entry: { name: string; action: string; source: string }) => void;
  /** Override the vector-store search (defaults to the registered stores). */
  searchSimilar?: (collectionName: string, queryEmbedding: number[], topK: number, minScore: number) => Promise<Array<{ documentId: string; chunkText: string; chunkIndex: number; similarity: number }>>;
  setSecret?: (name: string, value: string) => void;
}

/**
 * Build the execution context used by the flow engine. All secrets and
 * endpoints are resolved lazily per call, so flows only pay for what they use.
 */
export async function buildExecutionContext(options: ContextBuilderOptions): Promise<ExecutionContext> {
  const { db, flow, input, executionId, sandboxEnv } = options;
  const flowGroupId = flow.groupId;

  // Tables are imported lazily from the shared schema to keep startup cheap.
  const { llmEndpoints, mcpServers, embeddingProviders, vectorStores, flows, groups, agentContexts, agentStore, secrets, secretVaults, groupVaultConfig } = await import('orchestream-ai-shared');
  const { eq, and, inArray } = await import('drizzle-orm');

  const context: ExecutionContext = {
    currentExecutionId: executionId,
    flowNodes: flow.nodes as any,
    flowEdges: flow.edges as any,
    sandboxExecutionId: executionId,
    sandboxEnv,

    getEndpoint: async (endpointId: string) => {
      const [endpoint] = await db.select().from(llmEndpoints).where(eq(llmEndpoints.id, endpointId));
      if (!endpoint) return null;
      if (endpoint.group_id && endpoint.group_id !== flowGroupId) return null;
      return {
        providerType: endpoint.provider_type as 'anthropic' | 'openai' | 'litellm',
        apiKey: endpoint.api_key,
        baseUrl: endpoint.base_url ?? null,
      };
    },

    getMCPServer: async (serverId: string) => {
      const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
      if (!server) return null;
      if (server.group_id && server.group_id !== flowGroupId) return null;
      return {
        id: server.id,
        name: server.name,
        url: server.url,
        tools: server.tools as any[],
        enabled: server.enabled,
      };
    },

    getEmbeddingProvider: async (providerId: string) => {
      const [ep] = await db.select().from(embeddingProviders).where(eq(embeddingProviders.id, providerId));
      if (!ep) return null;
      if (ep.group_id && ep.group_id !== flowGroupId) return null;
      return { providerType: ep.provider_type, apiKey: ep.api_key, baseUrl: ep.base_url, model: ep.model };
    },

    getVectorStore: async (storeId: string) => {
      const [vs] = await db.select().from(vectorStores).where(eq(vectorStores.id, storeId));
      if (!vs) return null;
      if (vs.group_id && vs.group_id !== flowGroupId) return null;
      return { name: vs.name, url: vs.url, apiKey: vs.api_key };
    },

    getFlow: async (flowId: string, ancestry?: string[]) => {
      const [flowRow] = await db.select().from(flows).where(eq(flows.id, flowId));
      if (!flowRow) return null;
      if (ancestry?.includes(flowId)) {
        throw new Error(`Circular subflow reference detected: ${ancestry.join(' -> ')} -> ${flowRow.name}`);
      }
      return {
        id: flowRow.id,
        name: flowRow.name,
        description: flowRow.description || '',
        nodes: flowRow.nodes as any,
        edges: flowRow.edges as any,
        version: flowRow.version,
        envVars: flowRow.env_vars as any[] | undefined,
        createdAt: flowRow.created_at?.toISOString() || '',
        updatedAt: flowRow.updated_at?.toISOString() || '',
      };
    },

    onSubExecution: options.onSubExecution,
    completeSubExecution: options.completeSubExecution,

    getGlobalContext: async () => {
      const [row] = await db.select().from(agentStore).where(eq(agentStore.key, 'global_context')).limit(1);
      return (row?.value as string) || '';
    },

    getGroupContext: async (groupId: string) => {
      if (!groupId) return '';
      const [row] = await db.select({ context: groups.context }).from(groups).where(eq(groups.id, groupId)).limit(1);
      return row?.context || '';
    },

    getAgentContexts: async (contextIds: string[]) => {
      if (!contextIds?.length) return [];
      const rows = await db.select().from(agentContexts).where(inArray(agentContexts.id, contextIds));
      return rows.map((r: any) => ({ title: r.title, content: r.content }));
    },

    getSecret: async (secretName: string, opts?: { scope?: 'app' | 'group' | 'flow' }) => {
      const scope = opts?.scope || 'app';
      const [secret] = await db.select().from(secrets).where(
        and(eq(secrets.name, secretName), eq(secrets.scope, scope))
      ).limit(1);
      if (!secret || !secret.encrypted_value || !secret.encryption_iv || !secret.encryption_tag) return null;
      return decrypt(secret.encrypted_value, secret.encryption_iv, secret.encryption_tag, secret.key_version);
    },

    getCyberArkSecret: async (variableId: string) => {
      let vaultId: string | undefined;
      if (flowGroupId) {
        const [gvc] = await db.select({ vaultId: groupVaultConfig.vault_id }).from(groupVaultConfig).where(eq(groupVaultConfig.group_id, flowGroupId)).limit(1);
        if (gvc && gvc.vaultId) vaultId = gvc.vaultId;
      }
      const vaultCondition = vaultId ? eq(secretVaults.id, vaultId) : eq(secretVaults.is_connected, true);
      const [vault] = await db.select().from(secretVaults).where(vaultCondition).limit(1);
      if (!vault) return null;
      const keyParts = vault.api_key.split(':');
      const apiKey = await decrypt(keyParts[0], keyParts[1], keyParts[2], parseInt(keyParts[3]));
      return conjurGetSecret({
        baseUrl: vault.base_url,
        account: vault.account,
        login: vault.login,
        apiKey,
        caCert: vault.ca_cert || undefined,
        selfHosted: vault.self_hosted,
      }, variableId);
    },

    setSecret: options.setSecret || ((_name: string, _value: string) => {}),
    logSecretAccess: options.logSecretAccess || (() => {}),
    searchSimilar: options.searchSimilar || (async (collectionName, queryEmbedding, topK, minScore) => {
      const store = getStore('qdrant') || getStore('pgvector') || (listStores().length > 0 ? getStore(listStores()[0]) : undefined);
      if (!store) return [];
      return store.search(collectionName, queryEmbedding, topK, minScore);
    }),
  };

  // Resolve the flow's own env vars (static / core_secret / cyberark) into the
  // sandbox environment — identical for debug runs and worker runs. Only the
  // flow's configured vars may reach the sandbox; client-supplied __env is
  // stripped by the callers before this point.
  if (Array.isArray(flow.envVars)) {
    const env: Record<string, string> = { ...sandboxEnv };
    for (const entry of flow.envVars) {
      if (entry.type === 'static' || !entry.type) {
        env[entry.name] = entry.value;
      } else if (entry.type === 'core_secret' && context.getSecret) {
        const secretValue = await context.getSecret(entry.value);
        if (secretValue) env[entry.name] = secretValue;
      } else if (entry.type === 'cyberark' && context.getCyberArkSecret) {
        const cyberArkValue = await context.getCyberArkSecret(entry.value);
        if (cyberArkValue) env[entry.name] = cyberArkValue;
      }
    }
    context.sandboxEnv = env;
  }

  return context;
}
