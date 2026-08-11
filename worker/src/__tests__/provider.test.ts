import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callLLMGeneric } from '../providers/provider.js';
import type { LLMCallParams } from '../providers/provider.js';

vi.mock('openai', () => ({ default: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const baseParams: LLMCallParams = {
  apiKey: 'sk-test-key',
  model: 'test-model',
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello!' }],
  temperature: 0.7,
};

function mockOpenAI(client: object) {
  vi.mocked(OpenAI).mockImplementation(function () {
    return client as any;
  });
}

function mockAnthropic(client: object) {
  vi.mocked(Anthropic).mockImplementation(function () {
    return client as any;
  });
}

describe('callLLMGeneric', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws for unknown provider type', async () => {
    await expect(callLLMGeneric(baseParams, 'unknown')).rejects.toThrow(
      'Unknown provider type: unknown',
    );
  });

  describe('OpenAI non-streaming', () => {
    it('returns text response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Hello from OpenAI', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'openai');
      expect(result.text).toBe('Hello from OpenAI');
      expect(result.toolCalls).toBeUndefined();
    });

    it('returns response with tool calls', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"London"}' },
              },
            ],
          },
        }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'openai');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('get_weather');
      expect(result.toolCalls![0].input).toEqual({ city: 'London' });
    });

    it('handles invalid JSON in tool call arguments', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'bad_tool', arguments: 'not-json' },
              },
            ],
          },
        }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'openai');
      expect(result.toolCalls![0].input).toEqual({});
    });

    it('passes tools in the request', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const tools = [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } }];
      await callLLMGeneric({ ...baseParams, tools }, 'openai');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'get_weather' }) }),
          ]),
          tool_choice: 'auto',
        }),
      );
    });

    it('pins a high max_tokens so providers do not truncate long outputs', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      await callLLMGeneric(baseParams, 'openai');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 32000 }),
      );
    });

    it('surfaces finish_reason from a non-streaming response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'cut off', tool_calls: undefined }, finish_reason: 'length' }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'openai');
      expect(result.finishReason).toBe('length');
    });

    it('omits thinking params by default', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      await callLLMGeneric(baseParams, 'openai');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.not.objectContaining({ reasoning_effort: expect.anything(), thinking: expect.anything() }),
      );
    });

    it('sends reasoning_effort for standard OpenAI (o-series) effort levels', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      for (const effort of ['low', 'medium', 'high']) {
        mockCreate.mockClear();
        await callLLMGeneric({ ...baseParams, thinkingMode: effort as any }, 'openai');
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({ reasoning_effort: effort }),
        );
        expect(mockCreate).toHaveBeenCalledWith(
          expect.not.objectContaining({ thinking: expect.anything() }),
        );
      }
    });

    it('sends thinking disabled for DeepSeek endpoints', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const deepseekParams = { ...baseParams, baseUrl: 'https://api.deepseek.com' };
      await callLLMGeneric({ ...deepseekParams, thinkingMode: 'disabled' }, 'openai');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ thinking: { type: 'disabled' } }),
      );
    });

    it('sends thinking enabled plus reasoning_effort for DeepSeek effort levels', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const deepseekParams = { ...baseParams, baseUrl: 'https://api.deepseek.com' };
      for (const effort of ['low', 'high', 'xhigh', 'max']) {
        mockCreate.mockClear();
        await callLLMGeneric({ ...deepseekParams, thinkingMode: effort as any }, 'openai');
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            reasoning_effort: effort,
            thinking: { type: 'enabled' },
          }),
        );
      }
    });

    it('echoes reasoning_content back for DeepSeek when a thinking payload is attached', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const deepseekParams = { ...baseParams, baseUrl: 'https://api.deepseek.com' };
      await callLLMGeneric({
        ...deepseekParams,
        messages: [{ role: 'assistant', content: 'let me check', thinking: { content: 'I need to call a tool' } }],
      }, 'openai');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', content: 'let me check', reasoning_content: 'I need to call a tool' }),
          ]),
        }),
      );
    });

    it('does not echo reasoning back for non-DeepSeek endpoints', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'ok', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      await callLLMGeneric({
        ...baseParams,
        messages: [{ role: 'assistant', content: 'let me check', thinking: { content: 'secret chain of thought' } }],
      }, 'openai');
      const args = mockCreate.mock.calls[0][0] as any;
      expect(JSON.stringify(args)).not.toContain('reasoning_content');
    });

    it('returns reasoning payload from a non-streaming response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Final answer', reasoning_content: 'Let me think...', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'openai');
      expect(result.text).toBe('Final answer');
      expect(result.reasoning?.content).toBe('Let me think...');
    });

    it('returns text response without system prompt', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'no system prompt', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric({ ...baseParams, systemPrompt: '' }, 'openai');
      expect(result.text).toBe('no system prompt');
    });

    it('handles tool call with missing function name', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { arguments: '{}' } },
            ],
          },
        }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'openai');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('');
    });
  });

  describe('OpenAI streaming', () => {
    it('accumulates text chunks', async () => {
      async function* generate() {
        yield { choices: [{ delta: { content: 'Hello' } }] };
        yield { choices: [{ delta: { content: ' world' } }] };
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const onToken = vi.fn();
      const result = await callLLMGeneric({ ...baseParams, onToken }, 'openai');
      expect(result.text).toBe('Hello world');
      expect(onToken).toHaveBeenCalledTimes(2);
    });

    it('accumulates reasoning_content from streaming chunks', async () => {
      async function* generate() {
        yield { choices: [{ delta: { reasoning_content: 'Let me' } }] };
        yield { choices: [{ delta: { reasoning_content: ' think...' } }] };
        yield { choices: [{ delta: { content: 'Done' } }] };
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric({ ...baseParams, onToken: vi.fn() }, 'openai');
      expect(result.text).toBe('Done');
      expect(result.reasoning?.content).toBe('Let me think...');
    });

    it('accumulates tool calls from streaming chunks', async () => {
      const tc1 = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }] };
      const tc2 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }] } }] };
      const tc3 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'London"}' } }] } }] };
      async function* generate() {
        yield tc1;
        yield tc2;
        yield tc3;
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric({ ...baseParams, onToken: vi.fn() }, 'openai');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('get_weather');
      expect(result.toolCalls![0].input).toEqual({ city: 'London' });
    });

    it('handles invalid JSON in streamed tool args', async () => {
      async function* generate() {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bad_tool', arguments: 'not-json' } }] } }] };
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric({ ...baseParams, onToken: vi.fn() }, 'openai');
      expect(result.toolCalls![0].input).toEqual({});
    });

    it('surfaces finish_reason from streaming chunks', async () => {
      async function* generate() {
        yield { choices: [{ delta: { content: 'partial answer' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'length' }] };
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric({ ...baseParams, onToken: vi.fn() }, 'openai');
      expect(result.text).toBe('partial answer');
      expect(result.finishReason).toBe('length');
    });
  });

  describe('Anthropic non-streaming', () => {
    it('returns text response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Hello from Claude' }],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      const result = await callLLMGeneric(baseParams, 'anthropic');
      expect(result.text).toBe('Hello from Claude');
    });

    it('returns response with tool calls', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'London' } },
        ],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      const result = await callLLMGeneric(baseParams, 'anthropic');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('get_weather');
      expect(result.toolCalls![0].input).toEqual({ city: 'London' });
    });

    it('returns text only when there are no tool calls', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: 'Just text, no tools.' },
        ],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      const result = await callLLMGeneric(baseParams, 'anthropic');
      expect(result.text).toBe('Just text, no tools.');
      expect(result.toolCalls).toBeUndefined();
    });

    it('passes tools in the request for Anthropic', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      const tools = [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } }];
      await callLLMGeneric({ ...baseParams, tools }, 'anthropic');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {} } }),
          ]),
        }),
      );
    });

    it('maps thinking modes to Anthropic reasoning effort', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      await callLLMGeneric({ ...baseParams, thinkingMode: 'disabled' }, 'anthropic');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: 'none' } }),
      );

      mockCreate.mockClear();
      await callLLMGeneric({ ...baseParams, thinkingMode: 'high' }, 'anthropic');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: 'high' } }),
      );
    });

    it('extracts thinking blocks from an Anthropic response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [
          { type: 'thinking', thinking: 'Let me reason about this.' },
          { type: 'text', text: 'Here is the answer.' },
        ],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      const result = await callLLMGeneric(baseParams, 'anthropic');
      expect(result.text).toBe('Here is the answer.');
      expect(result.reasoning?.content).toBe('Let me reason about this.');
    });

    it('returns text response without system prompt for Anthropic', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'no system' }],
      });
      mockAnthropic({ messages: { create: mockCreate } });

      const result = await callLLMGeneric({ ...baseParams, systemPrompt: '' }, 'anthropic');
      expect(result.text).toBe('no system');
    });
  });

  describe('Anthropic streaming', () => {
    it('accumulates text chunks', async () => {
      async function* generate() {
        yield { type: 'content_block_start', content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Claude' } };
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockAnthropic({ messages: { create: mockCreate } });

      const onToken = vi.fn();
      const result = await callLLMGeneric({ ...baseParams, onToken }, 'anthropic');
      expect(result.text).toBe('Hello Claude');
      expect(onToken).toHaveBeenCalledTimes(2);
    });

    it('accumulates tool calls from streaming events', async () => {
      const evt1 = { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } };
      const evt2 = { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"city":"' } };
      const evt3 = { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'London"}' } };
      async function* generate() {
        yield evt1;
        yield evt2;
        yield evt3;
      }
      const mockCreate = vi.fn().mockResolvedValue(generate());
      mockAnthropic({ messages: { create: mockCreate } });

      const result = await callLLMGeneric({ ...baseParams, onToken: vi.fn() }, 'anthropic');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('get_weather');
      expect(result.toolCalls![0].input).toEqual({ city: 'London' });
    });
  });

  describe('litellm', () => {
    it('uses OpenAI adapter and returns response', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'from litellm', tool_calls: undefined } }],
      });
      mockOpenAI({ chat: { completions: { create: mockCreate } } });

      const result = await callLLMGeneric(baseParams, 'litellm');
      expect(result.text).toBe('from litellm');
    });
  });
});