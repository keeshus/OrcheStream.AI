// ── Thinking-mode strategies ─────────────────────────────────────────
// Each provider family expresses chain-of-thought reasoning differently.
// A ThinkingStrategy knows how to:
//   - translate a normalized ThinkingMode into provider request params
//   - render assistant messages for pass-back (DeepSeek requires
//     reasoning_content; others keep their own context internally)
//   - extract reasoning text from streaming chunks and full responses
// Adding a new model family = implementing one strategy + registering a
// matcher in getThinkingStrategy.

import type { ThinkingMode } from 'orchestream-ai-shared';

export interface ThinkingPayload {
  content: string;
  /** Provider-specific metadata required for pass-back (e.g. signatures). */
  passBack?: Record<string, unknown>;
}

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  thinking?: ThinkingPayload;
};

export interface ThinkingStrategy {
  readonly id: string;
  toRequestParams(mode: ThinkingMode): Record<string, unknown>;
  renderAssistantMessage(m: ConversationMessage): Record<string, unknown>;
  /** Extract reasoning text from a streaming chunk (provider-specific shape). */
  extractStreamReasoning(chunk: any): string | undefined;
  /** Extract reasoning (text + pass-back metadata) from a full response message. */
  extractMessageReasoning(message: any): ThinkingPayload | undefined;
}

// ── DeepSeek (OpenAI-compatible + DeepSeek extras) ───────────────────
// Toggle: {"thinking": {"type": "enabled|disabled"}} via extra_body.
// Effort: reasoning_effort low/high/xhigh/max (docs: api-docs.deepseek.com).
// reasoning_content MUST be passed back when thinking is enabled and the
// model made tool calls, otherwise the API returns 400.

const deepseekStrategy: ThinkingStrategy = {
  id: 'deepseek',
  toRequestParams(mode) {
    switch (mode) {
      case 'disabled':
        return { thinking: { type: 'disabled' } };
      case 'enabled':
        return { thinking: { type: 'enabled' } };
      case 'low':
      case 'high':
      case 'xhigh':
      case 'max':
        return {
          thinking: { type: 'enabled' },
          reasoning_effort: mode,
        };
      default:
        return {};
    }
  },
  renderAssistantMessage(m) {
    return {
      role: m.role,
      content: m.content,
      ...(m.thinking?.content ? { reasoning_content: m.thinking.content } : {}),
    };
  },
  extractStreamReasoning(chunk) {
    return chunk?.choices?.[0]?.delta?.reasoning_content;
  },
  extractMessageReasoning(message) {
    const content = message?.reasoning_content;
    return content ? { content } : undefined;
  },
};

// ── OpenAI (o-series) ────────────────────────────────────────────────
// reasoning_effort low/medium/high. Thinking cannot be toggled off and no
// reasoning pass-back is required.

const openaiStrategy: ThinkingStrategy = {
  id: 'openai',
  toRequestParams(mode) {
    switch (mode) {
      case 'low':
      case 'medium':
      case 'high':
        return { reasoning_effort: mode };
      case 'enabled':
        return { reasoning_effort: 'medium' };
      case 'xhigh':
      case 'max':
        return { reasoning_effort: 'high' };
      default:
        return {};
    }
  },
  renderAssistantMessage(m) {
    return { role: m.role, content: m.content };
  },
  extractStreamReasoning(chunk) {
    return chunk?.choices?.[0]?.delta?.reasoning_content;
  },
  extractMessageReasoning(message) {
    const content = message?.reasoning_content;
    return content ? { content } : undefined;
  },
};

// ── Anthropic ────────────────────────────────────────────────────────
// reasoning: {effort: none|low|high|max}. Thinking deltas arrive as
// content_block_delta with delta.type === 'thinking_delta'. No pass-back
// needed — Anthropic maintains reasoning context server-side.

const anthropicStrategy: ThinkingStrategy = {
  id: 'anthropic',
  toRequestParams(mode) {
    switch (mode) {
      case 'disabled':
        return { reasoning: { effort: 'none' } };
      case 'enabled':
        return { reasoning: { effort: 'high' } };
      case 'low':
      case 'high':
      case 'max':
        return { reasoning: { effort: mode } };
      case 'xhigh':
        return { reasoning: { effort: 'max' } };
      default:
        return {};
    }
  },
  renderAssistantMessage(m) {
    return { role: m.role, content: m.content };
  },
  extractStreamReasoning(chunk) {
    return chunk?.delta?.type === 'thinking_delta' ? chunk.delta.thinking : undefined;
  },
  extractMessageReasoning(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const parts = blocks.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking);
    if (parts.length === 0) return undefined;
    return { content: parts.join('') };
  },
};

// ── Resolver ─────────────────────────────────────────────────────────

const strategies: Record<string, ThinkingStrategy> = {
  deepseek: deepseekStrategy,
  openai: openaiStrategy,
  anthropic: anthropicStrategy,
};

export function isDeepseekEndpoint(baseUrl?: string | null, model?: string | null): boolean {
  return Boolean(
    (baseUrl ?? '').toLowerCase().includes('deepseek') ||
    (model ?? '').toLowerCase().startsWith('deepseek'),
  );
}

export function getThinkingStrategy(providerType: string, baseUrl?: string | null, model?: string | null): ThinkingStrategy {
  if (providerType === 'anthropic') return strategies.anthropic;
  if (isDeepseekEndpoint(baseUrl, model)) return strategies.deepseek;
  return strategies.openai;
}
