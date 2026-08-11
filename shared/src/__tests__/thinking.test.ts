import { describe, it, expect } from 'vitest';
import { endpointThinkingKind, THINKING_MODE_OPTIONS } from '../types/thinking.js';

describe('endpointThinkingKind', () => {
  it('classifies anthropic endpoints', () => {
    expect(endpointThinkingKind({ providerType: 'anthropic', baseUrl: null })).toBe('anthropic');
  });

  it('classifies DeepSeek-backed OpenAI endpoints', () => {
    expect(endpointThinkingKind({ providerType: 'openai', baseUrl: 'https://api.deepseek.com' })).toBe('deepseek');
    expect(endpointThinkingKind({ providerType: 'litellm', baseUrl: null, models: ['deepseek-v4-pro'] })).toBe('deepseek');
  });

  it('classifies plain OpenAI endpoints', () => {
    expect(endpointThinkingKind({ providerType: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o'] })).toBe('openai');
    expect(endpointThinkingKind({ providerType: 'litellm', baseUrl: null })).toBe('openai');
  });

  it('falls back to generic for unknown providers', () => {
    expect(endpointThinkingKind({ providerType: 'gemini', baseUrl: null })).toBe('generic');
    expect(endpointThinkingKind({})).toBe('generic');
  });
});

describe('THINKING_MODE_OPTIONS', () => {
  it('offers effort levels per provider family', () => {
    expect(THINKING_MODE_OPTIONS.deepseek).toEqual(['default', 'disabled', 'enabled', 'low', 'high', 'xhigh', 'max']);
    expect(THINKING_MODE_OPTIONS.openai).toEqual(['default', 'low', 'medium', 'high']);
    expect(THINKING_MODE_OPTIONS.anthropic).toEqual(['default', 'disabled', 'enabled', 'low', 'high', 'max']);
  });
});
