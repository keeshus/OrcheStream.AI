import { describe, it, expect } from 'vitest';
import {
  getThinkingStrategy,
  isDeepseekEndpoint,
} from '../providers/thinking.js';

describe('isDeepseekEndpoint', () => {
  it('detects DeepSeek by base URL', () => {
    expect(isDeepseekEndpoint('https://api.deepseek.com')).toBe(true);
    expect(isDeepseekEndpoint('https://api.deepseek.com/v1')).toBe(true);
    expect(isDeepseekEndpoint('https://api.openai.com/v1')).toBe(false);
  });

  it('detects DeepSeek by model name', () => {
    expect(isDeepseekEndpoint(undefined, 'deepseek-v4-flash')).toBe(true);
    expect(isDeepseekEndpoint(undefined, 'gpt-4o')).toBe(false);
  });

  it('treats null/undefined as non-DeepSeek', () => {
    expect(isDeepseekEndpoint(null, null)).toBe(false);
    expect(isDeepseekEndpoint(undefined, undefined)).toBe(false);
  });
});

describe('getThinkingStrategy', () => {
  it('resolves anthropic strategy for the anthropic provider', () => {
    expect(getThinkingStrategy('anthropic').id).toBe('anthropic');
  });

  it('resolves deepseek strategy for DeepSeek-backed OpenAI endpoints', () => {
    expect(getThinkingStrategy('openai', 'https://api.deepseek.com').id).toBe('deepseek');
    expect(getThinkingStrategy('litellm', null, 'deepseek-v4-pro').id).toBe('deepseek');
  });

  it('resolves openai strategy as the default', () => {
    expect(getThinkingStrategy('openai').id).toBe('openai');
    expect(getThinkingStrategy('openai', 'https://api.openai.com/v1', 'o3-mini').id).toBe('openai');
    expect(getThinkingStrategy('litellm').id).toBe('openai');
  });
});

describe('deepseek strategy', () => {
  const strategy = getThinkingStrategy('openai', 'https://api.deepseek.com');

  it('maps disabled to thinking disabled extra_body', () => {
    expect(strategy.toRequestParams('disabled')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('maps effort levels to thinking enabled + reasoning_effort', () => {
    expect(strategy.toRequestParams('xhigh')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'xhigh',
    });
  });

  it('renders reasoning_content pass-back on assistant messages', () => {
    expect(strategy.renderAssistantMessage({ role: 'assistant', content: 'hi', thinking: { content: 'thinking text' } }))
      .toEqual({ role: 'assistant', content: 'hi', reasoning_content: 'thinking text' });
  });

  it('omits reasoning_content when no thinking payload is attached', () => {
    expect(strategy.renderAssistantMessage({ role: 'user', content: 'hi' }))
      .toEqual({ role: 'user', content: 'hi' });
  });

  it('extracts reasoning from streaming chunks and messages', () => {
    expect(strategy.extractStreamReasoning({ choices: [{ delta: { reasoning_content: 'x' } }] })).toBe('x');
    expect(strategy.extractMessageReasoning({ reasoning_content: 'full thought' })).toEqual({ content: 'full thought' });
  });
});

describe('openai strategy', () => {
  const strategy = getThinkingStrategy('openai');

  it('maps effort levels to reasoning_effort only', () => {
    expect(strategy.toRequestParams('medium')).toEqual({ reasoning_effort: 'medium' });
    expect(strategy.toRequestParams('high')).toEqual({ reasoning_effort: 'high' });
  });

  it('maps enabled to the default effort', () => {
    expect(strategy.toRequestParams('enabled')).toEqual({ reasoning_effort: 'medium' });
  });

  it('ignores unsupported modes (disabled, xhigh, max)', () => {
    expect(strategy.toRequestParams('disabled')).toEqual({});
    expect(strategy.toRequestParams('xhigh')).toEqual({ reasoning_effort: 'high' });
    expect(strategy.toRequestParams('max')).toEqual({ reasoning_effort: 'high' });
  });

  it('does not pass back reasoning in assistant messages', () => {
    expect(strategy.renderAssistantMessage({ role: 'assistant', content: 'hi', thinking: { content: 't' } }))
      .toEqual({ role: 'assistant', content: 'hi' });
  });
});

describe('anthropic strategy', () => {
  const strategy = getThinkingStrategy('anthropic');

  it('maps disabled/enabled/effort to reasoning effort', () => {
    expect(strategy.toRequestParams('disabled')).toEqual({ reasoning: { effort: 'none' } });
    expect(strategy.toRequestParams('enabled')).toEqual({ reasoning: { effort: 'high' } });
    expect(strategy.toRequestParams('low')).toEqual({ reasoning: { effort: 'low' } });
    expect(strategy.toRequestParams('max')).toEqual({ reasoning: { effort: 'max' } });
    expect(strategy.toRequestParams('xhigh')).toEqual({ reasoning: { effort: 'max' } });
  });

  it('extracts thinking_delta from streaming events', () => {
    expect(strategy.extractStreamReasoning({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'chain' } }))
      .toBe('chain');
    expect(strategy.extractStreamReasoning({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }))
      .toBeUndefined();
  });

  it('extracts thinking blocks from messages', () => {
    expect(strategy.extractMessageReasoning({ content: [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }] }))
      .toEqual({ content: 'a' });
  });
});
