import { useEffect, useState, useRef, useCallback } from 'react';
import { Icon } from '@/components/ui/Icon';
import { SelectField } from '@/components/ui/SelectField';
import { StepCard } from '@/components/flow/StepCard';
import { EnvOverridesSection, type EnvOverridesPayload } from '@/components/ui/EnvOverridesSection';

interface DebugOverlayProps {
  flowId: string;
  onClose: () => void;
  nodes?: any[];
  edges?: any[];
}

interface StepEvent {
  type: string;
  executionId?: string;
  nodeId?: string;
  data: Record<string, any>;
  timestamp: string;
  hierarchy?: { path: string; depth: number };
}

interface StepInfo {
  nodeId: string;
  nodeType: string;
  nodeLabel?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input: any;
  output: any;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  tokens: string[];
  iteration?: number;
  children?: Array<{ nodeId: string; type: string; output?: any; error?: string; status: string }>;
  hierarchy?: { path: string; depth: number };
}

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}



const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

const TRIGGER_CONFIG: Record<string, { label: string; icon: string; description: string }> = {
  manual: { label: 'Manual', icon: 'terminal', description: 'Send a message to trigger the flow' },
  chat: { label: 'Chat', icon: 'sms', description: 'Send a chat message with optional history' },
  webhook: { label: 'Webhook', icon: 'webhook', description: 'Provide a JSON payload as the webhook body' },
  schedule: { label: 'Schedule', icon: 'calendar_today', description: 'Trigger the flow with a message (simulates scheduled run)' },
  subflow: { label: 'Subflow', icon: 'call_split', description: 'Send a message to test this subflow standalone' },
};

