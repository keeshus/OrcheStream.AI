import type {
  FlowDefinition,
  FlowNode,
  FlowEdge,
  SSEEvent,
  ExecutionStep,
  NodeData,
  ConditionNodeData,
} from 'orchestream-ai-shared';
import { topologicalSort } from './dag.js';
import { callLLM, type ResolvedEndpoint } from '../providers/index.js';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BASH_SANDBOX_SYSTEM_PROMPT, BASH_TOOL_DEFINITION } from '../tools/bash.js';
import { sanitizeUntrustedKeys } from '../tools/sanitize.js';

const slugify = (s: string) =>
  s.toLowerCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 64);

const HTTP_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
const HTTP_MAX_REDIRECTS = 5;

// How often the llm-agent tool loop asks the LLM for a status check.
// The loop itself is unbounded — it ends only when the LLM stops calling
// tools or the run is aborted.
const TOOL_LOOP_CHECK_INTERVAL = 5;

// When a provider response is truncated by the output token limit
// (finish_reason 'length'), ask the model to continue. Guarded so a model
// that keeps truncating cannot spin the loop forever.
const MAX_TRUNCATED_CONTINUATIONS = 3;

// When the conversation exceeds the provider's context window, drop the
// oldest tool rounds and retry. Guarded the same way as truncation.
const MAX_CONVERSATION_TRIMS = 3;

// User turn sent to LLM Agents. The engine NEVER derives user content from
// flow input — the system prompt (with {{input.…}} variables) is the only
// channel for input. Some providers (e.g. Anthropic) require an alternating
// user turn, so a fixed neutral placeholder is sent instead of nothing.
const LLM_AGENT_NO_MESSAGE_PLACEHOLDER = 'Proceed.';

// Matches provider context-window overflow errors (OpenAI/DeepSeek/Anthropic).
const CONTEXT_OVERFLOW_PATTERN = /context length|context_length|context window|maximum.*context|token.*exceed|exceed.*token|too long|prompt is too large|request too large|context_limit/i;

/** True when the error message indicates the conversation exceeded the model's context window. */
function isContextOverflowError(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(message);
}

/**
 * Best-effort conversation compaction for context overflow: keep the initial
 * messages (system prompt + user request) and the most recent rounds, drop the
 * middle tool rounds. Returns true if anything was removed.
 */
function trimConversation(conversation: Array<{ role: string; content: string }>, keepInitial: number, keepRecent: number): boolean {
  if (conversation.length <= keepInitial + keepRecent) return false;
  const head = conversation.slice(0, keepInitial);
  const tail = conversation.slice(conversation.length - keepRecent);
  conversation.splice(0, conversation.length, ...head, ...tail);
  return true;
}

// Cap on items a single loop node may iterate — override via MAX_LOOP_ITEMS env
const MAX_LOOP_ITEMS = (() => {
  const raw = parseInt(process.env.MAX_LOOP_ITEMS ?? '1000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class HitlPauseError extends Error {
  public nodeId: string;
  public savedOutputs: Record<string, unknown>;
  public buttons: Array<{ label: string; value: string; icon?: string }>;
  public prompt: string;
  public assignmentType?: string;
  public assignees?: { userIds: string[]; roleIds: string[]; groupIds?: string[] };
  public requiredApprovals?: number;
  public assignedGroupId?: string;
  public assignedUserId?: string;
  public assignedRoleId?: string;
  constructor(nodeId: string, savedOutputs: Record<string, unknown>, buttons?: Array<{ label: string; value: string; icon?: string }>, prompt?: string, assignmentType?: string, assignees?: { userIds: string[]; roleIds: string[]; groupIds?: string[] }, requiredApprovals?: number, assignedGroupId?: string, assignedUserId?: string, assignedRoleId?: string) {
    super(`HITL: waiting for human input at node ${nodeId}`);
    this.name = 'HitlPauseError';
    this.nodeId = nodeId;
    this.savedOutputs = savedOutputs;
    this.buttons = buttons || [{ label: 'Approve', value: 'approved', icon: 'check_circle' }, { label: 'Reject', value: 'rejected', icon: 'cancel' }];
    this.prompt = prompt || '';
    this.assignmentType = assignmentType;
    this.assignees = assignees;
    this.requiredApprovals = requiredApprovals;
    this.assignedGroupId = assignedGroupId;
    this.assignedUserId = assignedUserId;
    this.assignedRoleId = assignedRoleId;
  }
}

export class PauseExecutionError extends Error {
  public nodeId: string;
  public savedOutputs: Record<string, unknown>;
  public resumeDelay: number;
  constructor(nodeId: string, savedOutputs: Record<string, unknown>, resumeDelay: number) {
    super(`Paused: waiting for delay at node ${nodeId}`);
    this.name = 'PauseExecutionError';
    this.nodeId = nodeId;
    this.savedOutputs = savedOutputs;
    this.resumeDelay = resumeDelay;
  }
}

export class FlowStopError extends Error {
  public nodeId: string;
  public status: string;
  constructor(nodeId: string, message?: string, status?: string) {
    super(message || 'Execution stopped');
    this.name = 'FlowStopError';
    this.nodeId = nodeId;
    this.status = status || 'cancelled';
  }
}

export type EventCallback = (nodeId: string, event: SSEEvent) => void | Promise<void>;

// True when the IP is private/loopback/link-local/unspecified/reserved — SSRF must never reach these
function isPrivateOrRestrictedIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded IPv4
  if (lower.startsWith('::ffff:')) {
    const embedded = lower.slice(7);
    if (embedded.includes('.')) return isPrivateOrRestrictedIp(embedded);
  }
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                          // 0.0.0.0/8 unspecified
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                         // multicast + reserved
    return false;
  }
  if (isIP(ip) === 6) {
    if (lower === '::' || lower === '::1') return true;          // unspecified / loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('ff')) return true;                     // multicast
    if (lower.startsWith('2001:db8')) return true;               // documentation range
    if (lower.startsWith('64:ff9b') || lower.startsWith('64:ff9b:1')) return true; // NAT64 well-known
    return false;
  }
  return true; // not parseable as an IP — reject
}

// Validate scheme and resolved IPs for every request/redirect hop.
// Private/restricted destinations are blocked unless the flow explicitly opts in.
// Returns the validated, pinned addresses so the caller can connect to the
// resolved IP instead of re-resolving DNS (closes the TOCTOU/DNS-rebinding
// window between validation and connect).
async function assertSafeFetchUrl(rawUrl: string, allowPrivate: boolean): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('HTTP Request node: invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`HTTP Request node: unsupported protocol "${parsed.protocol}" — only http and https are allowed`);
  }
  const hostname = parsed.hostname;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`HTTP Request node: DNS resolution failed for "${hostname}"`);
  }
  if (!allowPrivate) {
    for (const addr of addresses) {
      if (isPrivateOrRestrictedIp(addr.address)) {
        throw new Error(`HTTP Request node: destination "${hostname}" resolves to a private or restricted address — blocked (set allowPrivate to reach internal services)`);
      }
    }
  }
  return { url: parsed, addresses };
}

