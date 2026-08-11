import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';
import { getAuthCookie } from './helpers/auth';
import { debugExecute, executeUntilPaused, pollExecution } from './helpers/stream';
import pg from 'pg';

// ── Real-LLM opt-in suite ────────────────────────────────────────────
// Runs only when a real LLM API key is available. Otherwise every test
// skips, so default CI/parallel runs are unaffected (and free).
//
// Key resolution order:
//   1. E2E_REAL_LLM_API_KEY env var
//   2. The DeepSeek key already stored in the local dev database
//      (llm_endpoints on localhost:5432) — "reuse the DeepSeek key".
//   3. No key → suite skips with a message.
//
// Run locally against the e2e stack:
//   export E2E_REAL_LLM_API_KEY="$(docker exec orchestream-ai-db psql \
//     -U orchestream_ai -d orchestream_ai -t -A -c \
//     'SELECT api_key FROM llm_endpoints LIMIT 1')"
//   npx playwright test --config test/playwright.config.ts e2e/101-real-llm.spec.ts --retries=0
//
// Override the provider via E2E_REAL_LLM_BASE_URL / E2E_REAL_LLM_MODEL.

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
const REAL_BASE_URL = process.env.E2E_REAL_LLM_BASE_URL || 'https://api.deepseek.com';
const REAL_MODEL = process.env.E2E_REAL_LLM_MODEL || 'deepseek-v4-flash';

test.setTimeout(240_000);

let resolvedKey: string | null = null;

