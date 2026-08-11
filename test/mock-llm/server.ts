// ── Mock OpenAI-compatible LLM API for E2E testing ───────────────
// Run: npx tsx test/mock-llm/server.ts
// Listens on port 3002 by default (override with PORT env)
//
// Supports:
//   - POST /v1/chat/completions (streaming + non-streaming)
//   - GET  /health

import http from 'node:http';
import url from 'node:url';

const PORT = parseInt(process.env.PORT || '3002', 10);

function jsonResponse(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function extractResponse(messages: any[]): string {
  // Collect all system messages
  let fullPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      fullPrompt = msg.content;
      // ECHO_SYSTEM_PROMPT directive: return the full system prompt for verification
      if (fullPrompt.includes('ECHO_SYSTEM_PROMPT')) {
        return fullPrompt;
      }
      // MOCK_RESPONSE directive: return the specified value
      const match = fullPrompt.match(/MOCK_RESPONSE:\s*(.+)/s);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  // Directives may also live in the latest user message (e.g. Co-Pilot panel
  // tests type them directly into the chat input).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && typeof msg.content === 'string') {
      if (msg.content.includes('ECHO_SYSTEM_PROMPT')) {
        return fullPrompt || msg.content;
      }
      const respMatch = msg.content.match(/MOCK_RESPONSE:\s*(.+)/s);
      if (respMatch) return respMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  // Otherwise echo last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return `Mock response to: ${String(messages[i].content).slice(0, 200)}`;
    }
  }
  return 'Mock response (no user message found)';
}