export function DebugOverlay({ flowId, onClose, nodes: canvasNodes, edges: canvasEdges }: DebugOverlayProps) {
  const [flow, setFlow] = useState<any>(null);
  const [loadingFlow, setLoadingFlow] = useState(true);
  const [triggerType, setTriggerType] = useState<string>('manual');
  const [chatMessage, setChatMessage] = useState('Hello! This is a debug run.');
  const [chatHistory, setChatHistory] = useState<HistoryEntry[]>([]);
  const [manualMessage, setManualMessage] = useState('');
  const [webhookPayload, setWebhookPayload] = useState('{\n  "event": "test",\n  "data": {}\n}');
  const [webhookPayloadError, setWebhookPayloadError] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [finalOutput, setFinalOutput] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [hitlPause, setHitlPause] = useState<{ executionId: string; prompt: string; buttons: { label: string; value: string; icon?: string }[]; nodeId: string; allowFeedback?: boolean } | null>(null);
  const [hitlFeedback, setHitlFeedback] = useState('');
  const [envOverrides, setEnvOverrides] = useState<EnvOverridesPayload | undefined>(undefined);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Use canvas nodes if provided, otherwise fetch from API
    const resolveNodes = async () => {
      const nodes = canvasNodes || await fetch(`${API_URL}/flows/${flowId}`).then(res => res.json()).then(f => f.nodes || []).catch(() => []);
      setFlow({ nodes });
      const trigger = nodes.find((n: any) => n.type === 'trigger' || n.data?.type === 'trigger');
      if (trigger) {
        const tt = trigger.data?.config?.triggerType || 'manual';
        setTriggerType(tt);
        if (tt === 'webhook' && trigger.data?.config?.inputSchema) {
          try {
            const schema = JSON.parse(trigger.data.config.inputSchema);
            setWebhookPayload(JSON.stringify(schema, null, 2));
          } catch {}
        }
      }
      setLoadingFlow(false);
    };
    resolveNodes();
  }, [flowId, canvasNodes]);

  const toggle = (id: string) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStatus('failed');
    setError('Cancelled by user');
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  const buildInput = useCallback(() => {
    if (triggerType === 'chat') {
      return { chat_input: { message: chatMessage, history: chatHistory }, message: chatMessage, history: chatHistory };
    }
    if (triggerType === 'webhook') {
      try { return JSON.parse(webhookPayload); } catch { return { payload: webhookPayload }; }
    }
    return { message: manualMessage };
  }, [triggerType, chatMessage, chatHistory, manualMessage, webhookPayload]);

  const run = useCallback(async () => {
    // Load the current flow from the canvas for the debug run
    const runNodes = canvasNodes;
    const runEdges = canvasEdges;

    if (!runNodes || !runEdges || runNodes.length === 0) {
      setError('No flow to execute — add nodes to the canvas first');
      setStatus('failed');
      return;
    }

    // Pre-populate steps from canvas nodes (sorted by topological order) so all nodes are visible immediately
    const topoOrder = (() => {
      const inDeg = new Map<string, number>();
      const adj = new Map<string, string[]>();
      for (const n of runNodes) { inDeg.set(n.id, 0); adj.set(n.id, []); }
      for (const e of runEdges) {
        adj.get(e.source)?.push(e.target);
        inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
      }
      const q: string[] = [];
      for (const [id, deg] of inDeg) { if (deg === 0) q.push(id); }
      const order: string[] = [];
      while (q.length > 0) {
        const id = q.shift()!;
        order.push(id);
        for (const n of adj.get(id) || []) {
          const d = (inDeg.get(n) || 1) - 1;
          inDeg.set(n, d);
          if (d === 0) q.push(n);
        }
      }
      return new Map(order.map((id, i) => [id, i]));
    })();

    setSteps(runNodes
      .filter((n: any) => n.data?.type)
      .sort((a: any, b: any) => (topoOrder.get(a.id) ?? 999) - (topoOrder.get(b.id) ?? 999))
      .map((n: any) => ({
        nodeId: n.id,
        nodeType: n.data?.type || 'unknown',
        nodeLabel: n.data?.label || n.data?.type || '',
        status: 'pending' as const,
        input: {} as any,
        output: null,
        error: null,
        startedAt: '' as string,
                completedAt: null as string | null,
        tokens: [] as string[],
        iteration: 0,
        children: undefined as any,
      }))
    );
    setFinalOutput(null);
    setError(null);
    setHitlPause(null);
    setHitlFeedback('');
    setStatus('running');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const input = buildInput();
      const body: any = { input: { _debug: true, ...input } };
      // Always send the latest flow from the editor canvas
      if (canvasNodes) body.nodes = canvasNodes;
      if (canvasEdges) body.edges = canvasEdges;
      if (envOverrides && Object.keys(envOverrides).length > 0) body.envOverrides = envOverrides;
      const res = await fetch(`${API_URL}/flows/${flowId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (controller.signal.aborted) { reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: StepEvent;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (!event) continue;

          const d = event.data || {};
          const nodeId = event.nodeId || d.nodeId || '';

          if (event.type === 'step.started') {
            setSteps(prev => {
              const existing = prev.findIndex(s => s.nodeId === nodeId);
              const step = {
                nodeId,
                nodeType: d.nodeType || '',
                nodeLabel: d.nodeLabel || '',
                status: 'running' as const,
                input: d.input,
                output: null,
                error: null,
                startedAt: event.timestamp,
                completedAt: null as string | null,
                tokens: [] as string[],
                iteration: d.iteration ?? 0,
                children: undefined as any,
              };
              if (existing >= 0) {
                const updated = [...prev];
                updated[existing] = step;
                return updated;
              }
              return [...prev, step];
            });
          } else if (event.type === 'stream.token') {
            setSteps(prev => prev.map(s =>
              s.nodeId === nodeId && s.status === 'running'
                ? { ...s, tokens: [...s.tokens, d.token || ''] }
                : s
            ));
          } else if (event.type === 'step.completed') {
            setSteps(prev => prev.map(s =>
              s.nodeId === nodeId ? { ...s, status: 'completed', output: d.output, completedAt: event.timestamp } : s
            ));
          } else if (event.type === 'step.failed') {
            setSteps(prev => prev.map(s =>
              s.nodeId === nodeId ? { ...s, status: 'failed', error: d.error || null, completedAt: event.timestamp } : s
            ));
          } else if (event.type === 'step.skipped') {
            setSteps(prev => prev.map(s =>
              s.nodeId === nodeId ? { ...s, status: 'skipped', completedAt: event.timestamp } : s
            ));
          } else if (event.type === 'log' && d.subNodeId) {
            setSteps(prev => prev.map(s => {
              if (s.nodeId !== nodeId || s.nodeType !== 'parallel') return s;
              const existing = s.children || [];
              const child = { nodeId: d.subNodeId, type: d.subNodeType, output: d.output, error: d.error, status: d.status };
              return { ...s, children: [...existing.filter(c => c.nodeId !== d.subNodeId), child] };
            }));
          } else if (event.type === 'execution.completed') {
            // Extract just the output node's value from the accumulated result
            let outputValue = d.output;
            let outputNodeId: string | undefined;
            if (canvasNodes && d.output && typeof d.output === 'object') {
              // First try: look up output nodes by their canvas ID in the result
              for (const n of canvasNodes) {
                if (n.data?.type === 'output' && d.output[n.id] !== undefined) {
                  const val = d.output[n.id];
                  // Skip output nodes that were not executed (skipped)
                  if (typeof val === 'object' && val !== null && val.skipped === true) continue;
                  outputValue = val;
                  outputNodeId = n.id;
                  break;
                }
              }
              // Second try: use the output from the engine's last step
              if (!outputNodeId && d.steps) {
                for (const s of d.steps) {
                  if ((s.nodeType || s.node_type) === 'output' && s.output !== undefined) {
                    outputValue = s.output;
                    outputNodeId = s.nodeId || s.node_id;
                    break;
                  }
                }
              }
              // Fallback: grab the last non-__input__ entry
              if (!outputNodeId) {
                const entries = Object.entries(d.output).filter(([k]) => k !== '__input__');
                if (entries.length > 0) {
                  const [lastKey, lastVal] = entries[entries.length - 1];
                  outputValue = lastVal;
                  // Try to find an output node without a matching result key
                  for (const n of canvasNodes) {
                    if (n.data?.type === 'output') {
                      outputNodeId = n.id;
                      break;
                    }
                  }
                  if (!outputNodeId) outputNodeId = lastKey;
                }
              }
            }
            setFinalOutput(outputValue);
            setStatus('completed');
            // Fallback: add any missing steps from engine result + all output nodes
            setSteps(prev => {
              const existingIds = new Set(prev.map(s => s.nodeId));
              const toAdd: any[] = [];
              if (d.steps) {
                for (const s of d.steps) {
                  const nid = s.nodeId || s.node_id;
                  if (nid && !existingIds.has(nid)) {
                    existingIds.add(nid);
                    toAdd.push({
                      nodeId: nid,
                      nodeType: s.nodeType || s.node_type || 'unknown',
                      nodeLabel: s.nodeLabel || s.node_label || '',
                      status: s.status || 'completed',
                      input: s.input,
                      output: s.output,
                      error: s.error || null,
                      startedAt: s.startedAt || s.started_at,
                      completedAt: s.completedAt || s.completed_at,
                      tokens: s.tokens || [],
                      iteration: s.iteration ?? 0,
                      children: s.children,
                    });
                  }
                }
              }
              // Ensure all nodes from the canvas appear in steps (sorted topologically)
              if (canvasNodes && canvasEdges && toAdd.length > 0) {
                // Compute topological order
                const inDegree = new Map<string, number>();
                const adj = new Map<string, string[]>();
                for (const n of canvasNodes) {
                  inDegree.set(n.id, 0);
                  adj.set(n.id, []);
                }
                for (const e of canvasEdges) {
                  adj.get(e.source)?.push(e.target);
                  inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
                }
                const queue: string[] = [];
                for (const [id, deg] of inDegree) {
                  if (deg === 0) queue.push(id);
                }
                const topoOrder: string[] = [];
                while (queue.length > 0) {
                  const id = queue.shift()!;
                  topoOrder.push(id);
                  for (const neighbor of adj.get(id) || []) {
                    const newDeg = (inDegree.get(neighbor) || 1) - 1;
                    inDegree.set(neighbor, newDeg);
                    if (newDeg === 0) queue.push(neighbor);
                  }
                }
                // Sort toAdd by topological order
                const orderMap = new Map(topoOrder.map((id, i) => [id, i]));
                toAdd.sort((a, b) => (orderMap.get(a.nodeId) ?? 999) - (orderMap.get(b.nodeId) ?? 999));
              }
              // Ensure output nodes appear in steps (fallback for missing SSE events)
              if (canvasNodes) {
                for (const n of canvasNodes) {
                  if (n.data?.type !== 'output' || existingIds.has(n.id)) continue;
                  existingIds.add(n.id);
                  const stepInputData = d.output && typeof d.output === 'object'
                    ? Object.fromEntries(Object.entries(d.output).filter(([k]) => k !== n.id && k !== '__input__'))
                    : {};
                  toAdd.push({
                    nodeId: n.id,
                    nodeType: 'output',
                    nodeLabel: n.data?.label || 'Output',
                    status: 'completed',
                    input: stepInputData,
                    output: n.id === outputNodeId ? outputValue : d.output?.[n.id],
                    selectedField: n.data?.config?.inputFields?.[0],
                    error: null,
                    startedAt: '',
                    completedAt: null,
                    tokens: [],
                    iteration: 0,
                    children: undefined,
                  });
                }
              }
              return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
            });
          } else if (event.type === 'subflow.started') {
            setSteps(prev => [...prev, {
              nodeId,
              nodeType: 'subflow',
              nodeLabel: d.subflowLabel || 'Subflow',
              status: 'running' as const,
              input: d.input,
              output: null,
              error: null,
              startedAt: event.timestamp,
              completedAt: null,
              tokens: [],
              iteration: d.iteration ?? 0,
              children: [],
              hierarchy: event.hierarchy,
            }]);
          } else if (event.type === 'subflow.completed') {
            setSteps(prev => prev.map(s =>
              s.nodeId === nodeId ? { ...s, status: 'completed', output: d.output, completedAt: event.timestamp } : s
            ));
          } else if (event.type === 'subflow.failed') {
            setSteps(prev => prev.map(s =>
              s.nodeId === nodeId ? { ...s, status: 'failed', error: (d.error as string) || null, completedAt: event.timestamp } : s
            ));
          } else if (event.type === 'execution.paused') {
            setHitlPause({
              executionId: event.executionId || '',
              prompt: d.prompt || 'Waiting for approval',
              buttons: d.buttons || [{ label: 'Approve', value: 'approved', icon: 'check_circle' }, { label: 'Reject', value: 'rejected', icon: 'cancel' }],
              nodeId: d.nodeId || '',
              allowFeedback: d.allowFeedback !== false,
            });
            setHitlFeedback('');
            setStatus('completed');
          } else if (event.type === 'execution.failed') {
            setError(d.error || 'Execution failed');
            setStatus('failed');
          }
        }
      }
    } catch (err: any) {
      setError(err.message || 'Execution error');
      setStatus('failed');
    }
  }, [flowId, buildInput, envOverrides]);

  const handleHitlApprove = useCallback(async (decision: string) => {
    if (!hitlPause) return;
    setHitlPause(null);
    setStatus('running');
    try {
      const res = await fetch(`${API_URL}/executions/${hitlPause.executionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ decision, feedback: hitlFeedback, hitlNodeId: hitlPause.nodeId }),
      });
      const result = await res.json();
      if (result.status === 'completed') {
        // Debug runs stream no events during resume — the response carries
        // the finished steps and final output directly. The in-memory steps
        // carry no node labels, so resolve them from the canvas.
        if (result.steps) {
          const labelOf = (id: string) => canvasNodes?.find((n: any) => n.id === id)?.data?.label || '';
          const mappedSteps: StepInfo[] = result.steps.map((s: any) => ({
            nodeId: s.node_id ?? s.nodeId,
            nodeType: s.node_type ?? s.nodeType,
            nodeLabel: s.node_label ?? s.nodeLabel ?? labelOf(s.node_id ?? s.nodeId),
            status: s.status,
            input: s.input,
            output: s.output,
            error: s.error || null,
            startedAt: s.started_at ?? s.startedAt,
            completedAt: s.completed_at ?? s.completedAt,
            tokens: s.tokens || [],
            iteration: s.iteration ?? 0,
            children: s.children,
          }));
          setSteps(mappedSteps);
        }
        setFinalOutput(result.output);
        setStatus('completed');
      } else if (result.status === 'paused') {
        // Another HITL node paused during the resumed run — show it.
        setHitlPause({
          executionId: result.executionId || hitlPause.executionId,
          prompt: result.prompt || 'Waiting for approval',
          buttons: result.buttons || hitlPause.buttons,
          nodeId: result.nodeId || '',
          allowFeedback: result.allowFeedback !== false,
        });
        setHitlFeedback('');
        setStatus('completed');
      } else if (result.status === 'failed') {
        setError(result.error || 'Execution failed');
        setStatus('failed');
      } else if (result.status === 'completed' || result.status === 'running') {
        // Persisted-run path: the approve response only confirms the resume —
        // the execution record carries the outcome.
        const detail = await fetch(`${API_URL}/flows/${flowId}/executions/${hitlPause.executionId}`, { credentials: 'include' });
        const data = await detail.json();
        if (data.steps) {
          const mappedSteps: StepInfo[] = data.steps.map((s: any) => ({
            nodeId: s.node_id,
            nodeType: s.node_type,
            nodeLabel: s.node_label,
            status: s.status,
            input: s.input,
            output: s.output,
            error: s.error || null,
            startedAt: s.started_at,
            completedAt: s.completed_at,
            tokens: s.tokens || [],
            iteration: s.iteration ?? 0,
            children: s.children,
          }));
          setSteps(mappedSteps);
        }
        setFinalOutput(result.output || data.output);
        setStatus('completed');
      } else {
        setStatus('running');
      }
    } catch (err: any) {
      setError(err.message || 'Approval failed');
      setStatus('failed');
    }
  }, [hitlPause, flowId, canvasNodes]);

  const handleHitlReject = useCallback(async () => {
    if (!hitlPause) return;
    setHitlPause(null);
    setHitlFeedback('');
    try {
      await fetch(`${API_URL}/executions/${hitlPause.executionId}/reject`, {
        method: 'POST',
        credentials: 'include',
      });
      setStatus('failed');
      setError('Execution rejected by user');
    } catch (err: any) {
      setError(err.message || 'Rejection failed');
      setStatus('failed');
    }
  }, [hitlPause]);

  const isValidJson = useCallback((str: string) => {
    try { JSON.parse(str); return true; } catch { return false; }
  }, []);

  const validateWebhookPayload = useCallback((value: string) => {
    if (!value.trim()) { setWebhookPayloadError(null); return; }
    try { JSON.parse(value); setWebhookPayloadError(null); } catch (e: any) { setWebhookPayloadError(e.message); }
  }, []);

  const handleWebhookChange = useCallback((value: string) => {
    setWebhookPayload(value);
    validateWebhookPayload(value);
  }, [validateWebhookPayload]);

  const addHistoryEntry = () => {
    setChatHistory(prev => [...prev, { role: 'user', content: '' }]);
  };

  const updateHistoryEntry = (index: number, field: keyof HistoryEntry, value: string) => {
    setChatHistory(prev => prev.map((e, i) => i === index ? { ...e, [field]: value } : e));
  };

  const removeHistoryEntry = (index: number) => {
    setChatHistory(prev => prev.filter((_, i) => i !== index));
  };



  const triggerIconName = TRIGGER_CONFIG[triggerType]?.icon || 'terminal';

  return (
    <div data-testid="debug-overlay" data-co-pilot-modal="debug-overlay" className="fixed inset-0 z-50 bg-surface flex flex-col">
      {/* Header — clean minimal bar */}
      <div className="h-11 border-b flex items-center justify-between px-4 shrink-0 bg-surface">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-on-surface">Debug Run</h2>
          {!loadingFlow && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-on-surface-variant bg-surface-container-high px-1.5 py-0.5 rounded">
              <Icon name={triggerIconName} className="text-xs" />
              {TRIGGER_CONFIG[triggerType]?.label || triggerType}
            </span>
          )}
          {status === 'running' && (
            <span className="flex items-center gap-1 text-xs text-primary">
              <Icon name="sync" className="text-xs animate-spin" /> Running...
            </span>
          )}
          {status === 'completed' && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Icon name="check_circle" className="text-xs" /> Completed
            </span>
          )}
          {status === 'failed' && (
            <span className="flex items-center gap-1 text-xs text-error">
              <Icon name="cancel" className="text-xs" /> Failed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="flex items-center gap-1 p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors">
            <Icon name="close" className="text-base" /> Close
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {/* Loading state */}
        {loadingFlow && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
                <Icon name="sync" className="text-3xl text-primary animate-spin mx-auto mb-3" />
              <p className="text-sm text-on-surface-variant">Loading flow...</p>
            </div>
          </div>
        )}

        {!loadingFlow && (
          <div className="max-w-4xl mx-auto py-6 px-6">
            {/* Re-run bar — always visible, the primary input */}
            <div className="bg-surface border rounded-xl p-4 mb-4 space-y-3">
              {triggerType === 'chat' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-on-surface-variant mb-1">Message</label>
                    <textarea
                      value={chatMessage}
                      onChange={(e) => setChatMessage(e.target.value)}
                      placeholder="Enter the chat message..."
className="w-full text-sm border border-outline rounded-lg px-3 py-2 font-mono resize-none bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                      rows={2}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-on-surface-variant">History</label>
                      <button onClick={addHistoryEntry} className="flex items-center gap-1 text-xs text-primary hover:text-primary">
                        <Icon name="add" className="text-xs" /> Add entry
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {chatHistory.map((entry, i) => (
                        <div key={i} className="flex gap-2 items-start">
                          <SelectField
                            label="Role"
                            value={entry.role}
                            onChange={(v) => updateHistoryEntry(i, 'role', v)}
                            options={[
                              { value: 'user', label: 'user' },
                              { value: 'assistant', label: 'assistant' },
                            ]}
                          />
                          <input
                            type="text"
                            value={entry.content}
                            onChange={(e) => updateHistoryEntry(i, 'content', e.target.value)}
                            placeholder="Message content..."
                            className="flex-1 text-xs border border-outline rounded-lg px-2.5 py-1.5 font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                          />
                          <button onClick={() => removeHistoryEntry(i)} className="flex items-center gap-1 p-1.5 text-error hover:text-error hover:bg-error-container rounded transition-colors">
                            <Icon name="delete" className="text-sm" /> Remove
                          </button>
                        </div>
                      ))}
                      {chatHistory.length === 0 && (
                        <p className="text-xs text-on-surface-variant italic">No history — the message above will be sent fresh</p>
                      )}
                    </div>
                  </div>
                </>
              )}
              {(triggerType === 'manual' || triggerType === 'schedule') && (
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1">Message</label>
                  <textarea
                    value={manualMessage}
                    onChange={(e) => setManualMessage(e.target.value)}
                    placeholder="Enter the message to send to the flow..."
                    className="w-full text-sm border border-outline rounded-lg px-3 py-2 font-mono resize-none bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    rows={2}
                  />
                </div>
              )}
              {triggerType === 'webhook' && (
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1">Payload</label>
                  <textarea
                    value={webhookPayload}
                    onChange={(e) => handleWebhookChange(e.target.value)}
                    placeholder='{"event": "test", "data": {}}'
                    className="w-full text-sm border border-outline rounded-lg px-3 py-2 font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary min-h-[120px]"
                    rows={5}
                  />
                  {webhookPayloadError && (
                    <p className="text-[11px] text-error mt-1 font-mono">Invalid JSON: {webhookPayloadError}</p>
                  )}
                </div>
              )}
              <EnvOverridesSection flowId={flowId} onChange={setEnvOverrides} />
              <button
                data-testid="debug-run-btn"
                onClick={status === 'running' ? stop : run}
                disabled={status === 'running' ? false : (triggerType === 'webhook' && webhookPayloadError !== null)}
                className="m3-button text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              >
                {status === 'running' ? <><Icon name="stop" className="text-base" /> Stop</> : <><Icon name="play_arrow" className="text-base" /> {status === 'idle' ? 'Start Debug Run' : 'Re-run'}</>}
              </button>
            </div>

            {/* Content area below the input form */}
            {status === 'idle' && steps.length === 0 && (
              <div className="text-center py-12">
                <Icon name="smart_toy" className="text-5xl text-outline-variant mx-auto mb-3" />
                <p className="text-on-surface-variant font-medium">Ready to debug</p>
                <p className="text-sm text-on-surface-variant mt-1">Fill in the input above and click &quot;Start Debug Run&quot;</p>
              </div>
            )}

            {steps.length === 0 && status === 'running' && (
              <div className="text-center py-12">
              <Icon name="sync" className="text-3xl text-primary animate-spin mx-auto mb-3" />
                <p className="text-on-surface-variant font-medium">Executing flow...</p>
              </div>
            )}

            {steps.length === 0 && !loadingFlow && status !== 'idle' && status !== 'running' && (
              <div className="bg-surface rounded-lg border p-8 text-center">
                {status === 'completed' ? (
                  <Icon name="check_circle" className="text-5xl text-success mx-auto mb-3" />
                ) : (
                  <Icon name="cancel" className="text-5xl text-error mx-auto mb-3" />
                )}
                <h3 className="text-lg font-semibold text-on-surface mb-1">
                  {status === 'completed' ? 'Execution Completed' : 'Execution Failed'}
                </h3>
                {error && <p className="text-sm text-error font-mono mt-2">{error}</p>}
                {finalOutput && (
                  <pre data-testid="debug-output" className="text-xs bg-surface-container p-3 rounded mt-4 text-left overflow-auto max-h-64">{typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput, null, 2)}</pre>
                )}
                {!error && !finalOutput && <p className="text-sm text-on-surface-variant">No output data was returned.</p>}
              </div>
            )}

            {steps.length > 0 && (
              <div className="space-y-1.5">
                {(() => {
                  const groups: { iter: number; steps: StepInfo[] }[] = [];
                  for (const step of steps) {
                    const iter = step.iteration ?? 0;
                    let group = groups.find(g => g.iter === iter);
                    if (!group) { group = { iter, steps: [] }; groups.push(group); }
                    group.steps.push(step);
                  }
                  groups.sort((a, b) => a.iter - b.iter);
                  return groups.flatMap((group) => {
                    const els: React.ReactNode[] = [];
                    if (group.iter > 0) {
                      els.push(
                        <div key={`sep-${group.iter}`} className="flex items-center gap-2 py-1">
                          <div className="flex-1 border-t border-dashed border-orange-300" />
                          <span className="text-[10px] font-medium text-orange-500 uppercase tracking-wider">⟳ Run {group.iter}</span>
                          <div className="flex-1 border-t border-dashed border-orange-300" />
                        </div>
                      );
                    }
                    group.steps.forEach((step, i) => {
                      els.push(
                        <StepCard
                          key={step.nodeId + group.iter + i}
                          step={step}
                          expanded={expanded[step.nodeId + group.iter + i] || false}
                          onToggle={() => toggle(step.nodeId + group.iter + i)}
                        />
                      );
                    });
                    return els;
                  });
                })()}

            {hitlPause && (
              <div className="mt-4 bg-secondary-container border border-secondary rounded-lg p-4">
                <h3 className="text-sm font-semibold text-on-secondary-container mb-2">Human-in-the-Loop — Approval Required</h3>
                <div className="prose prose-sm max-w-none text-on-secondary-container bg-surface rounded border p-3 max-h-48 overflow-y-auto">{hitlPause.prompt}</div>
                {hitlPause.allowFeedback && (
                  <textarea
                    value={hitlFeedback}
                    onChange={(e) => setHitlFeedback(e.target.value)}
                    placeholder="Provide feedback to the reviewer..."
                    className="w-full text-sm border border-outline rounded-lg px-3 py-2 resize-none bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary mt-2"
                    rows={2}
                  />
                )}
                <div className="flex gap-2">
                  {hitlPause.buttons.map(btn => (
                    <button key={btn.value} onClick={() => handleHitlApprove(btn.value)}
                      className="m3-button text-sm bg-secondary flex items-center gap-1">
                      {btn.icon && <Icon name={btn.icon} className="text-sm" />}
                      {btn.label}
                    </button>
                  ))}
                  {!hitlPause.buttons.some(b => b.value === 'rejected') && (
                    <button onClick={handleHitlReject}
                      className="m3-button-outlined text-sm">
                      Reject
                    </button>
                  )}
                </div>
              </div>
            )}

            {finalOutput && (
              <div className="mt-4 bg-success-container border border-success rounded-lg p-4">
                <h3 className="text-sm font-semibold text-success mb-2">Final Output</h3>
                <pre className="text-xs whitespace-pre-wrap break-all text-success max-h-48 overflow-y-auto">{typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput, null, 2)}</pre>
              </div>
            )}

            {error && !steps.some(s => s.error) && (
              <div className="mt-4 bg-error-container border border-error rounded-lg p-4 flex items-start gap-3">
                <Icon name="warning" className="text-2xl text-error mt-0.5 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-error mb-1">Execution Failed</h3>
                  <p className="text-xs text-error font-mono break-all">{error}</p>
                </div>
              </div>
            )}

            <div ref={logEndRef} />
          </div>
        )}
      </div>
    )}
    </div>
    </div>
  );
}
