import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { ThinkingMode } from 'orchestream-ai-shared';
import {
  getThinkingStrategy,
  type ThinkingPayload,
  type ThinkingStrategy,
  type ConversationMessage,
} from './thinking.js';

export type { ThinkingPayload, ThinkingStrategy, ConversationMessage };

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** Chain-of-thought reasoning + provider-specific pass-back metadata.
   *  Some providers (e.g. DeepSeek) require it to be echoed back when
   *  thinking mode is enabled and the model made tool calls. */
  reasoning?: ThinkingPayload;
  /** Provider stop reason — 'length' means the response was truncated by the
   *  output token limit and must not be treated as a final answer. */
  finishReason?: string;
}

export interface LLMCallParams {
  apiKey: string;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  temperature: number;
  onToken?: (token: string) => void;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** Normalized thinking-mode control. Each provider strategy translates it
   *  into its own request params; unsupported modes are silently ignored. */
  thinkingMode?: ThinkingMode;
}

// ── Adapter interface ─────────────────────────────────────────────

// Per-call timeout so a hung or rate-limited provider never freezes a run.
// Override via LLM_TIMEOUT_MS.
const LLM_CALL_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS ?? '120000', 10);

// Output token ceiling for OpenAI-compatible providers (DeepSeek, LiteLLM,
// OpenAI). Providers apply their own lower default (e.g. DeepSeek caps at
// 8192) which silently truncates long answers — pin it high like the
// Anthropic adapter does. Override via LLM_MAX_TOKENS.
const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS ?? '32000', 10);

interface ProviderAdapter {
  createClient(params: LLMCallParams): any;
  buildRequest(params: LLMCallParams, strategy: ThinkingStrategy): any;
  streamResponse(client: any, request: any, strategy: ThinkingStrategy): AsyncIterable<{ text?: string; reasoning?: string; finishReason?: string; toolCalls?: Array<{ index: number; id?: string; name?: string; args?: string }> }>;
  nonStreamResponse(client: any, request: any, strategy: ThinkingStrategy): Promise<LLMResponse>;
}

// ── OpenAI ─────────────────────────────────────────────────────────

const openaiAdapter: ProviderAdapter = {
  createClient(params) {
    return new OpenAI({
      apiKey: params.apiKey,
      baseURL: params.baseUrl || undefined,
      timeout: LLM_CALL_TIMEOUT_MS,
      maxRetries: 1,
    });
  },
  buildRequest(params, strategy) {
    return {
      model: params.model,
      messages: [
        ...(params.systemPrompt ? [{ role: 'system' as const, content: params.systemPrompt }] : []),
        ...params.messages.map(m => strategy.renderAssistantMessage(m)),
      ],
      temperature: params.temperature,
      // No effective token limit on responses — see LLM_MAX_TOKENS above.
      max_tokens: LLM_MAX_TOKENS,
      tools: params.tools?.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: params.tools?.length ? 'auto' : undefined,
      ...strategy.toRequestParams(params.thinkingMode ?? 'default'),
    };
  },
  async *streamResponse(client, request, strategy) {
    const stream = await client.chat.completions.create({ ...request, stream: true });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      yield {
        text: delta?.content,
        reasoning: strategy.extractStreamReasoning(chunk),
        finishReason: chunk.choices?.[0]?.finish_reason ?? undefined,
        toolCalls: delta?.tool_calls?.map((tc: any) => ({
          index: tc.index, id: tc.id, name: tc.function?.name, args: tc.function?.arguments,
        })),
      };
    }
  },
  async nonStreamResponse(client, request, strategy) {
    const response = await client.chat.completions.create(request);
    const msg = response.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls?.filter((tc: any) => tc.type === 'function').map((tc: any) => ({
      id: tc.id, name: tc.function?.name || '',
      input: (() => { try { return JSON.parse(tc.function?.arguments); } catch { return {}; } })(),
    }));
    return {
      text: msg?.content || '',
      reasoning: strategy.extractMessageReasoning(msg),
      finishReason: response.choices?.[0]?.finish_reason ?? undefined,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };
  },
};

// ── Anthropic ──────────────────────────────────────────────────────

const anthropicAdapter: ProviderAdapter = {
  createClient(params) {
    return new Anthropic({
      apiKey: params.apiKey,
      timeout: LLM_CALL_TIMEOUT_MS,
      maxRetries: 1,
    });
  },
  buildRequest(params, strategy) {
    return {
      model: params.model,
      system: params.systemPrompt ? [{ type: 'text' as const, text: params.systemPrompt }] : undefined,
      messages: params.messages.map(m => strategy.renderAssistantMessage(m)),
      temperature: params.temperature,
      // The Anthropic API requires max_tokens — pin it to the model ceiling so
      // there is effectively no token limit on responses.
      max_tokens: 32000,
      tools: params.tools?.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      ...strategy.toRequestParams(params.thinkingMode ?? 'default'),
    };
  },
  async *streamResponse(client, request, strategy) {
    const stream = await client.messages.create({ ...request, stream: true });
    let currentTool: { id: string; name: string; args: string } | null = null;
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        currentTool = { id: event.content_block.id, name: event.content_block.name, args: '' };
        yield { toolCalls: [{ index: 0, id: event.content_block.id, name: event.content_block.name }] };
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && currentTool) {
        currentTool.args += event.delta.partial_json;
        yield { toolCalls: [{ index: 0, args: event.delta.partial_json }] };
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        yield { text: event.delta.text };
      }
      if (event.type === 'message_delta' && event.delta?.stop_reason) {
        yield { finishReason: event.delta.stop_reason };
      }
      const reasoning = strategy.extractStreamReasoning(event);
      if (reasoning) {
        yield { reasoning };
      }
    }
  },
  async nonStreamResponse(client, request, strategy) {
    const response = await client.messages.create(request);
    const text = response.content
      .filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const toolCalls = response.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
    return {
      text,
      reasoning: strategy.extractMessageReasoning(response),
      finishReason: response.stop_reason ?? undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  },
};

// ── Registry ───────────────────────────────────────────────────────

const adapters: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  litellm: openaiAdapter,
  anthropic: anthropicAdapter,
};

// ── Generic caller ─────────────────────────────────────────────────

export async function callLLMGeneric(params: LLMCallParams, providerType: string): Promise<LLMResponse> {
  const adapter = adapters[providerType];
  if (!adapter) throw new Error(`Unknown provider type: ${providerType}`);

  const client = adapter.createClient(params);
  const strategy = getThinkingStrategy(providerType, params.baseUrl, params.model);
  const request = adapter.buildRequest(params, strategy);

  if (params.onToken) {
    const stream = adapter.streamResponse(client, request, strategy);
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let fullText = '';
    let fullReasoning = '';
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      if (chunk.text) {
        fullText += chunk.text;
        params.onToken(chunk.text);
      }
      if (chunk.reasoning) {
        fullReasoning += chunk.reasoning;
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          if (!toolCallMap.has(tc.index)) toolCallMap.set(tc.index, { id: tc.id || '', name: tc.name || '', args: '' });
          const entry = toolCallMap.get(tc.index)!;
          if (tc.id) entry.id = tc.id;
          if (tc.name) entry.name = tc.name;
          if (tc.args) entry.args += tc.args;
        }
      }
    }

    const toolCalls = Array.from(toolCallMap.values()).map(tc => ({
      id: tc.id, name: tc.name,
      input: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
    }));
    return {
      text: fullText,
      reasoning: fullReasoning ? { content: fullReasoning } : undefined,
      finishReason,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  }

  return adapter.nonStreamResponse(client, request, strategy);
}