// Read the response body with a hard size cap
async function readResponseBodyCapped(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > HTTP_RESPONSE_MAX_BYTES) {
      throw new Error('HTTP Request node: response body exceeds the 10 MB limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Database lookups the executor needs at runtime
export interface ExecutionContext {
  getEndpoint?: (endpointId: string) => Promise<ResolvedEndpoint | null>;
  getMCPServer?: (serverId: string) => Promise<any>;
  getEmbeddingProvider?: (providerId: string) => Promise<{ providerType: string; apiKey: string; baseUrl: string | null; model: string } | null>;
  getVectorStore?: (storeId: string) => Promise<{ name: string; url: string; apiKey: string | null } | null>;
  searchSimilar?: (collectionName: string, queryEmbedding: number[], topK: number, minScore: number) => Promise<Array<{ documentId: string; chunkText: string; chunkIndex: number; similarity: number }>>;
  getGlobalContext?: () => Promise<string>;
  getGroupContext?: (groupId: string) => Promise<string>;
  getAgentContexts?: (contextIds: string[]) => Promise<Array<{ title: string; content: string }>>;
  flowNodes?: Array<{ id: string; type: string; data: any }>;
  flowEdges?: Array<{ id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
  getFlow?: (flowId: string, ancestry?: string[]) => Promise<FlowDefinition | null>;
  onSubExecution?: (data: { parentExecutionId: string; subflowNodeId: string; subflowId: string; input: Record<string, unknown>; depth: number; path: string }) => Promise<string>;
  completeSubExecution?: (subExecutionId: string, output: Record<string, unknown>, status: 'completed' | 'failed', error?: string) => Promise<void>;
  currentExecutionId?: string;
  currentDepth?: number;
  getSecret?: (secretName: string, options?: { scope?: 'app' | 'group' | 'flow' }) => Promise<string | null>;
  getCyberArkSecret?: (secretPath: string) => Promise<string | null>;
  setSecret?: (name: string, value: string) => void;
  logSecretAccess?: (entry: { name: string; action: string; source: string }) => void;
  sandboxEnv?: Record<string, string>;  // env vars for the sandbox (merged from secrets, CyberArk)
  sandboxExecutionId?: string;          // execution ID for sandbox communication
}

/**
 * Assemble the final injected LLM Agent system prompt: layered contexts
 * (global → group → flow → agent contexts → node prompt with templates
 * resolved) plus the sandbox environment notes and structured-output
 * instruction. Shared between the actual LLM call and the step record so
 * debug runs and run history show exactly what was sent.
 */
async function buildInjectedPrompt(
  config: any,
  input: Record<string, unknown>,
  flow: FlowDefinition | undefined,
  context: ExecutionContext,
): Promise<string> {
  const contextLayers: string[] = [];

  // 1. Global context
  if (context.getGlobalContext) {
    const globalCtx = await context.getGlobalContext();
    if (globalCtx) contextLayers.push(globalCtx);
  }

  // 2. Group context (from flow's group_id)
  if (context.getGroupContext && flow?.groupId) {
    const groupCtx = await context.getGroupContext(flow.groupId);
    if (groupCtx) contextLayers.push(groupCtx);
  }

  // 3. Flow context
  if (flow?.flowContext) {
    contextLayers.push(flow.flowContext);
  }

  // 4. Selected agent contexts
  const contextIds = config?.contextIds as string[] | undefined;
  if (context.getAgentContexts && contextIds?.length) {
    const agentCtxs = await context.getAgentContexts(contextIds);
    for (const ac of agentCtxs) {
      if (ac.content) contextLayers.push(`${ac.title}:\n${ac.content}`);
    }
  }

  // 5. Node system prompt (with template + secret resolution)
  const resolvedNodePrompt = await resolveTemplate(config.systemPrompt || '', input, context);
  if (resolvedNodePrompt) contextLayers.push(resolvedNodePrompt);

  let resolvedPrompt = contextLayers.join('\n\n---\n\n');

  // Append sandbox environment info — the bash tool is always injected
  resolvedPrompt += (resolvedPrompt ? '\n\n' : '') + BASH_SANDBOX_SYSTEM_PROMPT;

  // Tell the LLM to use the structured_output tool when JSON output is selected
  if (config.responseFormat === 'json_object') {
    resolvedPrompt += (resolvedPrompt ? '\n\n' : '') + 'You must use the structured_output tool to respond — call it with your structured data. Do not output plain text.';
  }

  return resolvedPrompt;
}

export class FlowExecutor {
  private abortController: AbortController;
  private currentRunId = '';
  private currentOptions?: { replayFrom?: string; replayOutputs?: Record<string, unknown>; inputOverride?: Record<string, unknown>; initialIteration?: number };

  constructor(abortController?: AbortController) {
    this.abortController = abortController ?? new AbortController();
  }

  abort() {
    this.abortController.abort();
  }

  async execute(
    flow: FlowDefinition,
    input: Record<string, unknown>,
    onEvent: EventCallback,
    context: ExecutionContext,
    options?: { replayFrom?: string; replayOutputs?: Record<string, unknown>; inputOverride?: Record<string, unknown>; initialIteration?: number },
  ): Promise<{ output: Record<string, unknown>; steps: ExecutionStep[] }> {
    const runId = randomUUID();
    this.currentRunId = runId;
    this.currentOptions = options;
    const { sorted, cycles } = topologicalSort(flow.nodes, flow.edges);

    if (cycles.length > 0) {
      console.warn(`Flow contains feedback loops (cycles): ${JSON.stringify(cycles)}`);
    }


    // Untrusted parsed JSON (webhook/chat bodies) may contain __proto__/constructor/prototype keys —
    // strip them before any merge or template resolution
    const sanitizedFlowInput = sanitizeUntrustedKeys(options?.inputOverride || input) as Record<string, unknown>;

    // Validate the flow before execution — catch schema/template issues early
    // Skip validation when there are cycles (feedback loops) — cycle ordering is undefined
    const validationErrors = cycles.length > 0 ? [] : this.compileFlow(sorted, flow.edges, sanitizedFlowInput);
    if (validationErrors.length > 0) {
      throw new Error(`Flow compilation failed:\n${validationErrors.join('\n')}`);
    }

    const nodeOutputs = new Map<string, unknown>();
    nodeOutputs.set('__input__', sanitizedFlowInput);

    // If replaying: pre-load saved outputs from previous run, skip nodes before HITL
    const replayFrom = options?.replayFrom;
    const replayOutputs = options?.replayOutputs || {};
    let beforeHitl = !!replayFrom;

    const steps: ExecutionStep[] = [];

    const currentIteration = options?.initialIteration ?? 0;
    let feedbackLoopCount = 0;
    const MAX_FEEDBACK_ITERS = 10;

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];
      if (this.abortController.signal.aborted) break;

      // Skip nodes before the HITL node when replaying
      if (beforeHitl) {
        if (node.id === replayFrom) {
          beforeHitl = false;
        } else if (replayOutputs[node.id] !== undefined) {
          nodeOutputs.set(node.id, replayOutputs[node.id]);
          const labelKey = slugify(node.data.label || node.id);
          nodeOutputs.set(labelKey, replayOutputs[node.id]);
          continue; // skip already-completed nodes
        }
      }

      // Skip MCP Tool / Retriever / Flow Tool nodes — they only run when called by an LLM Agent
      if (node.data.type === 'mcp-tool' || node.data.type === 'retriever' || node.data.type === 'flow-tool') {
        // Only skip if this node is connected to an LLM Agent's tool-input
        const outgoingEdges = flow.edges.filter(e => e.source === node.id);
        const isToolProvider = outgoingEdges.some(e => e.sourceHandle === 'tool-output' || e.targetHandle?.startsWith('tool-input'));
        if (isToolProvider) {
          nodeOutputs.set(node.id, { note: 'called by LLM Agent' });
          continue;
        }
      }

      // Check if this node should be skipped based on incoming edge conditions or sourceHandle
      const incomingEdges = flow.edges.filter(e => e.target === node.id);
      if (incomingEdges.length > 0) {
        const sourceOutputs = incomingEdges.map(e => {
          // Try by node ID first, then by label — outputs are stored under label key
          const byId = nodeOutputs.get(e.source);
          if (byId !== undefined) return byId;
          const srcNode = flow.nodes.find(n => n.id === e.source);
          if (srcNode) {
            const labelKey = slugify(srcNode.data?.label || srcNode.id);
            return nodeOutputs.get(labelKey);
          }
          return undefined;
        });
        const allFiltered = incomingEdges.every((e, i) => {
          const src = sourceOutputs[i] as Record<string, unknown> | undefined;

          // Propagate skipped status: if the source node was skipped, skip downstream nodes too
          if ((src as any)?.skipped === true) {
            return true;
          }

          // Check explicit edge condition (branch nodes, HITL edges with conditions)
          if (e.condition?.label) {
            const routeLabel = (src as any)?.label ?? (src as any)?.decision;
            if (routeLabel !== e.condition.label) return true;
          }

          // For branch/HITL sources without explicit conditions, filter by sourceHandle
          // Branch nodes route by comparing the matched label against outputLabels[index].
          // HITL nodes have dynamic output handles per button — if the decision
          // doesn't match the button at the sourceHandle index, filter this edge.
          if (!e.condition?.label && e.sourceHandle) {
            const sourceNode = flow.nodes.find(n => n.id === e.source);
            if (sourceNode && (sourceNode.data as any)?.type === 'condition') {
              const labels: string[] = (sourceNode.data as any).config?.outputLabels || ['true', 'false'];
              const handleIndex = parseInt((e.sourceHandle as string).replace('output-', ''), 10);
              const matchedLabel = (src as any)?.label;
              if (matchedLabel) {
                if (labels[handleIndex]?.toLowerCase() === matchedLabel.toLowerCase()) {
                  return false;
                }
                return true;
              }
              // No matched label — fall back to truthy/falsy routing
              const verdict = (src as any)?.verdict;
              if (handleIndex === 0) return !verdict;
              if (handleIndex === 1) return !!verdict;
            }
            if (sourceNode && (sourceNode.data as any)?.type === 'switch') {
              const handleIndex = parseInt((e.sourceHandle as string).replace('output-', ''), 10);
              const caseIndex = (src as any)?.caseIndex;
              if (caseIndex !== undefined) {
                return handleIndex !== caseIndex;
              }
              return true;
            }
            if (sourceNode && (sourceNode.data as any)?.type === 'hitl') {
              const buttons: Array<{ value: string }> = (sourceNode.data as any).config?.buttons || [];
              const handleIndex = parseInt((e.sourceHandle as string).replace('output-', ''), 10);
              const decision = (src as any)?.decision;
              // Max iterations exit handle (index >= buttons.length): only follow if max iterations reached
              if (handleIndex >= buttons.length) {
                if (decision !== 'max_iterations') return true;
              } else {
                const buttonValue = buttons[handleIndex]?.value;
                if (buttonValue && decision && buttonValue !== decision) return true;
              }
            }
          }

          return false;
        });

        if (allFiltered) {
          // Propagated skip: upstream node was skipped, so skip this one too
          if (incomingEdges.some((e, i) => (sourceOutputs[i] as any)?.skipped === true)) {
            nodeOutputs.set(node.id, { skipped: true, reason: 'Upstream skipped' });
            onEvent(node.id, {
              type: 'step.skipped',
              executionId: '',
              nodeId: node.id,
              data: { nodeId: node.id, nodeType: node.data.type, nodeLabel: node.data.label || node.data.type, reason: 'Upstream skipped', iteration: currentIteration },
              timestamp: new Date().toISOString(),
            });
            continue;
          }
          if (incomingEdges.some(e => e.condition?.label || e.sourceHandle)) {
            // Check if an upstream branch node has a default path configured
            const defaultEdge = incomingEdges.find(e => {
              if (!e.sourceHandle) return false;
              const sNode = flow.nodes.find(n => n.id === e.source);
              if (!sNode || (sNode.data as any)?.type !== 'condition') return false;
              const cfg = (sNode.data as any).config || {};
              if (!cfg.defaultPath) return false;
              const labels: string[] = cfg.outputLabels || [];
              const handleIdx = parseInt(e.sourceHandle.replace('output-', ''), 10);
              return labels[handleIdx] === cfg.defaultPath;
            });
            if (defaultEdge) {
              // Default path matched — continue processing instead of skipping
            } else {
              nodeOutputs.set(node.id, { skipped: true, reason: 'No matching route' });
              onEvent(node.id, {
                type: 'step.skipped',
                executionId: '',
                nodeId: node.id,
                data: { nodeId: node.id, nodeType: node.data.type, nodeLabel: node.data.label || node.data.type, reason: 'No matching route', iteration: currentIteration },
                timestamp: new Date().toISOString(),
              });
              continue;
            }
          }
          // All edges have no conditions/sourceHandles — misconfigured flow
          throw new Error(
            `Node "${node.data.label || node.id}" has ${incomingEdges.length} incoming edges from a branch/HITL node, but none have routing conditions set. ` +
            `Connect each edge to a specific output handle on the source node.`
          );
        }
      }

      const stepInput = this.prepareInput(node, flow.edges, nodeOutputs);

      // If node is output type and has inputFields set, filter stepInput to only those fields
      // Non-output nodes always receive all data — templates give full control over what's used
      const nodeConfig = (node.data as any)?.config || {};
      const inputFields = nodeConfig.inputFields as string[] | undefined;
      const filteredInput = (node.data.type === 'output') && inputFields && inputFields.length > 0 && stepInput && typeof stepInput === 'object'
        ? (() => {
            const result: Record<string, unknown> = {};
            const input = stepInput as Record<string, unknown>;
            for (const path of inputFields) {
              const dot = path.indexOf('.');
              if (dot === -1) {
                // Whole label: slugify to match stored output keys
                const slugKey = slugify(path);
                if (input[slugKey] !== undefined) result[slugKey] = input[slugKey];
              } else {
                // Dot-path: slugify the label part
                const rawLabel = path.slice(0, dot);
                const field = path.slice(dot + 1);
                const slugLabel = slugify(rawLabel);
                const labelData = input[slugLabel] as Record<string, unknown> | undefined;
                if (labelData && field in labelData) {
                  if (!result[slugLabel]) result[slugLabel] = {};
                  (result[slugLabel] as Record<string, unknown>)[field] = labelData[field];
                }
              }
            }
            return result;
          })()
        : stepInput;

      // Enrich step input with node config for debugging (LLM prompt, model, etc.)
      const enrichedInput: Record<string, unknown> = {
        ...(filteredInput as Record<string, unknown> || {}),
        _nodeType: node.data.type,
        _nodeLabel: node.data.label || node.data.type,
        _rawInput: filteredInput !== stepInput ? stepInput : undefined,
      };
      if (node.data.type === 'llm-agent') {
        const cfg = (node.data as any).config || {};
        if (cfg.model) enrichedInput.model = cfg.model;
        if (cfg.temperature !== undefined) enrichedInput.temperature = cfg.temperature;
        // Record the fully injected prompt (context layers + resolved
        // templates + sandbox notes) so debug/history shows what was sent.
        try {
          enrichedInput.systemPrompt = await buildInjectedPrompt(cfg, filteredInput as Record<string, unknown>, flow, context);
        } catch {
          if (cfg.systemPrompt) enrichedInput.systemPrompt = cfg.systemPrompt;
        }
      }

      if (node.data.type === 'ai-action') {
        const cfg = (node.data as any).config || {};
        try {
          enrichedInput.prompt = await resolveTemplate(cfg.prompt || '', filteredInput, context);
        } catch {
          if (cfg.prompt) enrichedInput.prompt = cfg.prompt;
        }
      }

      if (node.data.type === 'condition') {
        const cfg = (node.data as any).config || {};
        if (cfg.condition) enrichedInput.condition = cfg.condition;
      }

      await onEvent(node.id, {
        type: 'step.started',
        executionId: '',
        nodeId: node.id,
        data: { nodeId: node.id, nodeType: node.data.type, nodeLabel: node.data.label || node.data.type, input: enrichedInput, iteration: currentIteration },
        timestamp: new Date().toISOString(),
      });

      try {
        // For HITL replay: separate what was displayed vs what gets forwarded
        let nodeInput = filteredInput;
        if ((node.data as any).type === 'hitl' && replayFrom && node.id === replayFrom) {
          const cfg = (node.data as any)?.config || {};
          const displayFields: string[] = cfg.displayFields || [];
          const forwardFields: string[] = cfg.forwardFields || [];
          const raw = stepInput as Record<string, unknown> | undefined || {};
          const displayed: Record<string, unknown> = {};
          const forwarded: Record<string, unknown> = {};
          if (displayFields.length > 0) {
            for (const f of displayFields) { if (raw[f] !== undefined) displayed[f] = raw[f]; }
          } else { Object.assign(displayed, raw); }
          if (forwardFields.length > 0) {
            for (const f of forwardFields) { if (raw[f] !== undefined) forwarded[f] = raw[f]; }
          } else { Object.assign(forwarded, raw); }
          // Store displayed for UI, pass forwarded to next node
          nodeInput = { ...(filteredInput as any), _reviewedContent: forwarded };
        }
        const output = await this.executeNode(node, nodeInput, context, onEvent, flow);
        // Strip internal metadata from downstream output — only actual content flows between nodes
        const cleanOutput = output && typeof output === 'object' && !Array.isArray(output)
          ? Object.fromEntries(
              Object.entries(output as Record<string, unknown>).filter(
                ([k]) => !k.startsWith('_') && k !== 'toolCalls' && k !== '_reviewedContent'
              )
            )
          : output;
        const outputKey = slugify(node.data.label || node.id);
        nodeOutputs.set(outputKey, cleanOutput);
        nodeOutputs.set(node.id, cleanOutput);

        await onEvent(node.id, {
          type: 'step.completed',
          executionId: '',
          nodeId: node.id,
          data: { nodeId: node.id, nodeType: node.data.type, nodeLabel: node.data.label, output: output as Record<string, unknown>, iteration: currentIteration },
          timestamp: new Date().toISOString(),
        });

        steps.push({
          id: '',
          executionId: '',
          nodeId: node.id,
          nodeType: node.data.type,
          status: 'completed',
          input: stepInput as Record<string, unknown>,
          output: output as Record<string, unknown>,
          error: null,
          startedAt: null,
          completedAt: null,
        });

        // ── Feedback loop detection ──────────────────────────────────────────
        if ((node.data as any)?.type === 'hitl') {
          const hitlOutput = output as Record<string, unknown> | undefined;
          const decision = hitlOutput?.decision as string | undefined;
          if (decision) {
            const hitlConfig = (node.data as any)?.config || {};
            const buttons: Array<{ value: string }> = hitlConfig.buttons || [];
            for (const edge of flow.edges.filter(e => e.source === node.id)) {
              const handleIdx = parseInt((edge.sourceHandle || 'output-0').replace('output-', ''), 10);
              const buttonValue = buttons[handleIdx]?.value;
              const targetIdx = sorted.findIndex(n => n.id === edge.target);

              if (targetIdx >= 0 && targetIdx < i) {
                if (decision === buttonValue) {
                  // This is a feedback edge — re-execute from target. The
                  // iteration counter travels across replays via
                  // initialIteration (backend sets it from _nextIteration), so
                  // maxIterations is evaluated against the accumulated count.
                  // With maxIterations = N, iterations 0..N-1 may re-enter the
                  // feedback loop; iteration N exits via max_iterations.
                  const isMaxIter = hitlConfig.maxIterations > 0 && currentIteration >= hitlConfig.maxIterations;
                  if (isMaxIter) {
                    nodeOutputs.set(node.id, { decision: 'max_iterations', feedback: hitlOutput?.feedback || '', _iterationCount: currentIteration });
                    nodeOutputs.set(slugify(node.data?.label || node.id), { decision: 'max_iterations', feedback: hitlOutput?.feedback || '', _iterationCount: currentIteration });
                    break;
                  }

                  feedbackLoopCount++;
                  if (feedbackLoopCount >= MAX_FEEDBACK_ITERS) break;

                  for (let r = targetIdx; r < i; r++) {
                    const resetNode = sorted[r];
                    nodeOutputs.delete(resetNode.id);
                    nodeOutputs.delete(slugify(resetNode.data?.label || resetNode.id));
                  }

                  const flowInput = nodeOutputs.get('__input__') as Record<string, unknown> || {};
                  const prevFeedback = hitlOutput?.feedback || '';
                  delete flowInput._approved;
                  delete flowInput._decision;
                  delete flowInput._feedback;

                  flowInput._iterationCount = currentIteration;
                  flowInput._feedback = prevFeedback;
                  nodeOutputs.set('_lastFeedback', prevFeedback);

                  i = targetIdx - 1;
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        // If node is paused (HITL or delay), populate saved outputs before re-throwing
        if (err instanceof PauseExecutionError || err instanceof HitlPauseError) {
          const saved: Record<string, unknown> = {};
          for (const [k, v] of nodeOutputs) {
            if (k !== '__input__' && flow.nodes.some(n => n.id === k)) saved[k] = v;
          }
          // Preserve subflow-internal outputs under the subflow label prefix so a
          // replay can resume inside the child without re-running it. The child's
          // own saved outputs (keyed by child node ids) are namespaced under the
          // subflow's prefix, matching the hierarchical pause node id.
          if (node.data?.type === 'subflow' && err.savedOutputs) {
            const subLabel = slugify(node.data.label || node.id);
            for (const [k, v] of Object.entries(err.savedOutputs)) {
              if (v !== undefined && !(k in saved)) saved[`${subLabel}:${k}`] = v;
            }
          }
          if (err instanceof PauseExecutionError) {
            throw new PauseExecutionError(err.nodeId, saved, err.resumeDelay);
          }
          const hitlConfig = (node.data as any)?.config || {};
          throw new HitlPauseError(err.nodeId, saved, err.buttons || hitlConfig.buttons, err.prompt, err.assignmentType, err.assignees, err.requiredApprovals, err.assignedGroupId, err.assignedUserId, err.assignedRoleId);
        }
        const error = err instanceof Error ? err.message : String(err);
        await onEvent(node.id, {
          type: 'step.failed',
          executionId: '',
          nodeId: node.id,
          data: { nodeId: node.id, nodeType: node.data.type, nodeLabel: node.data.label, error, iteration: currentIteration },
          timestamp: new Date().toISOString(),
        });

        steps.push({
          id: '',
          executionId: '',
          nodeId: node.id,
          nodeType: node.data.type,
          status: 'failed',
          input: stepInput as Record<string, unknown>,
          output: null,
          error,
          startedAt: null,
          completedAt: null,
        });
        throw err; // Stop execution on failure
      }
    }

    // Deduplicate: only include ID-keyed entries (labels are secondary keys)
    const nodeIds = new Set(flow.nodes.map(n => n.id));
    const uniqueOutput = Object.fromEntries(
      [...nodeOutputs].filter(([k]) => k === '__input__' || nodeIds.has(k))
    );
    return { output: uniqueOutput, steps };
  }

  compileFlow(sorted: FlowNode[], edges: FlowEdge[], flowInput?: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const computeSlug = (n: FlowNode) => slugify(n.data?.label || n.id);

    // Validate subflow trigger requires an output node
    const hasSubflowTrigger = sorted.some(n => n.data.type === 'trigger' && (n.data as any).config?.triggerType === 'subflow');
    const hasOutputNode = sorted.some(n => n.data.type === 'output');
    if (hasSubflowTrigger && !hasOutputNode) {
      errors.push('Subflow: requires an Output node');
    }

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];
      const config = (node.data as any)?.config || {};

      // Collect upstream slugs (nodes before this one in topological order)
      const upstreamSlugs = new Set<string>();
      for (let j = 0; j < i; j++) {
        upstreamSlugs.add(computeSlug(sorted[j]));
      }

      // Validate inputFields: check that path references an upstream slug OR a flow input key
      // Only relevant for output nodes — other nodes pass all data through
      const inputFields: string[] = node.data.type === 'output' ? (config.inputFields || []) : [];
      for (const field of inputFields) {
        const dot = field.indexOf('.');
        const rawLabel = dot === -1 ? field : field.slice(0, dot);
        const slugLabel = slugify(rawLabel);
        const isUpstreamNode = upstreamSlugs.has(slugLabel);
        const isFlowInputKey = flowInput ? rawLabel in flowInput : false;
        if (!isUpstreamNode && !isFlowInputKey && slugLabel !== '__input__') {
          errors.push(`Node "${node.data?.label || node.id}": input field "${field}" references "${rawLabel}" which is not an upstream node nor a flow input key. Available upstream: ${Array.from(upstreamSlugs).join(', ') || '(none)'}`);
        }
      }

      // Validate template variables in code/condition/systemPrompt
      const templates: string[] = [];
      if (config.code) templates.push(config.code);
      if (config.condition) templates.push(config.condition);
      if (config.systemPrompt) templates.push(config.systemPrompt);
      for (const tpl of templates) {
        const regex = /\{\{input\.([^}]+)\}\}/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(tpl)) !== null) {
          const path = match[1].trim();
          const label = path.split('.')[0];
          const slugLabel = slugify(label);
          const isUpstreamNode = upstreamSlugs.has(slugLabel);
          const isFlowInputKey = flowInput ? label in flowInput : false;
          if (!isUpstreamNode && !isFlowInputKey && slugLabel !== '__input__') {
            errors.push(`Node "${node.data?.label || node.id}": template "{{input.${path}}}" references "${label}" which is not an upstream node nor a flow input key. Available upstream: ${Array.from(upstreamSlugs).join(', ') || '(none)'}`);
          }
        }
      }

      // Validate subflow nodes
      if (node.data.type === 'subflow') {
        const subflowConfig = (node.data as any).config || {};
        const subflowId = subflowConfig.subflowId;

        if (!subflowId) {
          errors.push(`Node "${node.data?.label || node.id}": no subflow selected`);
          continue;
        }

        // Check input mapping references real upstream nodes
        const inputMapping = subflowConfig.inputMapping || {};
        for (const [paramName, template] of Object.entries(inputMapping)) {
          if (typeof template === 'string' && template.includes('{{')) {
            const regex = /\{\{input\.([^}]+)\}\}/g;
            let match;
            while ((match = regex.exec(template)) !== null) {
              const path = match[1].trim();
              const label = path.split('.')[0];
              const slugLabel = slugify(label);
              const isUpstreamNode = upstreamSlugs.has(slugLabel);
              const isFlowInputKey = flowInput ? label in flowInput : false;
              if (!isUpstreamNode && !isFlowInputKey && slugLabel !== '__input__') {
                errors.push(`Node "${node.data?.label || node.id}": subflow input mapping "${paramName}" references "${label}" which is not an upstream node nor a flow input key. Available upstream: ${Array.from(upstreamSlugs).join(', ') || '(none)'}`);
              }
            }
          }
        }
      }
    }

    return errors;
  }

  private prepareInput(node: FlowNode, edges: FlowEdge[], nodeOutputs: Map<string, unknown>): unknown {
    const accumulated: Record<string, unknown> = {};
    // First, spread __input__ fields so flags like _approved are accessible
    const flowInput = nodeOutputs.get('__input__') as Record<string, unknown> | undefined;
    if (flowInput && typeof flowInput === 'object') {
      Object.assign(accumulated, sanitizeUntrustedKeys(flowInput));
    }
    // Then add all node outputs (overwrite __input__ keys with same name)
    for (const [key, value] of nodeOutputs) {
      if (key !== '__input__') {
        accumulated[key] = value;
      }
    }
    return accumulated;
  }

  private async executeNode(
    node: FlowNode,
    input: unknown,
    context: ExecutionContext,
    onEvent: EventCallback,
    flow?: FlowDefinition,
  ): Promise<unknown> {
    const nodeData = node.data as NodeData;
    const nodeType = (nodeData as any).type as string;

    switch (nodeType) {
      case 'trigger': {
        return input;
      }

      case 'llm-agent': {
        const config = (nodeData as any).config;
        if (!config?.endpointId) {
          throw new Error('LLM Agent: no endpoint configured');
        }

        if (!context.getEndpoint) {
          throw new Error('LLM Agent: execution context missing getEndpoint');
        }
        const endpoint = await context.getEndpoint(config.endpointId);
        if (!endpoint) {
          throw new Error(`LLM Agent: endpoint ${config.endpointId} not found`);
        }

        // Prompt-only contract: the LLM receives ONLY the system prompt.
        // No input-derived user message is ever constructed — flow authors
        // reference input explicitly via {{input.…}} variables in the prompt.
        // History is likewise never auto-appended; authors render it with
        // {{input.history}} when they want it. A fixed neutral user turn is
        // sent because some providers (Anthropic) require one.
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
          { role: 'user', content: LLM_AGENT_NO_MESSAGE_PLACEHOLDER },
        ];

        // Collect tool definitions from MCP Tool nodes connected via tool-input handles
        const toolDefs: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
        if (context.getMCPServer) {
          // Look for edges where target is this LLM node and targetHandle starts with 'tool-input'
          const toolEdges = context.flowEdges?.filter(
            (e: any) => e.target === node.id && (e.targetHandle?.startsWith('tool-input') || e.sourceHandle === 'tool-output')
          ) || [];

          for (const edge of toolEdges) {
            const mcpNode = context.flowNodes?.find((n: any) => n.id === edge.source);
            if (!mcpNode) continue;

            if (mcpNode.data?.type === 'mcp-tool') {
              const mcpConfig = (mcpNode.data as any).config || {};
              if (!mcpConfig.serverId) continue;

              try {
                const server = await context.getMCPServer!(mcpConfig.serverId);
                if (server) {
                  const serverTools = server.tools || [];
                  const selected: string[] = mcpConfig.toolNames?.length
                    ? mcpConfig.toolNames
                    : mcpConfig.toolName
                      ? mcpConfig.toolName === '*' ? serverTools.map((t: any) => t.name) : [mcpConfig.toolName]
                      : [];
                  // Empty selection = all tools pass through
                  const toolList = selected.length > 0 ? selected : serverTools.map((t: any) => t.name);
                  for (const toolName of toolList) {
                    const tool = serverTools.find((t: any) => t.name === toolName);
                    if (tool) {
                      toolDefs.push({
                        name: tool.name,
                        description: tool.description || '',
                        input_schema: tool.inputSchema || {},
                      });
                    }
                  }
                }
              } catch { /* skip unavailable servers */ }
            }

            if (mcpNode.data?.type === 'flow-tool') {
              if (!context.getFlow) continue;
              const ftConfig = (mcpNode.data as any).config || {};
              const flowIds: string[] = ftConfig.flowIds || [];
              for (const flowId of flowIds) {
                try {
                  const flowDef = await context.getFlow!(flowId);
                  if (!flowDef) continue;
                  const triggerNode = flowDef.nodes?.find((n: any) => n.data?.type === 'trigger');
                  const triggerConfig = (triggerNode?.data?.config || {}) as any;
                  if (triggerConfig.triggerType !== 'webhook') continue;
                  let inputSchema: Record<string, unknown> = {};
                  try {
                    const raw = triggerConfig.inputSchema;
                    if (raw) {
                      inputSchema = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    }
                  } catch { /* ignore parse errors */ }
                  const toolName = 'flow_' + slugify(flowDef.name);
                  toolDefs.push({
                    name: toolName,
                    description: flowDef.description || '',
                    input_schema: inputSchema,
                  });
                } catch { /* skip unavailable flows */ }
              }
            }
          }
        }

        // Auto-inject built-in tools — file and fetch tools removed (replaced by bash)
        toolDefs.push(
          { name: 'store_get', description: 'Read a persisted value by key', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
          { name: 'store_set', description: 'Persist a value by key (upserts)', input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string', description: 'Any JSON-serializable value' } }, required: ['key', 'value'] } },
          { name: 'store_delete', description: 'Remove a persisted value by key', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
          { name: 'store_list', description: 'List all stored keys', input_schema: { type: 'object', properties: {} } },
          { name: 'now', description: 'Get the current date and time. Specify timezone (e.g. "Europe/Amsterdam") or locale (e.g. "nl-NL") for localized output.', input_schema: { type: 'object', properties: { timezone: { type: 'string' }, locale: { type: 'string' } } } },
          { name: 'uuid', description: 'Generate a UUID', input_schema: { type: 'object', properties: {} } },
          { name: 'log', description: 'Write a log entry (info/warn/error)', input_schema: { type: 'object', properties: { level: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } },
          BASH_TOOL_DEFINITION,
        );

        // Token streaming callback
        const onToken = (token: string) => {
          onEvent(node.id, {
            type: 'stream.token',
            executionId: '',
            nodeId: node.id,
            data: { nodeId: node.id, token },
            timestamp: new Date().toISOString(),
          });
        };

        // Tool-use loop: LLM may call tools, we execute them, feed back results
        const conversation = [...messages];
        let finalContent = '';

        // Build layered system prompt: global → group → flow → agent contexts → node system prompt
        // (shared with the step record so the injected prompt is visible in debug/history)
        const resolvedPrompt = await buildInjectedPrompt(config, input as Record<string, unknown>, flow, context);

        // Inject structured output tool when JSON output is selected
        const allTools = [...(toolDefs || [])];
        let structuredOutputUsed = false;
        if (config.responseFormat === 'json_object') {
          const outputDesc = 'Call this tool to output structured data. Use it to respond — do not output text, only call this tool.';
          if (config.outputSchema) {
            try {
              const schema = JSON.parse(config.outputSchema);
              allTools.push({ name: 'structured_output', description: outputDesc, input_schema: schema });
            } catch {}
          } else {
            allTools.push({ name: 'structured_output', description: outputDesc, input_schema: { type: 'object', properties: {}, additionalProperties: true } as any });
          }
        }

        // Track all tool calls for the execution log
        const executedTools: Array<{ name: string; input: any; result: string }> = [];
        const result: Record<string, unknown> = { content: '' };
        let consecutiveLlmFailures = 0;
        // Truncation recovery state: a response cut by the output token limit
        // ('length') is not a final answer — keep the partial text, tell the
        // model to continue, and loop. Truncated text accumulates so the final
        // output never loses the earlier part.
        let truncatedContinuations = 0;
        let pendingPartial = '';
        // Context-window recovery state: trim oldest rounds on overflow errors.
        let conversationTrims = 0;
        const initialMessageCount = conversation.length;

        for (let round = 0; ; round++) {
          if (this.abortController.signal.aborted) break;

          let response: Awaited<ReturnType<typeof callLLM>>;
          try {
            response = await callLLM(
              {
                endpointId: config.endpointId,
                model: config.model || endpoint.providerType,
                systemPrompt: resolvedPrompt,
                messages: conversation,
                temperature: 0.7,
                onToken,
                tools: allTools.length > 0 ? allTools : undefined,
                signal: this.abortController.signal,
                thinkingMode: config.thinkingMode,
              },
              endpoint,
            );
            consecutiveLlmFailures = 0;
          } catch (err) {
            // A hung/timed-out provider must not freeze the loop: tell the LLM
            // what happened so it can wrap up or retry. Two consecutive
            // failures fail the node instead of retrying forever.
            consecutiveLlmFailures++;
            const errMsg = err instanceof Error ? err.message : String(err);

            // Context window exceeded: the model can never answer if the
            // conversation does not fit. Trim the oldest tool rounds and retry
            // before resorting to failure.
            if (isContextOverflowError(errMsg) && conversationTrims < MAX_CONVERSATION_TRIMS) {
              const trimmed = trimConversation(conversation, initialMessageCount, 8);
              conversationTrims++;
              if (trimmed) {
                consecutiveLlmFailures = 0;
                conversation.push({
                  role: 'user' as const,
                  content: 'Note: the conversation exceeded the context window and older tool results were trimmed. Continue with the remaining context.',
                });
                continue;
              }
            }

            const failMsg = config.responseFormat === 'json_object'
              ? `The LLM API call failed: ${errMsg}. If you have enough information, call structured_output with your final answer now. Otherwise retry your next action.`
              : `The LLM API call failed: ${errMsg}. If you have enough information, provide your final summary now and stop. Otherwise retry your next action.`;
            conversation.push({ role: 'user' as const, content: failMsg });
            if (consecutiveLlmFailures >= 2) {
              throw new Error(`LLM API call failed repeatedly: ${errMsg}`);
            }
            continue;
          }

          if (this.abortController.signal.aborted) break;

          if (response.text) {
            finalContent = pendingPartial + response.text;
          }

          // If no tool calls, we're done — unless the response was truncated
          // by the output token limit, in which case it is not a final answer:
          // keep the partial text, ask the model to continue, and loop.
          if (!response.toolCalls || response.toolCalls.length === 0) {
            if (response.finishReason === 'length' && truncatedContinuations < MAX_TRUNCATED_CONTINUATIONS) {
              truncatedContinuations++;
              pendingPartial += response.text || '';
              conversation.push({ role: 'assistant' as const, content: response.text || '' });
              conversation.push({
                role: 'user' as const,
                content: 'Your previous response was cut off because the output token limit was reached. Continue from exactly where you left off. Do not repeat anything you already wrote.',
              });
              continue;
            }
            break;
          }

          // Add the assistant's tool-use message to conversation.
          // Some providers (DeepSeek) require the reasoning payload to be
          // echoed back when thinking mode is enabled and the model made
          // tool calls — otherwise they return 400.
          conversation.push({
            role: 'assistant' as const,
            content: response.text || '',
            ...(response.reasoning ? { thinking: response.reasoning } : {}),
          });

          // Execute each tool call and add results
          for (const tc of response.toolCalls) {
            // structured_output is a carrier for the output schema, not a real tool
            if (tc.name === 'structured_output') {
              structuredOutputUsed = true;
              Object.assign(result, sanitizeUntrustedKeys(tc.input as Record<string, unknown>));
              executedTools.push({ name: tc.name, input: tc.input, result: 'used as node output' });
              break;
            }
            try {
              // Find the MCP config from the connected tool nodes
              const toolEdges = context.flowEdges?.filter(
                (e: any) => e.target === node.id && (e.targetHandle?.startsWith('tool-input') || e.sourceHandle === 'tool-output')
              ) || [];
              let toolResult = 'Tool not found';

              for (const edge of toolEdges) {
                const mcpNode = context.flowNodes?.find((n: any) => n.id === edge.source);
                if (!mcpNode) continue;
                const mcpConfig = (mcpNode.data as any).config || {};
                const mcpToolNames: string[] = mcpConfig.toolNames?.length
                  ? mcpConfig.toolNames
                  : mcpConfig.toolName
                    ? mcpConfig.toolName === '*' ? [] : [mcpConfig.toolName]
                    : [];
                // Empty selection = all tools on this node match
                const toolMatch = mcpToolNames.length === 0 || mcpToolNames.includes(tc.name);
                if (toolMatch && mcpConfig.serverId) {
                  const { mcpHub } = await import('../tools/hub.js');
                  const server = await context.getMCPServer!(mcpConfig.serverId);
                  if (server) {
                    if (!mcpHub.isConnected(server.id)) {
                      await mcpHub.connect(server);
                    }
                    toolResult = JSON.stringify(await mcpHub.callTool(server.id, tc.name, tc.input));
                  }
                  break;
                }
              }

              // Handle flow-tool calls (tool name starts with "flow_")
              if (toolResult === 'Tool not found' && tc.name.startsWith('flow_')) {
                // Find the matching flow-tool node
                for (const edge of toolEdges) {
                  const ftNode = context.flowNodes?.find((n: any) => n.id === edge.source);
                  if (!ftNode || ftNode.data?.type !== 'flow-tool') continue;
                  const ftConfig = (ftNode.data as any).config || {};
                  const flowIds: string[] = ftConfig.flowIds || [];
                  const selectedFlows: Array<{ id: string; name: string }> = ftConfig.selectedFlows || [];
                  // Find the flow whose slugified name matches the tool name
                  const calledName = tc.name.slice(5);
                  const match = selectedFlows.find(f => slugify(f.name) === calledName);
                  if (match?.id && context.getFlow) {
                    try {
                      const flowDef = await context.getFlow(match.id);
                      if (flowDef) {
                        const subExecutor = new SubFlowExecutor(
                          this.abortController,
                          0,
                          '',
                          [],
                        );
                        const subInput: Record<string, unknown> = tc.input ?? {};
                        const subResult = await subExecutor.execute(
                          flowDef,
                          subInput,
                          onEvent,
                          context,
                        );
                        const hasOutputNode = flowDef.nodes?.some((n: any) => n.data?.type === 'output');
                        toolResult = JSON.stringify(hasOutputNode ? subResult.output : { status: 'completed' });
                      }
                    } catch (err) {
                      toolResult = JSON.stringify({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
                    }
                    break;
                  }
                }
              }

              // Handle built-in utility tools (auto-injected, no MCP node required)
              if (toolResult === 'Tool not found') {
                // Handle bash tool — execute via sidecar
                if (tc.name === 'bash' && context.sandboxExecutionId) {
                  try {
                    const { createSidecarClient } = await import('../sandbox/sidecar-client.js');
                    const { executeBash } = await import('../tools/bash.js');
                    const sidecarClient = createSidecarClient();
                    const env = { ...context.sandboxEnv };
                    toolResult = await executeBash(
                      sidecarClient,
                      context.sandboxExecutionId,
                      (tc.input?.command as string) || '',
                      env,
                      tc.input?.timeout as number | undefined,
                      tc.input?.workdir as string | undefined,
                    );
                  } catch (err) {
                    toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
                  }
                } else {
                  try {
                    const { callBuiltInTool } = await import('../tools/built-in.js');
                    toolResult = await callBuiltInTool(tc.name, { ...tc.input, _runId: this.currentRunId });
                  } catch (err) {
                    toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
                  }
                }
              }

              conversation.push({
                role: 'user' as const,
                content: `Tool result for ${tc.name}: ${toolResult}`,
              });

              executedTools.push({ name: tc.name, input: tc.input, result: toolResult });

              onEvent(node.id, {
                type: 'log',
                executionId: '',
                nodeId: node.id,
                data: { nodeId: node.id, toolCall: tc.name, toolInput: tc.input, toolResult },
                timestamp: new Date().toISOString(),
              });
            } catch (err) {
              executedTools.push({ name: tc.name, input: tc.input, result: `Error: ${err instanceof Error ? err.message : String(err)}` });
              conversation.push({
                role: 'user' as const,
                content: `Tool error for ${tc.name}: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
          // structured_output is the final response — no more rounds needed
          if (structuredOutputUsed) break;

          // Periodic status check: the tool loop runs indefinitely — it only
          // ends when the LLM stops requesting tools (or the run is aborted).
          // Every few rounds, ask the LLM whether it is still making progress
          // so it can re-orient. Never suggest wrapping up — the model decides
          // on its own when it is done.
          if ((round + 1) % TOOL_LOOP_CHECK_INTERVAL === 0) {
            const progressMsg = config.responseFormat === 'json_object'
              ? `Status check (round ${round + 1}): Are you still making progress? If yes, continue with your next action. If you have gathered everything you need, call structured_output with your final answer.`
              : `Status check (round ${round + 1}): Are you still making progress? If yes, continue with your next action.`;
            conversation.push({ role: 'user' as const, content: progressMsg });
          }
        }

        result.content = finalContent;
        if (executedTools.length > 0) result.toolCalls = executedTools;
        if (!structuredOutputUsed && finalContent && config.responseFormat === 'json_object') {
          try {
            const parsed = JSON.parse(finalContent);
            if (typeof parsed === 'object' && parsed !== null) Object.assign(result, sanitizeUntrustedKeys(parsed));
          } catch {}
        }
  return result;
}

      case 'mcp-tool': {
        const config = (nodeData as any).config;
        if (!config?.serverId || !config?.toolName) {
          throw new Error('MCP Tool: serverId and toolName are required');
        }

        if (!context.getMCPServer) {
          throw new Error('MCP Tool: getMCPServer not available in execution context');
        }

        const server = await context.getMCPServer(config.serverId);
        if (!server) {
          throw new Error(`MCP Tool: server ${config.serverId} not found`);
        }

        // Use the MCP Hub to call the tool
        const { mcpHub } = await import('../tools/hub.js');

        // Ensure the server is connected
        if (!mcpHub.isConnected(server.id)) {
          await mcpHub.connect(server);
        }

        const toolResult = await mcpHub.callTool(server.id, config.toolName, config.parameters || {});
        
        return { result: toolResult, toolName: config.toolName, serverName: server.name };
      }

      case 'retriever': {
        const config = (nodeData as any).config;
        const collectionName = config?.collectionName || 'default';
        const topK = config?.topK ?? 5;
        const minScore = config?.minScore ?? 0.5;

        // Extract query from input
        const inputObj = input as Record<string, unknown> | undefined;
        const query = typeof inputObj?.message === 'string'
          ? inputObj.message
          : typeof inputObj === 'string'
            ? inputObj
            : JSON.stringify(inputObj);

        // Generate embedding using the configured provider
        let embedding: number[] = new Array(1536).fill(0);
        if (config?.embeddingProviderId && context.getEmbeddingProvider) {
          const provider = await context.getEmbeddingProvider(config.embeddingProviderId);
          if (provider) {
            const OpenAI = (await import('openai')).default;
            const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl || undefined });
            const resp = await client.embeddings.create({ model: provider.model, input: query });
            embedding = resp.data[0].embedding;
          }
        }

        // Search vector store
        let results: Array<{ documentId: string; chunkText: string; chunkIndex: number; similarity: number }> = [];
        if (context.searchSimilar) {
          results = await context.searchSimilar(collectionName, embedding, topK, minScore);
        }

        // Format as context
        const chunks = results.map(r => ({
          text: r.chunkText,
          similarity: r.similarity,
          documentId: r.documentId,
        }));

        const contextText = chunks.map(c => c.text).join('\n\n');

        
        return { query, chunks, context: contextText, count: chunks.length };
      }

      case 'condition': {
        const config = (nodeData as ConditionNodeData).config;
        const rawCondition = config.condition;
        const labels = config.outputLabels || ['true', 'false'];

        let verdict = false;
        let matchedLabel = '';
        const inputObj = input as Record<string, unknown> | undefined;
        try {
          if (rawCondition && rawCondition.trim()) {
            // Resolve {{input.var}} templates to actual values
            const resolved = await resolveTemplate(rawCondition, input, context);
            // Evaluate the expression in the sidecar sandbox — never in this process
            let result: unknown;
            try {
              if (!context.sandboxExecutionId) {
                throw new Error('Condition node: sandbox not available — cannot evaluate condition securely. Ensure the sidecar is running and execution has a sandbox context.');
              }
              const { evaluateCondition } = await import('../tools/bash.js');
              const { createSidecarClient } = await import('../sandbox/sidecar-client.js');
              const sidecarClient = createSidecarClient();
              const evalResult = await evaluateCondition(
                sidecarClient,
                context.sandboxExecutionId,
                resolved,
                inputObj ?? {},
              );
              if (evalResult.ok) {
                result = evalResult.result;
              } else {
                // Sandbox evaluation failed (syntax/runtime error) — legacy behavior:
                // treat the resolved string as the value itself
                result = resolved;
              }
            } catch (err) {
              throw new Error(`Condition node: failed to evaluate condition in sandbox: ${err instanceof Error ? err.message : String(err)}`);
            }
            const strVal = String(result).trim();
            // Try to match the value against an output label
            matchedLabel = labels.find((l: string) => l && l.toLowerCase() === strVal.toLowerCase()) || '';
            if (matchedLabel) {
              verdict = true;
            } else {
              // Check if a default path is configured
              const defaultPath = config.defaultPath;
              if (defaultPath && labels.includes(defaultPath)) {
                matchedLabel = defaultPath;
                verdict = true;
              } else {
                throw new Error(
                  `Branch condition "${rawCondition}" returned "${strVal}", which does not match any output label. ` +
                  `Available labels: [${labels.filter(Boolean).join(', ')}]. ` +
                  `Add a matching output label, configure a default path, or fix the condition.`
                );
              }
            }
          }
        } catch (err) {
          if (err instanceof Error) throw err;
          verdict = false;
        }

        return { verdict, label: matchedLabel || (verdict ? labels[0] : labels[1]) };
      }

      case 'switch': {
        const config = (nodeData as any).config;
        const fieldPath: string = config.fieldPath || '';
        const cases: Array<{ value: string; label: string }> = config.cases || [];
        const defaultPath: string | undefined = config.defaultPath;

        if (!fieldPath) {
          throw new Error('Switch node: no fieldPath configured');
        }

        const inputObj = input as Record<string, unknown> | undefined;
        // Resolve field path like "trigger.status" against input
        const parts = fieldPath.split('.');
        let value: unknown = inputObj;
        for (const part of parts) {
          if (value && typeof value === 'object') {
            value = (value as Record<string, unknown>)[part];
          } else {
            value = undefined;
            break;
          }
        }
        const strVal = value !== undefined && value !== null ? String(value) : '';

        const matchIndex = cases.findIndex(c => c.value === strVal);
        if (matchIndex !== -1) {
          return { caseIndex: matchIndex, caseValue: cases[matchIndex].value, matched: true };
        }

        if (defaultPath) {
          return { caseIndex: cases.length, caseValue: defaultPath, matched: true };
        }

        throw new Error(
          `Switch: value "${strVal}" (from "${fieldPath}") does not match any case. ` +
          `Available cases: [${cases.map(c => c.value).join(', ')}]. ` +
          `Add a matching case or configure a default path.`
        );
      }

      case 'code': {
        const config = (nodeData as any).config;
        const code = config.code || 'return input;';
        const codeLanguage = config.language || 'javascript';

        if (codeLanguage !== 'javascript') {
          throw new Error(`Code node: unsupported language "${codeLanguage}". Only "javascript" is supported.`);
        }

        if (!context.sandboxExecutionId) {
          throw new Error('Code node: sandbox not available — cannot execute code securely. Ensure the sidecar is running and execution has a sandbox context.');
        }

        // Run code in the sandbox via sidecar
        try {
          const { executeCode } = await import('../tools/bash.js');
          const { createSidecarClient } = await import('../sandbox/sidecar-client.js');
          const sidecarClient = createSidecarClient();
          const result = await executeCode(
            sidecarClient,
            context.sandboxExecutionId,
            code,
            input,
            context.sandboxEnv || {},
            config.timeout as number | undefined,
          );
          return result;
        } catch (err) {
          throw new Error(`Code node execution failed in sandbox: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      case 'parallel': {
        const config = (nodeData as any).config;
        const subNodes = (config?.subNodes || []) as FlowNode[];
        if (subNodes.length === 0) return { merged: {}, note: 'no sub-nodes' };

        // Run all sub-nodes in parallel — any failure aborts all siblings
        const parallelAbort = new AbortController();
        const results = await Promise.all(
          subNodes.map(async (subNode) => {
            if (parallelAbort.signal.aborted) throw new Error('Aborted by sibling failure');
            try {
              // Create a wrapper context that checks the parallel abort signal
              const output = await this.executeNode(subNode, input, { ...context }, onEvent);
              await onEvent(node.id, {
                type: 'log',
                executionId: '',
                nodeId: node.id,
                data: { nodeId: node.id, subNodeId: subNode.id, subNodeType: subNode.data.type, status: 'completed', output },
                timestamp: new Date().toISOString(),
              });
              const subLabel = subNode.data?.label || subNode.data?.type || subNode.id;
              return { id: subLabel, type: subNode.data.type, output };
            } catch (err) {
              parallelAbort.abort(); // Kill all other siblings
              throw err;
            }
          }),
        );

        // Merge all outputs by node ID
        const merged: Record<string, unknown> = {};
        for (const r of results) {
          merged[r.id] = r.output;
        }
        
        return merged;
      }

      case 'subflow': {
        const config = (nodeData as any).config || {};
        if (!config.subflowId) {
          throw new Error('Subflow node: no subflow selected');
        }
        if (!context.getFlow) {
          throw new Error('Subflow node: getFlow not available in execution context');
        }

        const subflowDef = await context.getFlow(config.subflowId, []);
        if (!subflowDef) {
          throw new Error(`Subflow node: subflow "${config.subflowId}" not found`);
        }

        const inputMapping = (config.inputMapping || {}) as Record<string, string>;
        const subflowInput: Record<string, unknown> = {};
        for (const [paramName, template] of Object.entries(inputMapping)) {
          if (template && template.trim()) {
            subflowInput[paramName] = await resolveTemplate(template, input, context);
          }
        }

        const subflowNodeLabel = slugify(node.data.label || node.id);

        const replayFrom = this.currentOptions?.replayFrom;
        let subflowReplayFrom: string | undefined;
        let subflowReplayOutputs: Record<string, unknown> | undefined;

        if (replayFrom && replayFrom.includes(':')) {
          const [subflowPrefix, hitlNodeId] = replayFrom.split(':');
          if (subflowPrefix === subflowNodeLabel || subflowPrefix === node.id) {
            subflowReplayFrom = hitlNodeId;
            const rawOutputs = this.currentOptions?.replayOutputs || {};
            const filtered: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(rawOutputs)) {
              if (k.startsWith(subflowPrefix + ':')) {
                filtered[k.slice(subflowPrefix.length + 1)] = v;
              }
            }
            subflowReplayOutputs = filtered;
          }
        }

        const subflowDepth = (context.currentDepth ?? 0) + 1;
        const subExecutor = new SubFlowExecutor(
          this.abortController,
          subflowDepth,
          subflowNodeLabel,
          [],
        );

        const subOptions: { replayFrom?: string; replayOutputs?: Record<string, unknown> } = {};
        if (subflowReplayFrom) subOptions.replayFrom = subflowReplayFrom;
        if (subflowReplayOutputs) subOptions.replayOutputs = subflowReplayOutputs;

        // Merge env vars: parent env vars first, then subflow's own envVars override
        const subflowEnv: Record<string, string> = { ...(context.sandboxEnv || {}) };
        if (subflowDef.envVars) {
          for (const entry of subflowDef.envVars) {
            if (entry.type === 'static' || entry.type === 'core_secret') {
              subflowEnv[entry.name] = entry.value;
            }
          }
        }

        // Create a subflow context that inherits parent's sandbox with overridden env vars
        const subflowContext = { ...context, sandboxEnv: subflowEnv };

        const result = await subExecutor.execute(subflowDef, subflowInput, onEvent, subflowContext, Object.keys(subOptions).length > 0 ? subOptions : undefined);

        return result.output;
      }

      case 'hitl': {
        const inp = input as Record<string, unknown> | undefined;
        const replayFrom = this.currentOptions?.replayFrom;
        const replayOutputs = this.currentOptions?.replayOutputs || {};
        // Node-scoped approval: only the HITL node targeted by replayFrom may
        // resume. The decision travels per-node inside replayOutputs (keyed by
        // the node id) so approving one HITL never auto-passes others downstream.
        const nodeApproval = replayFrom === node.id
          ? (replayOutputs[`${node.id}:__approved`] as { decision?: string; feedback?: string } | undefined)
          : undefined;
        if (nodeApproval) {
          // Consume the approval so a feedback-loop re-execution of this HITL
          // node pauses again instead of silently re-approving from the stale
          // replay state. The human must decide on each retry's result.
          if (this.currentOptions?.replayOutputs) {
            delete this.currentOptions.replayOutputs[`${node.id}:__approved`];
          }
          return { decision: nodeApproval.decision || 'approved', feedback: nodeApproval.feedback || '', reviewedContent: (inp as any)?._reviewedContent || inp, _iterationCount: (inp as any)?._iterationCount || 0 };
        }
        if (inp?._approved && !replayFrom) {
          // Legacy flow-level approval (no replay context) — kept for direct executes
          return { decision: inp._decision || 'approved', feedback: inp._feedback || '', reviewedContent: inp._reviewedContent || inp, _iterationCount: (inp as any)._iterationCount || 0 };
        }
        // First run: pause for human input with resolved prompt
        const hitlCfg = (nodeData as any).config || {};
        const resolvedPrompt = await resolveTemplate(hitlCfg.prompt || '', input, context);
        const buttons = hitlCfg.buttons || [{ label: 'Approve', value: 'approved', icon: 'check_circle' }, { label: 'Reject', value: 'rejected', icon: 'cancel' }];
        const assignmentType = hitlCfg.assignmentType;
        const assignees = hitlCfg.assignees;
        const requiredApprovals = hitlCfg.requiredApprovals;
        const assignedGroupId = hitlCfg.assignedGroupId;
        const assignedUserId = hitlCfg.assignedUserId;
        const assignedRoleId = hitlCfg.assignedRoleId;
        throw new HitlPauseError(node.id, {}, buttons, resolvedPrompt, assignmentType, assignees, requiredApprovals, assignedGroupId, assignedUserId, assignedRoleId);
      }

      case 'output': {
        const inp = input as Record<string, unknown> | undefined;
        const nodeConfig = (nodeData as any)?.config || {};
        const inputFields: string[] = nodeConfig.inputFields || [];

        // Streaming mode: look for upstream LLM agent content in accumulated input
        if (nodeConfig.streaming && inp && typeof inp === 'object') {
          for (const val of Object.values(inp)) {
            if (val && typeof val === 'object' && typeof (val as any).content === 'string') {
              return (val as any).content;
            }
          }
        }

        // Single dot-path field: extract the inner value directly
        if (inputFields.length === 1 && inputFields[0].includes('.')) {
          const [rawLabel, field] = inputFields[0].split('.');
          const slugLabel = slugify(rawLabel);
          // Try by slugified label key first
          const byLabel = (inp as Record<string, unknown>)?.[slugLabel] as Record<string, unknown> | undefined;
          if (byLabel && field in byLabel) {
            return byLabel[field];
          }
          // Fallback: scan all values for an object containing the target field as a string
          if (inp && typeof inp === 'object') {
            for (const val of Object.values(inp)) {
              if (val && typeof val === 'object' && !Array.isArray(val) && typeof (val as any)[field] === 'string') {
                return (val as any)[field];
              }
            }
          }
        }

        if (inputFields.length === 0) {
          // No field selection — return all accumulated data as-is
          return inp || input;
        }

        // Single label-only field: return the value under that label
        if (inputFields.length === 1) {
          const slugLabel = slugify(inputFields[0]);
          return (inp as Record<string, unknown>)?.[slugLabel] || inp;
        }

        // Multiple fields: return as object
        return inp || input;
      }

      case 'http': {
        const config = (nodeData as any).config || {};
        const { method = 'GET', url = '', headers = '', body = '', authType = 'none', authUsername, authPassword, authToken, authKeyName, authKeyValue, followRedirects = true, timeout = 30000, sslVerify = true, hmacSecret, hmacHeader, allowPrivate = false } = config;
        if (!url) throw new Error('HTTP Request node: URL is required');
        let fetchUrl = await resolveTemplate(url, input, context);
        const fetchHeaders: Record<string, string> = {};
        if (headers) {
          try {
            const parsed = JSON.parse(await resolveTemplate(headers, input, context));
            Object.assign(fetchHeaders, sanitizeUntrustedKeys(parsed));
          } catch { throw new Error('HTTP Request node: headers must be valid JSON'); }
        }
        if (authType === 'basic' && authUsername && authPassword) {
          fetchHeaders['Authorization'] = 'Basic ' + Buffer.from(`${authUsername}:${authPassword}`).toString('base64');
        } else if (authType === 'bearer' && authToken) {
          fetchHeaders['Authorization'] = 'Bearer ' + authToken;
        } else if (authType === 'api-key' && authKeyName && authKeyValue) {
          fetchHeaders[authKeyName] = authKeyValue;
        }
        let fetchBody: string | undefined;
        if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          fetchBody = await resolveTemplate(body, input, context);
          if (!fetchHeaders['Content-Type']) fetchHeaders['Content-Type'] = 'application/json';
        }
        if (hmacSecret && hmacHeader) {
          const crypto = await import('node:crypto');
          const hmac = crypto.createHmac('sha256', hmacSecret).update(fetchBody || '').digest('hex');
          fetchHeaders[hmacHeader] = hmac;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        // Validated, pinned IPs for the current hop — written before each
        // request by assertSafeFetchUrl and read by the dispatcher's lookup.
        let pinnedAddresses: Array<{ address: string; family: number }> = [];
        // undici's Agent lets us override the DNS lookup used at connect time,
        // pinning each request to the IPs validated by assertSafeFetchUrl —
        // a fast-flux/rebinding domain cannot swap to a private IP after the check.
        // The Agent and the fetch MUST come from the same undici package: the
        // worker declares its own undici (which may differ from Node's bundled
        // fetch), and passing a dispatcher from another undici version to the
        // global fetch fails with "invalid onRequestStart method".
        let pinnedDispatcher: any;
        let pinnedFetch: (input: any, init?: any) => Promise<any> = fetch;
        try {
          const { Agent, fetch: undiciFetch } = await import('undici');
          pinnedDispatcher = new Agent({
            connect: {
              // Ignore the hostname — the caller pins the exact validated IPs.
              lookup: ((hostname: string, opts: unknown, cb: (err: Error | null, addrs?: Array<{ address: string; family: number }>) => void) => {
                void hostname; void opts;
                cb(null, pinnedAddresses);
              }) as any,
              // Honor the node's "Verify SSL" toggle (sslVerify: false).
              rejectUnauthorized: sslVerify !== false,
            },
            connectTimeout: timeout,
            headersTimeout: timeout,
            bodyTimeout: timeout,
          });
          pinnedFetch = undiciFetch;
        } catch {
          pinnedDispatcher = undefined;
        }
        try {
          // Manual redirect handling — every hop (including the first) is SSRF-checked
          let currentMethod: string = method;
          let currentBody: string | undefined = fetchBody;
          let currentHeaders = fetchHeaders;
          let redirectCount = 0;
          for (;;) {
            const { addresses } = await assertSafeFetchUrl(fetchUrl, allowPrivate === true);
            pinnedAddresses = addresses;
            const fetchOptions: any = {
              method: currentMethod,
              headers: currentHeaders,
              body: currentBody,
              redirect: 'manual',
              signal: controller.signal,
            };
            if (pinnedDispatcher) fetchOptions.dispatcher = pinnedDispatcher;
            const response = await pinnedFetch(fetchUrl, fetchOptions);
            if (followRedirects && REDIRECT_STATUSES.has(response.status)) {
              const location = response.headers.get('location');
              if (redirectCount >= HTTP_MAX_REDIRECTS) {
                throw new Error(`HTTP Request node: too many redirects (max ${HTTP_MAX_REDIRECTS})`);
              }
              if (!location) {
                // No location header — return the redirect response itself
                const redirectBody = await readResponseBodyCapped(response);
                let parsedBody: unknown;
                try { parsedBody = JSON.parse(redirectBody); } catch { parsedBody = redirectBody; }
                return {
                  status: response.status,
                  statusText: response.statusText,
                  headers: Object.fromEntries(response.headers.entries()),
                  body: parsedBody,
                  ok: response.ok,
                };
              }
              redirectCount++;
              fetchUrl = new URL(location, fetchUrl).toString();
              // Per fetch spec: 301/302 switch POST to GET, 303 switches any
              // non-GET/HEAD to GET; 307/308 always preserve method + body.
              const switchToGet = response.status === 303
                ? currentMethod !== 'GET' && currentMethod !== 'HEAD'
                : (response.status === 301 || response.status === 302) && currentMethod === 'POST';
              if (switchToGet) {
                currentMethod = 'GET';
                currentBody = undefined;
                const nextHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(currentHeaders)) {
                  if (k.toLowerCase() !== 'content-type' && k.toLowerCase() !== 'content-length') {
                    nextHeaders[k] = v;
                  }
                }
                currentHeaders = nextHeaders;
              }
              continue;
            }
            const responseBody = await readResponseBodyCapped(response);
            let parsedBody: unknown;
            try { parsedBody = JSON.parse(responseBody); } catch { parsedBody = responseBody; }
            return {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: parsedBody,
              ok: response.ok,
            };
          }
        } finally {
          clearTimeout(timer);
          if (pinnedDispatcher) {
            pinnedDispatcher.close().catch(() => {});
          }
        }
      }

      case 'loop': {
        const loopConfig = (nodeData as any).config || {};
        const { itemsField, itemVariable = 'item', subNodes = [], subEdges = [], collectResults = true } = loopConfig;
        if (!itemsField) throw new Error('Loop node: itemsField is required');
        const loopResolve = (obj: unknown, path: string): unknown => {
          const parts = path.split('.');
          let cur: unknown = obj;
          for (const p of parts) {
            if (cur === null || cur === undefined) return undefined;
            if (typeof cur === 'object' && !Array.isArray(cur) && p in (cur as Record<string, unknown>)) {
              cur = (cur as Record<string, unknown>)[p];
            } else { return undefined; }
          }
          return cur;
        };
        const items = loopResolve(input, itemsField);
        if (!Array.isArray(items)) throw new Error(`Loop node: "${itemsField}" is not an array`);
        const cappedItems = items.slice(0, MAX_LOOP_ITEMS);
        if (cappedItems.length < items.length) {
          console.warn(`Loop node: "${itemsField}" has ${items.length} items — capped at MAX_LOOP_ITEMS=${MAX_LOOP_ITEMS}`);
        }
        const results: unknown[] = [];
        const errors: { index: number; error: string }[] = [];
        const subFlowDef = { id: '', name: '', description: '', nodes: subNodes, edges: subEdges, version: 1, createdAt: '', updatedAt: '' };
        let iteratedCount = 0;
        for (let i = 0; i < cappedItems.length; i++) {
          if (this.abortController.signal.aborted) break;
          iteratedCount++;
          try {
            const loopInput = { ...(input as Record<string, unknown>), [itemVariable]: cappedItems[i], index: i };
            // Share the parent abort signal so cancellation propagates into loop iterations
            const subExecutor = new FlowExecutor(this.abortController);
            const subResult = await subExecutor.execute(subFlowDef, loopInput, onEvent, context);
            if (collectResults) results.push(subResult.output);
          } catch (err) {
            errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          results: collectResults ? results : undefined,
          count: iteratedCount,
          aborted: this.abortController.signal.aborted,
          errors: errors.length > 0 ? errors : undefined,
        };
      }

      case 'delay': {
        const delayConfig = (nodeData as any).config || {};
        const { type: delayType, seconds, duration, timestamp, jitter } = delayConfig;
        let delayMs = 0;
        const now = Date.now();
        if (delayType === 'fixed' && seconds) {
          delayMs = seconds * 1000;
        } else if (delayType === 'duration' && duration) {
          const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
          if (!match) throw new Error(`Delay node: invalid ISO 8601 duration "${duration}"`);
          const [, h, m, s] = match;
          delayMs = ((parseInt(h || '0') * 3600) + (parseInt(m || '0') * 60) + parseFloat(s || '0')) * 1000;
        } else if (delayType === 'timestamp' && timestamp) {
          const resolved = await resolveTemplate(timestamp, input, context);
          const target = new Date(resolved).getTime();
          if (isNaN(target)) throw new Error(`Delay node: invalid timestamp "${resolved}"`);
          delayMs = Math.max(0, target - now);
        }
        if (jitter) {
          delayMs += Math.floor((Math.random() * 2 - 1) * jitter * 1000);
          delayMs = Math.max(0, delayMs);
        }
        if (delayMs > 0) {
          // On replay (delayed re-run), the delay has already elapsed — skip the
          // pause and continue execution instead of re-throwing it.
          const replayFrom = this.currentOptions?.replayFrom;
          if (replayFrom && replayFrom === node.id) {
            return { delayed: false };
          }
          throw new PauseExecutionError(node.id, input as Record<string, unknown>, delayMs);
        }
        return { delayed: false };
      }

      case 'ai-action': {
        const aiConfig = (nodeData as any).config || {};
        const { endpointId, model, prompt, temperature = 0.7 } = aiConfig;
        if (!endpointId) throw new Error('AI Action node: endpointId is required');
        if (!model) throw new Error('AI Action node: model is required');
        if (!prompt) throw new Error('AI Action node: prompt is required');
        if (!context.getEndpoint) throw new Error('AI Action node: getEndpoint not available');
        const resolvedPrompt = await resolveTemplate(prompt, input, context);
        const endpoint = await context.getEndpoint(endpointId);
        if (!endpoint) throw new Error(`AI Action node: endpoint "${endpointId}" not found`);
        const result = await callLLM({
          endpointId,
          model,
          systemPrompt: '',
          messages: [{ role: 'user', content: resolvedPrompt }],
          temperature,
          thinkingMode: aiConfig.thinkingMode,
        }, endpoint);
        return { content: result.text };
      }

      case 'map': {
        const mapConfig = (nodeData as any).config || {};
        const { fields = [], mode = 'replace' } = mapConfig;
        const output: Record<string, unknown> = {};
        const resolvePath = (obj: unknown, path: string): unknown => {
          const parts = path.split('.');
          let cur: unknown = obj;
          for (const p of parts) {
            if (cur === null || cur === undefined) return undefined;
            if (typeof cur === 'object' && !Array.isArray(cur) && p in (cur as Record<string, unknown>)) {
              cur = (cur as Record<string, unknown>)[p];
            } else { return undefined; }
          }
          return cur;
        };
        for (const field of fields) {
          const resolved = resolvePath(input, field.value);
          output[field.name] = resolved !== undefined ? resolved : null;
        }
        if (mode === 'merge') {
          return { ...(input as Record<string, unknown>), ...output };
        }
        return output;
      }

      case 'note': {
        return { note: true };
      }

      default:
        throw new Error(`Unknown node type: ${(nodeData as any).type}`);
    }
  }
}

export class SubFlowExecutor {
  private abortController: AbortController;
  private depth: number;
  private parentPath: string;
  private ancestorFlowIds: string[];

  constructor(
    abortController: AbortController,
    depth: number,
    parentPath: string,
    ancestorFlowIds: string[],
  ) {
    this.abortController = abortController;
    this.depth = depth;
    this.parentPath = parentPath;
    this.ancestorFlowIds = ancestorFlowIds;
  }

  async execute(
    flow: FlowDefinition,
    input: Record<string, unknown>,
    onEvent: EventCallback,
    context: ExecutionContext,
    options?: { replayFrom?: string; replayOutputs?: Record<string, unknown>; inputOverride?: Record<string, unknown>; initialIteration?: number },
  ): Promise<{ output: Record<string, unknown>; steps: ExecutionStep[] }> {
    const MAX_DEPTH = 10;
    if (this.depth > MAX_DEPTH) throw new Error('Max subflow recursion depth (10) exceeded');

    let subExecutionId = '';
    if (context.onSubExecution) {
      subExecutionId = await context.onSubExecution({
        parentExecutionId: context.currentExecutionId || '',
        subflowNodeId: this.parentPath,
        subflowId: flow.id,
        input,
        depth: this.depth,
        path: this.parentPath,
      });
    }

    await onEvent(this.parentPath, {
      type: 'subflow.started',
      executionId: subExecutionId || '',
      nodeId: this.parentPath,
      data: { subflowNodeId: this.parentPath, subflowLabel: flow.name, input, depth: this.depth, subExecutionId },
      timestamp: new Date().toISOString(),
      hierarchy: { path: this.parentPath, depth: this.depth },
    });

    const subFlowExecutor = new FlowExecutor(this.abortController);

    const wrappedOnEvent: EventCallback = async (nodeId, event) => {
      const fullNodeId = this.parentPath ? `${this.parentPath}:${nodeId}` : nodeId;
      const enrichedEvent: SSEEvent = {
        ...event,
        executionId: subExecutionId || event.executionId,
        nodeId: fullNodeId,
        hierarchy: { path: fullNodeId, depth: this.depth },
      };
      return onEvent(fullNodeId, enrichedEvent);
    };

    const subContext: ExecutionContext = {
      ...context,
      currentExecutionId: subExecutionId || context.currentExecutionId,
      currentDepth: this.depth,
      getFlow: context.getFlow
        ? (flowId: string, ancestry?: string[]) => context.getFlow!(flowId, [...(ancestry || this.ancestorFlowIds), flow.id])
        : undefined,
    };

    try {
      const result = await subFlowExecutor.execute(
        flow,
        input,
        wrappedOnEvent,
        subContext,
        options,
      );

      if (context.completeSubExecution && subExecutionId) {
        await context.completeSubExecution(subExecutionId, result.output as Record<string, unknown>, 'completed');
      }

      await onEvent(this.parentPath, {
        type: 'subflow.completed',
        executionId: subExecutionId || '',
        nodeId: this.parentPath,
        data: { subflowNodeId: this.parentPath, subflowLabel: flow.name, output: result.output, depth: this.depth },
        timestamp: new Date().toISOString(),
        hierarchy: { path: this.parentPath, depth: this.depth },
      });

      return result;
    } catch (err) {
      if (err instanceof HitlPauseError || err instanceof PauseExecutionError || err instanceof FlowStopError) {
        if (context.completeSubExecution && subExecutionId) {
          await context.completeSubExecution(subExecutionId, {}, 'failed', 'Interrupted by HITL/stop');
        }
        // Prefix the paused node id with this subflow's hierarchical path (e.g.
        // 'subLabel:c3') so pause handlers can store a replayable id. The parent
        // replay machinery routes on this prefix and strips it per level, which
        // also works for nested subflows.
        if (this.parentPath && (err instanceof HitlPauseError || err instanceof PauseExecutionError)) {
          err.nodeId = `${this.parentPath}:${err.nodeId}`;
        }
        throw err;
      }

      if (context.completeSubExecution && subExecutionId) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await context.completeSubExecution(subExecutionId, {}, 'failed', errorMsg);
      }

      await onEvent(this.parentPath, {
        type: 'subflow.failed',
        executionId: subExecutionId || '',
        nodeId: this.parentPath,
        data: { subflowNodeId: this.parentPath, subflowLabel: flow.name, error: err instanceof Error ? err.message : String(err), depth: this.depth },
        timestamp: new Date().toISOString(),
        hierarchy: { path: this.parentPath, depth: this.depth },
      });

      throw err;
    }
  }
}

export function resolveTemplateSync(template: string, data: unknown, lookupSecret?: (name: string, scope?: 'app' | 'group' | 'flow') => string | null): string {
  let result = template;

  result = result.replace(/\{\{secrets\.core\.(?:group:|app:)?([^}]+)\}\}/g, (match, name: string) => {
    const scope = match.includes('core.group:') ? 'group' as const : match.includes('core.app:') ? 'app' as const : undefined;
    const value = lookupSecret?.(name.trim(), scope);
    if (value !== null && value !== undefined) return value;
    console.warn(`Template variable ${match} could not be resolved`);
    return '';
  });

  result = result.replace(/\{\{input\.([^}]+)\}\}/g, (match, path: string) => {
    const parts = path.trim().split('.');
    let current: unknown = data;
    for (const part of parts) {
      const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (bracketMatch) {
        const key = bracketMatch[1];
        const idx = parseInt(bracketMatch[2]);
        if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
          const arr = (current as Record<string, unknown>)[key];
          if (Array.isArray(arr) && idx < arr.length) {
            current = arr[idx];
          } else {
            console.warn(`Template variable ${match} could not be resolved`);
            return '';
          }
        } else {
          console.warn(`Template variable ${match} could not be resolved`);
          return '';
        }
      } else if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        const slugPart = slugify(part);
        if (current && typeof current === 'object' && slugPart in (current as Record<string, unknown>)) {
          current = (current as Record<string, unknown>)[slugPart];
        } else {
          console.warn(`Template variable ${match} could not be resolved`);
          return '';
        }
      }
    }
    if (typeof current === 'object') return JSON.stringify(current);
    return String(current);
  });

  return result;
}

// Full async template resolution including CyberArk secrets.
export async function resolveTemplate(template: string, data: unknown, context?: ExecutionContext): Promise<string> {
  // First resolve core secrets (async getSecret calls)
  const secretsMap = new Map<string, string>();
  const secretRegex = /\{\{secrets\.core\.(?:group:|app:|flow:)?([^}]+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = secretRegex.exec(template)) !== null) {
    const fullMatch = match[0];
    const name = match[1].trim();
    const scope = fullMatch.includes('core.group:') ? 'group' as const : fullMatch.includes('core.app:') ? 'app' as const : fullMatch.includes('core.flow:') ? 'flow' as const : undefined;
    const mapKey = `${scope || 'default'}:${name}`;
    if (!secretsMap.has(mapKey)) {
      try {
        const value = context?.getSecret ? await context.getSecret(name, scope ? { scope } : undefined) : null;
        if (value !== null) secretsMap.set(mapKey, value);
      } catch { /* secret not found */ }
    }
  }
  const syncLookup = (name: string, _scope?: 'app' | 'group' | 'flow') => secretsMap.get(`${_scope || 'default'}:${name}`) ?? null;
  let result = resolveTemplateSync(template, data, syncLookup);

  // Resolve {{env.VAR_NAME}} — merged env var map
  const envVars = context?.sandboxEnv || {};
  result = result.replace(/\{\{env\.(?:app\.|group\.|flow\.)?([^}]+)\}\}/g, (match, name: string) => {
    const value = envVars[name.trim()];
    if (value !== undefined) return value;
    console.warn(`Template variable ${match} could not be resolved`);
    return '';
  });

  // Resolve {{secrets.cyberark.PATH}} — live CyberArk query (async)
  const cyberarkMatches = result.match(/\{\{secrets\.cyberark\.([^}]+)\}\}/g);
  if (cyberarkMatches && context?.getCyberArkSecret) {
    for (const fullMatch of cyberarkMatches) {
      const path = fullMatch.replace(/\{\{secrets\.cyberark\./, '').replace(/\}\}$/, '');
      try {
        const value = await context.getCyberArkSecret(path.trim());
        if (value !== null && value !== undefined) {
          result = result.replace(fullMatch, value);
        } else {
          console.warn(`CyberArk secret ${fullMatch} could not be resolved`);
          result = result.replace(fullMatch, '');
        }
      } catch (err) {
        console.warn(`CyberArk secret ${fullMatch} error: ${(err as Error).message}`);
        result = result.replace(fullMatch, '');
      }
    }
  }

  return result;
}
