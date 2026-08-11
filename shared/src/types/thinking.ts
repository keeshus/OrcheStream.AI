// ── Thinking mode: normalized model-independent abstraction ──────────
// Providers express chain-of-thought reasoning differently (DeepSeek
// `thinking`/`reasoning_effort`, OpenAI `reasoning_effort`, Anthropic
// `reasoning: {effort}`). This module maps a single normalized value to
// what each provider family understands, so the UI and workers stay
// provider-agnostic.

export type ThinkingMode = 'default' | 'disabled' | 'enabled' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ThinkingEndpointKind = 'deepseek' | 'openai' | 'anthropic' | 'generic';

export interface ThinkingEndpoint {
  providerType?: string;
  baseUrl?: string | null;
  models?: string[];
}

/** Classify an endpoint so callers can pick the right mode options / strategy. */
export function endpointThinkingKind(ep: ThinkingEndpoint): ThinkingEndpointKind {
  if (ep.providerType === 'anthropic') return 'anthropic';
  const isDeepseek =
    (ep.baseUrl ?? '').toLowerCase().includes('deepseek') ||
    (ep.models ?? []).some((m: string) => m.toLowerCase().startsWith('deepseek'));
  if (ep.providerType === 'openai' || ep.providerType === 'litellm') {
    return isDeepseek ? 'deepseek' : 'openai';
  }
  return 'generic';
}

export const THINKING_MODE_OPTIONS: Record<ThinkingEndpointKind, ThinkingMode[]> = {
  // DeepSeek: toggle + low/high/xhigh/max effort (docs: api-docs.deepseek.com/guides/thinking_mode)
  deepseek: ['default', 'disabled', 'enabled', 'low', 'high', 'xhigh', 'max'],
  // OpenAI o-series: reasoning_effort low/medium/high (thinking cannot be toggled off)
  openai: ['default', 'low', 'medium', 'high'],
  // Anthropic: reasoning effort none/low/high/max
  anthropic: ['default', 'disabled', 'enabled', 'low', 'high', 'max'],
  // Unknown providers: keep it conservative
  generic: ['default', 'disabled', 'enabled'],
};

export const THINKING_MODE_LABELS: Record<ThinkingMode, string> = {
  default: 'Default (provider)',
  disabled: 'Disabled',
  enabled: 'Enabled (default effort)',
  low: 'Enabled — low effort',
  medium: 'Enabled — medium effort',
  high: 'Enabled — high effort',
  xhigh: 'Enabled — x-high effort',
  max: 'Enabled — max effort',
};
