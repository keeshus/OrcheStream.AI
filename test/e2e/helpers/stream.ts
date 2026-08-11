import type { APIRequestContext } from '@playwright/test';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';

/**
 * Execute a flow in debug mode and read all SSE events.
 * Uses native fetch. Pass cookies from the auth state explicitly.
 * NOTE: `_debug: true` must live INSIDE `input` — that is how the frontend's
 * debug overlay marks debug runs (DebugOverlay.tsx) and what the backend
 * checks (input._debug). A body-level flag would silently create a persisted,
 * worker-executed run whose SSE stream only carries execution.started.
 */
export async function debugExecute(
  flowId: string,
  input: Record<string, unknown>,
  cookieHeader?: string,
  abortSignal?: AbortSignal,
): Promise<SSEEvent[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const res = await fetch(`${API_URL}/flows/${flowId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: { _debug: true, ...input }, _debug: true }),
    signal: abortSignal,
  });
  if (!res.ok) throw new Error(`Execute failed: ${res.status}`);
  return readSSE(res, abortSignal);
}

/**
 * Read SSE events from a streaming response, optionally with early cancellation.
 */
export async function readSSE(response: Response, abortSignal?: AbortSignal): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const reader = response.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      if (abortSignal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const evt = JSON.parse(line.slice(6));
            events.push(evt);
            // Allow early termination via custom signal
            if ((evt as any).type === 'execution.paused') return events;
          } catch { /* ignore malformed */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return events;
}

/**
 * Start a persisted (non-debug) execution and return its ID. Persisted runs
 * execute on the worker — the SSE stream only confirms the start, so the
 * execution record must be polled for progress.
 */
export async function executePersisted(
  flowId: string,
  input: Record<string, unknown>,
  cookieHeader?: string,
): Promise<{ executionId: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const res = await fetch(`${API_URL}/flows/${flowId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input, _debug: false }),
  });
  if (!res.ok) throw new Error(`Execute failed: ${res.status}`);

  const startedEvents = await readSSE(res);
  const started = startedEvents.find(e => e.type === 'execution.started');
  if (!started) throw new Error(`Execution did not start. Events: ${JSON.stringify(startedEvents.slice(-3))}`);
  return { executionId: (started as any).executionId || started.data?.executionId || '' };
}

/**
 * Persisted execution (non-debug): waits until the run pauses, then returns.
 * Persisted runs execute on the worker, so the SSE stream only confirms the
 * start — the pause state is polled from the execution record instead.
 * Useful for HITL tests where the execution pauses for approval.
 */
export async function executeUntilPaused(
  flowId: string,
  input: Record<string, unknown>,
  cookieHeader?: string,
): Promise<{ events: SSEEvent[]; executionId: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const res = await fetch(`${API_URL}/flows/${flowId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input, _debug: false }),
  });
  if (!res.ok) throw new Error(`Execute failed: ${res.status}`);

  const startedEvents = await readSSE(res);
  const started = startedEvents.find(e => e.type === 'execution.started');
  if (!started) throw new Error(`Execution did not start. Events: ${JSON.stringify(startedEvents.slice(-3))}`);
  const executionId = (started as any).executionId || started.data?.executionId || '';

  // Poll until the worker pauses the run (HITL → awaiting_approval, delay →
  // running with _delayNodeId metadata).
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const r = await fetch(`${API_URL}/executions/${executionId}`, { headers: { Cookie: cookieHeader || '' } });
    if (r.ok) {
      const exec = await r.json();
      if (exec.status === 'awaiting_approval') return { events: [], executionId };
      if (exec.status === 'running' && exec.output?._delayNodeId) return { events: [], executionId };
      if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'cancelled') {
        throw new Error(`Execution ${executionId} finished without pausing: ${exec.status}${exec.error ? ' — ' + exec.error : ''}`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Execution ${executionId} did not pause within 45s`);
}

/**
 * Poll a persisted execution by ID until it finishes or times out.
 */
export async function pollExecution(
  request: APIRequestContext,
  executionId: string,
  timeoutMs = 30000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request.get(`${API_URL}/executions/${executionId}`);
    if (!res.ok()) throw new Error(`Poll failed: ${res.status()}`);
    const exec = await res.json();
    if (exec.status === 'completed' || exec.status === 'failed' || exec.status === 'cancelled') {
      return exec;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Execution ${executionId} did not complete within ${timeoutMs}ms`);
}

interface SSEEvent {
  type: string;
  data?: any;
}
