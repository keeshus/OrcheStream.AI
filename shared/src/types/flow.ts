import { z } from 'zod';
import type { ThinkingMode } from './thinking.js';

// ── Node type enum ──────────────────────────────────────────

export const NODE_TYPES = [
  'trigger',
  'llm-agent',
  'mcp-tool',
  'flow-tool',
  'retriever',
  'condition',
  'switch',
  'code',
  'output',
  'parallel',
  'hitl',
  'subflow',
  'http',
  'loop',
  'delay',
  'ai-action',
  'map',
  'note',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];
export type NodeCategory = 'input' | 'processing' | 'tools' | 'output';

export const nodeTypeSchema = z.enum(NODE_TYPES);

// ── Base node data ──────────────────────────────────────────

export interface BaseNodeData {
  label: string;
  type: NodeType;
  config: Record<string, unknown>;
}

// ── Per-node configs ────────────────────────────────────────

export interface TriggerNodeData extends BaseNodeData {
  type: 'trigger';
  config: {
    triggerType: 'manual' | 'chat' | 'webhook' | 'schedule' | 'subflow';
    webhookSecret?: string;
    cronExpression?: string;
    inputSchema?: string;
    inputMessage?: string;
    personalApiKeyPrefix?: string;
    personalApiKeyCreatedAt?: string;
  };
}

export interface LLMAgentNodeData extends BaseNodeData {
  type: 'llm-agent';
  config: {
    endpointId: string;
    model: string;
    systemPrompt: string;
    responseFormat: 'text' | 'json_object';
    outputSchema?: string;
    inputFields?: string[];
    contextIds?: string[];
    thinkingMode?: ThinkingMode;
  };
}

export interface MCPToolNodeData extends BaseNodeData {
  type: 'mcp-tool';
  config: {
    serverId: string;
    toolName: string;
    parameters: Record<string, unknown>;
  };
}

export interface FlowToolNodeData extends BaseNodeData {
  type: 'flow-tool';
  config: {
    flowIds: string[];
    selectedFlows?: Array<{ id: string; name: string; groupId?: string | null }>;
  };
}

export interface RetrieverNodeData extends BaseNodeData {
  type: 'retriever';
  config: {
    embeddingProviderId: string;
    vectorStoreId: string;
    collectionName: string;
    topK: number;
    minScore: number;
  };
}

export interface ConditionNodeData extends BaseNodeData {
  type: 'condition';
  config: {
    condition: string;
    outputLabels: string[];
    inputFields?: string[];
    defaultPath?: string;
  };
}

export interface SwitchNodeData extends BaseNodeData {
  type: 'switch';
  config: {
    fieldPath: string;
    cases: Array<{ value: string; label: string }>;
    defaultPath?: string;
  };
}

export interface CodeNodeData extends BaseNodeData {
  type: 'code';
  config: {
    language: 'javascript' | 'python';
    code: string;
    outputSchema?: string;
    inputFields?: string[];
  };
}

export interface OutputNodeData extends BaseNodeData {
  type: 'output';
  config: {
    format: 'text' | 'json' | 'markdown';
  };
}

export interface ParallelNodeData extends BaseNodeData {
  type: 'parallel';
  config: {
    subNodes: FlowNode[];
    subEdges: FlowEdge[];
  };
}

export interface HitlNodeData extends BaseNodeData {
  type: 'hitl';
  config: {
    prompt: string;
    buttons: Array<{ label: string; value: string }>;
    allowFeedback?: boolean;
    maxIterations?: number;
    assignedTo?: { type: 'user'; userId: string } | { type: 'role'; roleId: string } | { type: 'group'; groupId: string };
  };
}

export interface SubflowNodeData extends BaseNodeData {
  type: 'subflow';
  config: {
    subflowId: string;
    inputMapping: Record<string, string>;
  };
}

