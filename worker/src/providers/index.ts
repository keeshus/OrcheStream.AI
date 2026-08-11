import { callLLMGeneric, type ToolDefinition, type LLMResponse } from './provider.js';
import type { ThinkingMode } from 'orchestream-ai-shared';
import type { ConversationMessage } from './thinking.js';

export interface LLMCallParams {
  endpointId: string;
  model: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  temperature: number;
  onToken?: (token: string) => void;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  thinkingMode?: ThinkingMode;
}

export interface ResolvedEndpoint {
  providerType: 'anthropic' | 'openai' | 'litellm';
  apiKey: string;
  baseUrl: string | null;
}

export type { LLMResponse, ToolDefinition };

export async function callLLM(params: LLMCallParams, endpoint: ResolvedEndpoint): Promise<LLMResponse> {
  return callLLMGeneric(
    {
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl || undefined,
      model: params.model,
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      temperature: params.temperature,
      onToken: params.onToken,
      tools: params.tools,
      signal: params.signal,
      thinkingMode: params.thinkingMode,
    },
    endpoint.providerType,
  );
}