async function readKeyFromDevDb(): Promise<string | null> {
  try {
    const client = new pg.Client({
      connectionString: 'postgres://orchestream_ai:orchestream_ai@localhost:5432/orchestream_ai',
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    const res = await client.query(
      `SELECT api_key FROM llm_endpoints WHERE base_url ILIKE '%deepseek%' ORDER BY created_at LIMIT 1`,
    );
    await client.end();
    return res.rows[0]?.api_key ?? null;
  } catch {
    return null;
  }
}

async function resolveApiKey(): Promise<string | null> {
  if (resolvedKey !== null) return resolvedKey;
  resolvedKey = process.env.E2E_REAL_LLM_API_KEY || (await readKeyFromDevDb()) || '';
  return resolvedKey;
}

test.describe('Real LLM (opt-in)', () => {
  let realEndpointId: string | null = null;
  let embeddingEndpointId: string | null = null;
  let mcpServerId: string | null = null;
  let weatherFlowId: string | null = null;
  let echoFlowId: string | null = null;
  let docId: string | null = null;
  const flowIds: string[] = [];
  const collectionName = `e2e-real-llm-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    const key = await resolveApiKey();
    if (!key) return;

    // Real LLM endpoint (DeepSeek by default)
    const epRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: 'E2E Real LLM',
        providerType: 'openai',
        baseUrl: REAL_BASE_URL,
        apiKey: key,
        defaultModel: REAL_MODEL,
        models: [REAL_MODEL],
      },
    });
    if (epRes.ok()) realEndpointId = (await epRes.json()).id;

    // Embedding endpoint backed by the mock LLM (deterministic vectors)
    const embRes = await request.post(`${API_URL}/llm-endpoints`, {
      data: {
        name: 'E2E Real Embed',
        providerType: 'openai',
        baseUrl: 'http://mock-llm-e2e:3002/v1',
        apiKey: 'mock-key',
        defaultModel: 'text-embedding-ada-002',
        models: ['text-embedding-ada-002'],
      },
    });
    if (embRes.ok()) embeddingEndpointId = (await embRes.json()).id;

    // MCP server (mock) so the LLM Agent has an MCP tool attached
    const mcpRes = await request.post(`${API_URL}/mcp-servers`, {
      data: { name: 'E2E Real MCP', url: 'http://mock-mcp-e2e:3003/sse', transport: 'sse', enabled: true },
    });
    if (mcpRes.ok()) {
      mcpServerId = (await mcpRes.json()).id;
      await request.post(`${API_URL}/mcp-servers/${mcpServerId}/refresh`).catch(() => {});
    }

    // Weather webhook flow — exposed as a Flow Tool to the LLM Agent
    if (realEndpointId) {
      const weatherRes = await createFlow(request, {
        name: 'Weather API',
        description: 'Get weather for a city',
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Webhook', type: 'trigger', config: { triggerType: 'webhook', webhookSecret: 'real-llm-secret', inputSchema: '{"type":"object","properties":{"message":{"type":"string"}}}' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Process', type: 'code', config: { code: 'return { result: `Weather in ${input.message}: sunny, 22C` };' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['process.result'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
          { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      });
      if (weatherRes.ok()) weatherFlowId = (await weatherRes.json()).id;

      // Echo flow — used by the Subflow node
      const echoRes = await createFlow(request, {
        name: uniqueFlowName('EchoFlow'),
        description: 'Echoes text back',
        nodes: [
          { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'trigger', config: { triggerType: 'manual' } } },
          { id: 'c1', type: 'code', position: { x: 300, y: 0 }, data: { label: 'Echo', type: 'code', config: { code: 'return { echo: String(input.text ?? "") };' } } },
          { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Out', type: 'output', config: { inputFields: ['echo.echo'] } } },
        ],
        edges: [
          { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
          { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        ],
      });
      if (echoRes.ok()) echoFlowId = (await echoRes.json()).id;

      // Knowledge document so the Retriever node has chunks to return
      if (embeddingEndpointId) {
        const content = 'Vector databases power retrieval augmented generation. Chunks are indexed with embeddings and matched by cosine similarity. OrcheStream stores knowledge chunks in Qdrant for semantic search.';
        const upRes = await request.post(`${API_URL}/knowledge/upload`, {
          data: { name: 'Real LLM Doc', content, collectionName, embeddingEndpointId },
        });
        if (upRes.ok()) docId = (await upRes.json()).id;
      }
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of flowIds) await deleteFlow(request, id).catch(() => {});
    if (weatherFlowId) await deleteFlow(request, weatherFlowId).catch(() => {});
    if (echoFlowId) await deleteFlow(request, echoFlowId).catch(() => {});
    if (docId) await request.delete(`${API_URL}/documents/${docId}`).catch(() => {});
    if (mcpServerId) await request.delete(`${API_URL}/mcp-servers/${mcpServerId}`).catch(() => {});
    if (embeddingEndpointId) await request.delete(`${API_URL}/llm-endpoints/${embeddingEndpointId}`).catch(() => {});
    if (realEndpointId) await request.delete(`${API_URL}/llm-endpoints/${realEndpointId}`).catch(() => {});
  });

  const cookie = getAuthCookie() || undefined;

  /**
   * Kitchen-sink flow: every node type in one pipeline.
   *
   *   Start → Prepare(code) → Assistant(llm-agent + flow-tool + mcp-tool)
   *     → Gate(condition)
   *       approve → Retriever → Enrich(code) → HTTP(mock health)
   *         → Parallel Agents(2× ai-action) → Looper(loop + code)
   *         → Subflow(echo) → Review(hitl) → Map → Output
   *       reject  → Router(switch) → Delay → Alt Output
   *   (Note node included, never executes)
   */
  function buildKitchenSinkFlow(flowName: string) {
    const flow: any = {
      name: flowName,
      description: 'All node types, real LLM',
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'c1', type: 'code', position: { x: 250, y: 0 }, data: { label: 'Prepare', type: 'code', config: { code: 'return { message: input.message, items: ["alpha", "beta", "gamma"], status: "active" };' } } },
        {
          id: 'l1', type: 'llm-agent', position: { x: 500, y: 0 },
          data: {
            label: 'Assistant', type: 'llm-agent',
            config: {
              endpointId: realEndpointId,
              model: REAL_MODEL,
              systemPrompt: 'You are a routing assistant. The message begins with either "APPROVE:" or "REJECT:" — always answer accordingly. End your reply with exactly one word: approve or reject.\n\nMessage: {{input.message}}',
              responseFormat: 'text',
              thinkingMode: 'default',
            },
          },
        },
        { id: 'b1', type: 'condition', position: { x: 800, y: 0 }, data: { label: 'Gate', type: 'condition', config: { condition: 'input.assistant.content.toLowerCase().includes("approve")' } } },
        // approve path
        { id: 'r1', type: 'retriever', position: { x: 1050, y: -150 }, data: { label: 'Retriever', type: 'retriever', config: { collectionName, topK: 3, minScore: 0 } } },
        { id: 'c2', type: 'code', position: { x: 1300, y: -150 }, data: { label: 'Enrich', type: 'code', config: { code: 'return { decision: input.assistant.content, chunks: input.retriever.count || 0 };' } } },
        { id: 'h1', type: 'http', position: { x: 1550, y: -150 }, data: { label: 'HTTP', type: 'http', config: { method: 'GET', url: 'http://mock-llm-e2e:3002/health', timeout: 10000, allowPrivate: true } } },
        { id: 'p1', type: 'parallel', position: { x: 1800, y: -150 }, data: { label: 'Parallel Agents', type: 'parallel', config: { subNodes: [
          { id: 'pa1', type: 'ai-action', position: { x: 0, y: 0 }, data: { label: 'Alpha', type: 'ai-action', config: { endpointId: realEndpointId, model: REAL_MODEL, prompt: 'Reply with the single word: ALPHA', temperature: 0.2, maxTokens: 32 } } },
          { id: 'pa2', type: 'ai-action', position: { x: 0, y: 120 }, data: { label: 'Beta', type: 'ai-action', config: { endpointId: realEndpointId, model: REAL_MODEL, prompt: 'Reply with the single word: BETA', temperature: 0.2, maxTokens: 32 } } },
        ], subEdges: [] } } },
        { id: 'lp1', type: 'loop', position: { x: 2050, y: -150 }, data: { label: 'Looper', type: 'loop', config: { itemsField: 'prepare.items', itemVariable: 'item', subNodes: [
          { id: 'ls1', type: 'code', position: { x: 0, y: 0 }, data: { label: 'Shout', type: 'code', config: { code: 'return { upper: String(input.item).toUpperCase() };' } } },
        ], subEdges: [], collectResults: true } } },
        { id: 'sf1', type: 'subflow', position: { x: 2300, y: -150 }, data: { label: 'Subflow', type: 'subflow', config: { subflowId: echoFlowId, inputMapping: { text: '{{input.prepare.message}}' } } } },
        { id: 'ht1', type: 'hitl', position: { x: 2550, y: -150 }, data: { label: 'Review', type: 'hitl', config: { prompt: 'Approve the final result?', buttons: [{ label: 'Approve', value: 'approved' }, { label: 'Reject', value: 'rejected' }] } } },
        { id: 'm1', type: 'map', position: { x: 2800, y: -150 }, data: { label: 'Map', type: 'map', config: { fields: [{ key: 'verdict', value: '{{input.assistant.content}}' }], mode: 'replace' } } },
        { id: 'o1', type: 'output', position: { x: 3050, y: -150 }, data: { label: 'Output', type: 'output', config: { inputFields: ['map.verdict', 'enrich.decision'] } } },
        // reject path (delay node lives in its own test — it pauses debug runs)
        { id: 's1', type: 'switch', position: { x: 1050, y: 150 }, data: { label: 'Router', type: 'switch', config: { fieldPath: 'prepare.status', cases: [{ value: 'active', label: 'active' }, { value: 'inactive', label: 'inactive' }] } } },
        { id: 'o2', type: 'output', position: { x: 1300, y: 150 }, data: { label: 'Alt Output', type: 'output', config: { inputFields: ['router.caseValue'] } } },
        // tools (not DAG nodes)
        { id: 'ft1', type: 'flow-tool', position: { x: 350, y: 200 }, data: { label: 'Flow Tool', type: 'flow-tool', config: { flowIds: [weatherFlowId], selectedFlows: [{ id: weatherFlowId, name: 'Weather API' }] } } },
        { id: 'mt1', type: 'mcp-tool', position: { x: 650, y: 200 }, data: { label: 'MCP Tool', type: 'mcp-tool', config: { serverId: mcpServerId, toolName: 'echo', parameters: {} } } },
        // note — never executes
        { id: 'n1', type: 'note', position: { x: 800, y: 300 }, data: { label: 'Docs', type: 'note', config: { content: 'Kitchen sink flow notes' } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'c1', targetHandle: 'input-0' },
        { id: 'e2', source: 'c1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
        { id: 'e3', source: 'l1', sourceHandle: 'output-0', target: 'b1', targetHandle: 'input-0' },
        // approve path
        { id: 'e4', source: 'b1', sourceHandle: 'output-0', target: 'r1', targetHandle: 'input-0' },
        { id: 'e5', source: 'r1', sourceHandle: 'output-0', target: 'c2', targetHandle: 'input-0' },
        { id: 'e6', source: 'c2', sourceHandle: 'output-0', target: 'h1', targetHandle: 'input-0' },
        { id: 'e7', source: 'h1', sourceHandle: 'output-0', target: 'p1', targetHandle: 'input-0' },
        { id: 'e8', source: 'p1', sourceHandle: 'output-0', target: 'lp1', targetHandle: 'input-0' },
        { id: 'e9', source: 'lp1', sourceHandle: 'output-0', target: 'sf1', targetHandle: 'input-0' },
        { id: 'e10', source: 'sf1', sourceHandle: 'output-0', target: 'ht1', targetHandle: 'input-0' },
        { id: 'e11', source: 'ht1', sourceHandle: 'output-0', target: 'm1', targetHandle: 'input-0' },
        { id: 'e12', source: 'm1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        // reject path
        { id: 'e13', source: 'b1', sourceHandle: 'output-1', target: 's1', targetHandle: 'input-0' },
        { id: 'e14', source: 's1', sourceHandle: 'output-0', target: 'o2', targetHandle: 'input-0' },
        // tool wiring
        { id: 'e16', source: 'ft1', sourceHandle: 'tool-output', target: 'l1', targetHandle: 'tool-input' },
        { id: 'e17', source: 'mt1', sourceHandle: 'tool-output', target: 'l1', targetHandle: 'tool-input' },
      ],
    };
    return flow;
  }

  test('kitchen sink: every node type executes in one flow with a real LLM', async ({ request }) => {
    test.skip(!realEndpointId, 'Real LLM endpoint not available — set E2E_REAL_LLM_API_KEY');

    const flowRes = await createFlow(request, buildKitchenSinkFlow(uniqueFlowName('KitchenSink')));
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    flowIds.push(flow.id);

    // ── Run 1: persisted, approve path (LLM says "approve") ─────────
    // Real models are non-deterministic: escalate the instruction until the
    // run pauses at the HITL node (i.e. the LLM routed to the approve path).
    const APPROVE_MESSAGES = [
      'APPROVE: A user requests read-only access to the public documentation.',
      'Approve this request: read-only access to the public documentation. Answer: approve',
      'You must approve this request. Reply with exactly the single word: approve',
    ];
    let executionId = '';
    for (const msg of APPROVE_MESSAGES) {
      try {
        const paused = await executeUntilPaused(flow.id, { message: msg }, cookie);
        executionId = paused.executionId;
        break;
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('did not pause')) throw err;
      }
    }
    expect(executionId, 'LLM should route to the approve path (HITL pause)').toBeTruthy();

    await expect
      .poll(async () => {
        const r = await request.get(`${API_URL}/executions/${executionId}`);
        return r.ok() ? (await r.json()).status : 'unavailable';
      }, { timeout: 10000 })
      .toBe('awaiting_approval');

    const approveRes = await fetch(`${API_URL}/executions/${executionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approveRes.ok).toBe(true);

    const exec = await pollExecution(request, executionId, 120000);
    expect(exec.status).toBe('completed');
    expect(exec.output).toBeDefined();

    // Every DAG node on the approve path executed (step events persisted)
    const steps = Array.isArray(exec.steps) ? exec.steps : [];
    const stepById = (id: string) => steps.find((s: any) => s.nodeId === id || s.node_id === id);
    const nodeIds = steps.map((s: any) => s.nodeId || s.node_id);
    for (const id of ['t1', 'c1', 'l1', 'b1', 'r1', 'c2', 'h1', 'p1', 'lp1', 'sf1', 'ht1', 'm1', 'o1']) {
      expect(nodeIds).toContain(id);
    }
    // Reject-path nodes must NOT have run
    for (const id of ['s1', 'o2']) {
      expect(nodeIds).not.toContain(id);
    }
    // The note node does execute (records {note: true}) — it is a no-op step
    expect(nodeIds).toContain('n1');

    // LLM output: the real model answered with "approve"
    const output = exec.output;
    expect(JSON.stringify(output)).toMatch(/approve/i);

    // Loop collected all three items (step output, keyed by node id)
    const loopStep = stepById('lp1');
    expect(loopStep?.output?.count).toBe(3);
    expect(Array.isArray(loopStep?.output?.results)).toBe(true);
    expect(loopStep?.output?.results?.length).toBe(3);

    // Retriever returned the uploaded chunk
    const enrichStep = stepById('c2');
    expect(enrichStep?.output?.chunks).toBeGreaterThan(0);

    // Parallel merged the two ai-action sub-results
    const parallelStep = stepById('p1');
    expect(JSON.stringify(parallelStep?.output ?? {})).toMatch(/ALPHA/i);
    expect(JSON.stringify(parallelStep?.output ?? {})).toMatch(/BETA/i);

    // ── Run 2: debug, reject path (LLM says "reject") ───────────────
    // Same non-determinism guard: retry with escalating instructions until the
    // reject path (switch) actually runs.
    const REJECT_MESSAGES = [
      'REJECT: A user requests deleting the production database.',
      'Reject this request: deleting the production database. Answer: reject',
      'You must reject this request. Reply with exactly the single word: reject',
    ];
    let events: Awaited<ReturnType<typeof debugExecute>> = [];
    for (const msg of REJECT_MESSAGES) {
      const attempt = await debugExecute(flow.id, { message: msg }, cookie);
      const stepIds = attempt.filter(e => e.type === 'step.completed').map((e: any) => e.data?.nodeId);
      if (stepIds.includes('s1')) {
        events = attempt;
        break;
      }
    }
    expect(events.some(e => e.type === 'step.completed' && e.data?.nodeId === 's1'),
      'LLM should route to the reject path (switch node runs)').toBe(true);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    const stepIds = events.filter(e => e.type === 'step.completed').map((e: any) => e.data?.nodeId);
    expect(stepIds).toContain('s1');
    expect(stepIds).toContain('o2');
    const switchStep = events.find(e => e.type === 'step.completed' && e.data?.nodeId === 's1');
    expect(switchStep!.data?.output?.caseValue).toBe('active');
    // Approve-path nodes must not have run on the reject path
    for (const id of ['r1', 'c2', 'h1', 'p1', 'lp1', 'sf1', 'ht1', 'm1']) {
      expect(stepIds).not.toContain(id);
    }
  });

  test('real LLM actually calls a Flow Tool and uses its result', async ({ request }) => {
    test.skip(!realEndpointId || !weatherFlowId, 'Real LLM endpoint or weather flow not available');

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('RealToolCall'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'trigger', config: { triggerType: 'manual' } } },
        {
          id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 },
          data: {
            label: 'Agent', type: 'llm-agent',
            config: {
              endpointId: realEndpointId,
              model: REAL_MODEL,
              systemPrompt: 'What is the weather in Amsterdam right now? Use the flow_weather_api tool to find out — call it with {"message": "Amsterdam"}. Reply with the weather you received and end with: DONE',
              responseFormat: 'text',
            },
          },
        },
        { id: 'ft1', type: 'flow-tool', position: { x: 150, y: 200 }, data: { label: 'Flow Tool', type: 'flow-tool', config: { flowIds: [weatherFlowId], selectedFlows: [{ id: weatherFlowId, name: 'Weather API' }] } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['agent.content'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
        { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
        { id: 'e3', source: 'ft1', sourceHandle: 'tool-output', target: 'l1', targetHandle: 'tool-input' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    flowIds.push(flow.id);

    const events = await debugExecute(flow.id, { message: 'weather' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    // The flow-tool must actually have been invoked: the engine records
    // {note: 'called by LLM Agent'} on the flow-tool node's input when a tool
    // call round executes it (present on the agent's own step input).
    const l1Started = events.find(e => e.type === 'step.started' && e.data?.nodeId === 'l1');
    expect(l1Started?.data?.input?.ft1?.note).toBe('called by LLM Agent');

    // The model had to call the tool to know the weather — the weather flow
    // echoes "sunny", and the final answer ends with DONE.
    const content = completed!.data?.output?.l1?.content || '';
    expect(content).toContain('sunny');
    expect(content).toContain('DONE');
  });

  test('real LLM returns valid JSON for structured output', async ({ request }) => {
    test.skip(!realEndpointId, 'Real LLM endpoint not available');

    const schema = JSON.stringify({
      type: 'object',
      properties: { city: { type: 'string' }, temperature: { type: 'number' } },
      required: ['city', 'temperature'],
    });

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('RealStructured'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'trigger', config: { triggerType: 'manual' } } },
        {
          id: 'l1', type: 'llm-agent', position: { x: 300, y: 0 },
          data: {
            label: 'Extractor', type: 'llm-agent',
            config: {
              endpointId: realEndpointId,
              model: REAL_MODEL,
              systemPrompt: 'Extract the city and temperature from the input. Input: "It is 22 degrees in Amsterdam today".',
              responseFormat: 'json_object',
              outputSchema: schema,
            },
          },
        },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: ['extractor.city', 'extractor.temperature'] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'l1', targetHandle: 'input-0' },
        { id: 'e2', source: 'l1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    flowIds.push(flow.id);

    const events = await debugExecute(flow.id, { message: 'extract' }, cookie);
    const completed = events.find(e => e.type === 'execution.completed');
    expect(completed).toBeDefined();

    // With json_object, the model's structured_output tool call is merged into
    // the node output (debug output is keyed by node id: 'l1').
    const extractor = completed!.data?.output?.l1 || {};
    expect(extractor.city).toBe('Amsterdam');
    expect(typeof extractor.temperature).toBe('number');
    expect(extractor.temperature).toBe(22);
  });

  test('delay node pauses a persisted run and resumes via the delayed job', async ({ request }) => {
    test.skip(!realEndpointId, 'Real LLM endpoint not available');

    const flowRes = await createFlow(request, {
      name: uniqueFlowName('RealDelay'),
      nodes: [
        { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'trigger', config: { triggerType: 'manual' } } },
        { id: 'd1', type: 'delay', position: { x: 300, y: 0 }, data: { label: 'Delay', type: 'delay', config: { type: 'fixed', seconds: 1 } } },
        { id: 'o1', type: 'output', position: { x: 600, y: 0 }, data: { label: 'Output', type: 'output', config: { inputFields: [] } } },
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'output-0', target: 'd1', targetHandle: 'input-0' },
        { id: 'e2', source: 'd1', sourceHandle: 'output-0', target: 'o1', targetHandle: 'input-0' },
      ],
    });
    expect(flowRes.ok()).toBe(true);
    const flow = await flowRes.json();
    flowIds.push(flow.id);

    const { executionId } = await executeUntilPaused(flow.id, { message: 'x' }, cookie);
    expect(executionId).toBeTruthy();

    // The delayed job resumes the persisted run automatically.
    const exec = await pollExecution(request, executionId, 30000);
    expect(exec.status).toBe('completed');
  });

  test('DeepSeek API honors the thinking params the engine sends', async ({ request }) => {
    test.skip(!realEndpointId, 'Real LLM endpoint not available');
    test.skip(!REAL_BASE_URL.includes('deepseek'), 'Thinking contract is DeepSeek-specific');

    const key = await resolveApiKey();
    test.skip(!key, 'No API key available');

    // Contract test: the exact request shapes emitted by the deepseek
    // thinking strategy must be honored by the real API.
    async function complete(body: any) {
      const res = await fetch(`${REAL_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      expect(res.ok).toBe(true);
      return (await res.json()).choices[0].message;
    }

    // thinking disabled → no chain of thought in the response
    const disabled = await complete({
      model: REAL_MODEL,
      messages: [{ role: 'user', content: 'Say hi in one word' }],
      temperature: 0.7,
      thinking: { type: 'disabled' },
    });
    expect(disabled.reasoning_content).toBeUndefined();
    expect(disabled.content).toBeTruthy();

    // thinking enabled + xhigh effort → chain of thought is present
    const enabled = await complete({
      model: REAL_MODEL,
      messages: [{ role: 'user', content: 'Say hi in one word' }],
      temperature: 0.7,
      thinking: { type: 'enabled' },
      reasoning_effort: 'xhigh',
    });
    expect(enabled.reasoning_content).toBeTruthy();
  });
});