export interface HttpNodeData extends BaseNodeData {
  type: 'http';
  config: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    url: string;
    headers?: string;
    body?: string;
    authType?: 'none' | 'basic' | 'bearer' | 'api-key';
    authUsername?: string;
    authPassword?: string;
    authToken?: string;
    authKeyName?: string;
    authKeyValue?: string;
    followRedirects?: boolean;
    timeout?: number;
    retries?: number;
    sslVerify?: boolean;
    hmacSecret?: string;
    hmacHeader?: string;
    allowPrivate?: boolean;
  };
}

export interface LoopNodeData extends BaseNodeData {
  type: 'loop';
  config: {
    itemsField: string;
    itemVariable: string;
    indexVariable?: string;
    subNodes: FlowNode[];
    subEdges: FlowEdge[];
    collectResults?: boolean;
  };
}

export interface DelayNodeData extends BaseNodeData {
  type: 'delay';
  config: {
    type: 'fixed' | 'duration' | 'timestamp';
    seconds?: number;
    duration?: string;
    timestamp?: string;
    jitter?: number;
  };
}

export interface AIActionNodeData extends BaseNodeData {
  type: 'ai-action';
  config: {
    endpointId: string;
    model: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'text' | 'json_object';
    outputSchema?: string;
    inputFields?: string[];
    thinkingMode?: ThinkingMode;
  };
}

export interface MapNodeData extends BaseNodeData {
  type: 'map';
  config: {
    fields: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'object' | 'array';
      value: string;
    }>;
    mode: 'merge' | 'replace';
  };
}

export interface NoteNodeData extends BaseNodeData {
  type: 'note';
  config: {
    content: string;
    color?: string;
  };
}

export type NodeData =
  | TriggerNodeData
  | LLMAgentNodeData
  | MCPToolNodeData
  | FlowToolNodeData
  | RetrieverNodeData
  | ConditionNodeData
  | SwitchNodeData
  | CodeNodeData
  | OutputNodeData
  | ParallelNodeData
  | HitlNodeData
  | SubflowNodeData
  | HttpNodeData
  | LoopNodeData
  | DelayNodeData
  | AIActionNodeData
  | MapNodeData
  | NoteNodeData;

// ── Edge ─────────────────────────────────────────────────────

export interface EdgeCondition {
  label: string;
  expression: string;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  condition?: EdgeCondition;
}

// ── Flow node (React Flow shape) ─────────────────────────────

export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: NodeData;
}

// ── Flow definition ─────────────────────────────────────────

export interface FlowDefinition {
  id: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  version: number;
  createdAt: string;
  updatedAt: string;
  groupId?: string;
  flowContext?: string;
  envVars?: EnvVarEntry[];
  cyberarkMappings?: Record<string, string>;
}

// ── Env var configuration ──────────────────────────────────────

export type EnvVarType = 'static' | 'core_secret' | 'cyberark';

export interface EnvVarEntry {
  name: string;
  type: EnvVarType;
  value: string;
}

export interface EnvVarConfig {
  envVars: EnvVarEntry[];
}

// ── Execution ────────────────────────────────────────────────

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval';

export interface Execution {
  id: string;
  flowId: string;
  status: ExecutionStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  parentExecutionId?: string | null;
  subflowNodeId?: string | null;
  subflowDepth?: number;
}

export interface ExecutionStep {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: NodeType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  hierarchy?: { path: string; depth: number };
}

// ── SSE events ───────────────────────────────────────────────

export type SSEEventType =
  | 'execution.started'
  | 'step.started'
  | 'step.completed'
  | 'step.failed'
  | 'step.skipped'
  | 'subflow.started'
  | 'subflow.completed'
  | 'subflow.failed'
  | 'stream.token'
  | 'execution.completed'
  | 'execution.failed'
  | 'execution.paused'
  | 'execution.stopped'
  | 'log';

export interface SSEEvent {
  type: SSEEventType;
  executionId: string;
  nodeId?: string;
  data: Record<string, unknown>;
  timestamp: string;
  hierarchy?: { path: string; depth: number };
}

// ── Node catalog ─────────────────────────────────────────────

export interface NodeCatalogEntry {
  type: NodeType;
  label: string;
  category: NodeCategory;
  description: string;
  defaultConfig: Record<string, unknown>;
  inputs: number;
  outputs: number;
}
