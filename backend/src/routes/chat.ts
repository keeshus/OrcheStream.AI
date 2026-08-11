import { Router } from 'express';
import { db } from '../db/connection.js';
import { chatSessions, chatMessages, flows, llmEndpoints, mcpServers, embeddingProviders, vectorStores, agentContexts, agentStore, groups } from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { getStore } from 'orchestream-ai-shared';

const router = Router();

// POST /api/chat/:flowId/sessions — Create a new chat session
router.post('/chat/:flowId/sessions', requirePermission('chat:create'), asyncHandler(async (req, res) => {
  const flowId = req.params.flowId as string;

  // Verify flow exists
  const [flow] = await db.select().from(flows).where(eq(flows.id, flowId));
  if (!flow) {
    res.status(404).json({ message: 'Flow not found' });
    return;
  }

  const [session] = await db.insert(chatSessions).values({
    flow_id: flowId,
    title: 'New Chat',
  }).returning();

  res.status(201).json(session);
}));

// GET /api/chat/:flowId/sessions — List sessions for a flow
router.get('/chat/:flowId/sessions', asyncHandler(async (req, res) => {
  const flowId = req.params.flowId as string;
  const result = await db.select().from(chatSessions)
    .where(eq(chatSessions.flow_id, flowId))
    .orderBy(desc(chatSessions.updated_at));
  res.json(result);
}));

// GET /api/chat/sessions/:sessionId — Get session with messages
router.get('/chat/sessions/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId as string;
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) {
    res.status(404).json({ message: 'Session not found' });
    return;
  }

  const messages = await db.select().from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(chatMessages.created_at);

  res.json({ ...session, messages });
}));

// DELETE /api/chat/sessions/:sessionId
router.delete('/chat/sessions/:sessionId', requirePermission('flow:edit'), asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId as string;
  await db.delete(chatMessages).where(eq(chatMessages.session_id, sessionId));
  await db.delete(chatSessions).where(eq(chatSessions.id, sessionId));
  res.status(204).end();
}));