function generateDummyJson(schema: any): Record<string, unknown> {
  const dummy: Record<string, unknown> = {};
  if (schema?.properties) {
    for (const [key, val] of Object.entries<any>(schema.properties)) {
      if (val.type === 'string') dummy[key] = `mock_${key}`;
      else if (val.type === 'number') dummy[key] = 42;
      else if (val.type === 'boolean') dummy[key] = true;
      else if (val.type === 'array') dummy[key] = [];
      else dummy[key] = null;
    }
  }
  return dummy;
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url || '', true);
  const path = parsed.pathname || '';

  // GET /health
  if (req.method === 'GET' && path === '/health') {
    jsonResponse(res, 200, { status: 'ok', service: 'mock-llm' });
    return;
  }

  // POST /v1/chat/completions
  if (req.method === 'POST' && path === '/v1/chat/completions') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let params: any = {};
    try { params = JSON.parse(body); } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const { model, messages, stream, response_format, tools, thinking, reasoning_effort } = params;

    // Capture reasoning pass-back: the reasoning_content the engine echoes back
    // on the last assistant message (DeepSeek-style thinking-mode requirement).
    let assistantReasoningPassback: string | undefined;
    for (const msg of messages || []) {
      if (msg.role === 'assistant' && typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
        assistantReasoningPassback = msg.reasoning_content;
      }
    }

    // ECHO_PARAMS directive: return a JSON dump of the request's thinking
    // params so tests can assert what the engine actually sent. Lives in a
    // system prompt or the latest user message (AI Action sends no system
    // prompt, so tests put it in the prompt itself).
    let echoParams = false;
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'system' && typeof msg.content === 'string' && msg.content.includes('ECHO_PARAMS')) {
        echoParams = true;
      }
    }
    const lastMsg = messages?.[messages.length - 1];
    if (!echoParams && lastMsg?.role === 'user' && typeof lastMsg.content === 'string' && lastMsg.content.includes('ECHO_PARAMS')) {
      echoParams = true;
    }
    if (echoParams) {
      const paramsDump = JSON.stringify({
        thinking: thinking ?? null,
        reasoning_effort: reasoning_effort ?? null,
        reasoning_passback: assistantReasoningPassback ?? null,
      });
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ id: `mock_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: `mock_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: paramsDump }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      jsonResponse(res, 200, {
        id: `mock_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: paramsDump }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return;
    }

    // Check for MOCK_TOOL_CALL directive in system prompt
    // Only trigger on first call — if conversation already has tool results, return text instead
    let toolToCall: string | null = null;
    let toolArgs: string = '{}';
    let hasToolResults = false;
    for (const msg of messages || []) {
      if (msg.role === 'user' && typeof msg.content === 'string' &&
          (msg.content.startsWith('Tool result for') || msg.content.startsWith('Tool result ('))) {
        hasToolResults = true;
        break;
      }
    }
    if (!hasToolResults) {
      for (const msg of messages || []) {
        if (msg.role === 'system' && typeof msg.content === 'string') {
          const match = msg.content.match(/MOCK_TOOL_CALL:\s*(\S+)(?:\s+({.+}))?/);
          if (match) {
            toolToCall = match[1];
            if (match[2]) toolArgs = match[2];
          }
        }
        if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('MOCK_TOOL_CALL:')) {
          const match = msg.content.match(/MOCK_TOOL_CALL:\s*(\S+)(?:\s+({.+}))?/);
          if (match) {
            toolToCall = match[1];
            if (match[2]) toolArgs = match[2];
          }
        }
      }
    }

    // MOCK_THINKING_TOOL_CALL directive: first call emits reasoning_content +
    // a tool call; the follow-up call (tool results present) reports whether the
    // engine passed reasoning_content back on the assistant message.
    const THINKING_CONTENT = 'Mock chain of thought for thinking test';
    let thinkingToolCall: string | null = null;
    let thinkingToolArgs: string = '{}';
    for (const msg of messages || []) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        const match = msg.content.match(/MOCK_THINKING_TOOL_CALL:\s*(\S+)(?:\s+({.+}))?/);
        if (match) {
          thinkingToolCall = match[1];
          if (match[2]) thinkingToolArgs = match[2];
        }
      }
    }
    if (thinkingToolCall && hasToolResults) {
      // Round 2: verify the reasoning pass-back reached this request.
      toolToCall = null;
      thinkingToolCall = null;
      const passback = assistantReasoningPassback || 'MISSING';
      const mockContent = `THINKING_PASSBACK=${passback}`;
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ id: `mock_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: `mock_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: mockContent }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      jsonResponse(res, 200, {
        id: `mock_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: mockContent }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return;
    }

    const mockContent = extractResponse(messages || []);

    const responseId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      // SSE streaming
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (thinkingToolCall) {
        // Stream a tool call response with a reasoning phase first
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(thinkingToolArgs); } catch { args = {}; }
        const argStr = JSON.stringify(args);
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: THINKING_CONTENT }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: thinkingToolCall, arguments: '' } }] } }] })}\n\n`);
        // Stream arguments in chunks
        for (let i = 0; i < argStr.length; i += 50) {
          res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + 50) } }] } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else if (toolToCall) {
        // Stream a tool call response
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(toolArgs); } catch { args = {}; }
        const argStr = JSON.stringify(args);
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: toolToCall, arguments: '' } }] } }] })}\n\n`);
        // Stream arguments in chunks
        for (let i = 0; i < argStr.length; i += 50) {
          res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(i, i + 50) } }] } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        const content = String(mockContent);
        const tokens = content.split(/(\s+)/);
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        for (const token of tokens) {
          res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: token }, finish_reason: null }] })}\n\n`);
          await new Promise(r => setTimeout(r, 2));
        }
        res.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Non-streaming
    const response: any = {
      id: responseId,
      object: 'chat.completion',
      created,
      model: model || 'mock-model',
      choices: [{
        index: 0,
        message: { role: 'assistant' },
        finish_reason: toolToCall ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    if (thinkingToolCall) {
      // Return a tool call with a reasoning phase instead of text
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(thinkingToolArgs); } catch { args = {}; }
      response.choices[0].message.content = null;
      response.choices[0].message.reasoning_content = THINKING_CONTENT;
      response.choices[0].message.tool_calls = [{
        index: 0,
        id: `call_${Date.now()}`,
        type: 'function',
        function: {
          name: thinkingToolCall,
          arguments: JSON.stringify(args),
        },
      }];
    } else if (toolToCall) {
      // Return a tool call instead of text
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(toolArgs); } catch { args = {}; }
      response.choices[0].message.content = null;
      response.choices[0].message.tool_calls = [{
        index: 0,
        id: `call_${Date.now()}`,
        type: 'function',
        function: {
          name: toolToCall,
          arguments: JSON.stringify(args),
        },
      }];
    } else {
      response.choices[0].message.content = mockContent;
    }

    // If json_object response requested, try to parse mockContent as JSON
    if (response_format?.type === 'json_object') {
      try {
        const parsed = JSON.parse(mockContent);
        response.choices[0].message.content = JSON.stringify(parsed);
      } catch {
        // Return plain text content as-is
      }
    }

    jsonResponse(res, 200, response);
    return;
  }

  // POST /v1/embeddings — return fixed mock embeddings
  if (req.method === 'POST' && path === '/v1/embeddings') {
    let body = '';
    for await (const chunk of req) body += chunk;

    let params: any = {};
    try { params = JSON.parse(body); } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const input = params.input || '';
    const inputs = Array.isArray(input) ? input : [input];

    const data = inputs.map((text: string, i: number) => ({
      object: 'embedding',
      index: i,
      // Return a deterministic fake embedding vector (1536 dimensions)
      embedding: Array.from({ length: 1536 }, (_, j) => (text.charCodeAt(j % text.length || 0) || 0) / 255),
    }));

    jsonResponse(res, 200, {
      object: 'list',
      data,
      model: params.model || 'mock-embedding-model',
      usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    });
    return;
  }

  jsonResponse(res, 404, { error: 'Not found', path });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock LLM API listening on http://0.0.0.0:${PORT}`);
});