// SSE POST /api/chat/sessions/:sessionId/messages — Send message + get streaming response
router.post('/chat/sessions/:sessionId/messages', requirePermission('chat:create'), asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId as string;
  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message content required' });
    return;
  }

  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) {
    res.status(404).json({ message: 'Session not found' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Fetch conversation history BEFORE saving the current message
  // to avoid the LLM seeing the same message twice (passed both as
  // part of history and as the new message field).
  const history = await db.select().from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(chatMessages.created_at);

  // Save user message
  const [userMsg] = await db.insert(chatMessages).values({
    session_id: sessionId,
    role: 'user',
    content: message,
  }).returning();

  // Emit the user message event
  res.write(`data: ${JSON.stringify({ type: 'message', data: { role: 'user', content: message, id: userMsg.id } })}\n\n`);

  // Build history messages for the executor
  const historyMessages = history.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Load and execute the flow
  const [flow] = await db.select().from(flows).where(eq(flows.id, session.flow_id));
  if (!flow) {
    res.write(`data: ${JSON.stringify({ type: 'error', data: { error: 'Flow not found' } })}\n\n`);
    res.end();
    return;
  }

  // Build execution context
  const executionContext = {
    getEndpoint: async (endpointId: string) => {
      const [endpoint] = await db.select().from(llmEndpoints).where(eq(llmEndpoints.id, endpointId));
      if (!endpoint) return null;
      if (endpoint.group_id && endpoint.group_id !== flow.group_id) return null;
      return {
        providerType: endpoint.provider_type as 'anthropic' | 'openai' | 'litellm',
        apiKey: endpoint.api_key,
        baseUrl: endpoint.base_url,
      };
    },
    getMCPServer: async (serverId: string) => {
      const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
      if (!server) return null;
      if (server.group_id && server.group_id !== flow.group_id) return null;
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
      if (ep.group_id && ep.group_id !== flow.group_id) return null;
      return { providerType: ep.provider_type, apiKey: ep.api_key, baseUrl: ep.base_url, model: ep.model };
    },
    getVectorStore: async (storeId: string) => {
      const [vs] = await db.select().from(vectorStores).where(eq(vectorStores.id, storeId));
      if (!vs) return null;
      if (vs.group_id && vs.group_id !== flow.group_id) return null;
      return { name: vs.name, url: vs.url, apiKey: vs.api_key };
    },
    flowNodes: flow.nodes as any[],
    flowEdges: flow.edges as any[],
    searchSimilar: async (collectionName: string, queryEmbedding: number[], topK: number, minScore: number) => {
      const store = getStore('qdrant') || getStore('pgvector');
      if (!store) return [];
      return store.search(collectionName, queryEmbedding, topK, minScore);
    },
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
      return rows.map(r => ({ title: r.title, content: r.content }));
    },
  };

  const { FlowExecutor } = await import('../../../worker/src/executor/engine.js');
  const executor = new FlowExecutor();

  req.on('close', () => executor.abort());

  try {
    const result = await executor.execute(
      {
        id: flow.id,
        name: flow.name,
        description: flow.description || '',
        nodes: flow.nodes as any[],
        edges: flow.edges as any[],
        version: flow.version,
        createdAt: flow.created_at?.toISOString() || '',
        updatedAt: flow.updated_at?.toISOString() || '',
        flowContext: flow.flow_context || '',
        groupId: flow.group_id || undefined,
      },
      // chat_input stays available as flow data (output-node inputFields and
      // {{input.chat_input.…}} template variables) — the engine never sends it
      // to the LLM automatically (prompt-only contract).
      { chat_input: { message, history: historyMessages }, message, history: historyMessages },
      async (nodeId, event) => {
        // Stream tool call feedback
        if (event.type === 'step.started') {
          const d = event.data as any;
          if (d.nodeType === 'mcp-tool' || d.nodeType === 'retriever') {
            res.write(`data: ${JSON.stringify({ type: 'tool_call', data: { name: d.nodeLabel || d.nodeType, input: d.input } })}\n\n`);
          }
        }
        if (event.type === 'step.completed') {
          const d = event.data as any;
          if (d.nodeType === 'mcp-tool' || d.nodeType === 'retriever') {
            res.write(`data: ${JSON.stringify({ type: 'tool_result', data: { name: d.nodeLabel || d.nodeType, output: d.output } })}\n\n`);
          }
        }
      },
      executionContext,
    );

    // Find the output node that actually produced a result (skip skipped ones)
    const outputNodes = (flow.nodes as any[]).filter((n: any) => n.data?.type === 'output');
    let outputNodeResult = null;
    for (const node of outputNodes) {
      const label = node.data?.label || '';
      const slugLabel = label.toLowerCase().replace(/[\s.]+/g, '_');
      const val = (result.output as any)?.[node.id] ?? (result.output as any)?.[slugLabel] ?? null;
      if (val !== null && val !== undefined) {
        const isSkipped = typeof val === 'object' && val !== null && val.skipped === true;
        if (!isSkipped) {
          outputNodeResult = val;
          break;
        }
      }
    }
    // Fallback to first non-skipped output
    if (!outputNodeResult && outputNodes.length > 0) {
      for (const node of outputNodes) {
        const label = node.data?.label || '';
        const slugLabel = label.toLowerCase().replace(/[\s.]+/g, '_');
        const val = (result.output as any)?.[node.id] || (result.output as any)?.[slugLabel] || null;
        if (val) { outputNodeResult = val; break; }
      }
    }
    const assistantContent = typeof outputNodeResult === 'string'
      ? outputNodeResult
      : outputNodeResult && typeof outputNodeResult === 'object'
        ? JSON.stringify(outputNodeResult)
        : String(outputNodeResult || result.output);

    const [assistantMsg] = await db.insert(chatMessages).values({
      session_id: sessionId,
      role: 'assistant',
      content: assistantContent,
    }).returning();

    // Update session title from first message
    if (history.length <= 1) {
      const title = message.slice(0, 50) + (message.length > 50 ? '...' : '');
      await db.update(chatSessions).set({ title, updated_at: new Date() }).where(eq(chatSessions.id, sessionId));
    }

    await db.update(chatSessions).set({ updated_at: new Date() }).where(eq(chatSessions.id, sessionId));

    res.write(`data: ${JSON.stringify({ type: 'done', data: { messageId: assistantMsg.id, content: assistantContent } })}\n\n`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ type: 'error', data: { error } })}\n\n`);
  }

  res.end();
}));

export default router;
