import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { StepCard } from '@/components/flow/StepCard';
import { useAuth } from '@/lib/auth-context';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

interface Execution {
  id: string;
  flow_id: string;
  status: string;
  input: any;
  output: any;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const NODE_LABELS: Record<string, string> = {
  trigger: 'Trigger', 'llm-agent': 'LLM Agent', 'mcp-tool': 'MCP Tool',
  retriever: 'Retriever', branch: 'Condition', code: 'Code', output: 'Output',
};

const statusConfig: Record<string, { icon: string; color: string; bg: string; label: string }> = {
  completed: { icon: 'check_circle', color: 'text-success', bg: 'bg-success-container', label: 'Completed' },
  failed: { icon: 'cancel', color: 'text-error', bg: 'bg-error-container', label: 'Failed' },
  running: { icon: 'sync', color: 'text-primary', bg: 'bg-primary-container', label: 'Running' },
  pending: { icon: 'schedule', color: 'text-on-secondary-container', bg: 'bg-secondary-container', label: 'Pending' },
  cancelled: { icon: 'cancel', color: 'text-on-surface-variant', bg: 'bg-surface-container-high', label: 'Cancelled' },
  awaiting_approval: { icon: 'schedule', color: 'text-on-secondary-container', bg: 'bg-secondary-container', label: 'Awaiting Approval' },
};

const fmtTime = (t: string | null) => t ? new Date(t).toLocaleTimeString('nl-NL') : '—';
const dur = (s: string | null, e: string | null, pausedMs?: number) => {
  if (!s || !e) return null;
  let ms = new Date(e).getTime() - new Date(s).getTime();
  if (pausedMs) ms = Math.max(0, ms - pausedMs);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};
const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + '...' : s;

export default function ExecutionHistoryPage() {
  const router = useRouter();
  const { id: flowId } = router.query;
  const { user } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const backHref = user && !can('flow:create') ? '/approvals' : '/';
  useAssistantContext({ pageKey: 'executions:' + flowId, description: 'Viewing execution history' });
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Execution | null>(null);
  const [steps, setSteps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const PAGE_SIZE = 20;
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteConfirm = useConfirm({ title: 'Delete execution?', message: 'Delete this execution record?' });

  const deleteExec = async (execId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    setDeleting(execId);
    try {
      await fetch(`${API_URL}/executions/${execId}`, { method: 'DELETE' });
      setExecutions(prev => prev.filter(e => e.id !== execId));
      setTotal(prev => prev - 1);
    } catch { /* */ } finally { setDeleting(null); }
  };

  const cancel = async (execId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCancelling(execId);
    try {
      await fetch(`${API_URL}/executions/${execId}/cancel`, { method: 'POST' });
      setPage(0);
    } catch { /* */ } finally { setCancelling(null); }
  };

  useEffect(() => {
    if (!flowId) return;
    fetch(`${API_URL}/flows/${flowId}/executions?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : { data: [], total: 0 })
      .then(({ data, total }) => { setExecutions(data || []); setTotal(total || 0); })
      .catch(() => { setExecutions([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [flowId, page]);

  const viewDetails = async (execId: string) => {
    const exec = executions.find(e => e.id === execId);
    if (!exec) return;
    setSelected(exec);
    setView('detail');
    setExpanded({});
    const res = await fetch(`${API_URL}/flows/${flowId}/executions/${execId}`);
    const data = await res.json();
    if (data.steps) setSteps(data.steps);
  };

  const toggle = (id: string) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  if (view === 'list') return (
    <div className="min-h-screen bg-surface-container">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <Link href={backHref} className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant"><Icon name="arrow_back" className="text-base" /> <span>Back</span></Link>
          <div className="flex-1"><h1 className="text-2xl font-bold text-on-surface">Run history</h1></div>
        </div>
        {loading ? <p className="text-on-surface-variant text-sm">Loading...</p> : executions.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border">
            <Icon name="bolt" className="text-5xl text-outline-variant mx-auto mb-3" />
            <p className="text-on-surface-variant">No executions yet</p>
          </div>
        ) : (
          <div>
            <div className="space-y-3">{executions.map(exec => {
            const cfg = statusConfig[exec.status] || statusConfig.pending;
            const pausedTotal = exec.output?._pausedTotal || 0;
            const d = dur(exec.started_at, exec.completed_at, pausedTotal);
            return (
              <div key={exec.id} onClick={() => viewDetails(exec.id)} className="bg-surface rounded-lg border p-4 flex items-center justify-between hover:shadow-sm transition-shadow cursor-pointer">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full capitalize font-medium ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                    {d && <span className="text-xs text-on-surface-variant">{d}</span>}
                  </div>
                  <p className="text-xs text-on-surface-variant mt-1">{fmtTime(exec.created_at)}</p>
                  {exec.error && <p className="text-xs text-error mt-1 truncate font-mono max-w-md">{trunc(exec.error, 80)}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {exec.status === 'awaiting_approval' && (
                    <Tooltip content="Pending approval">
                      <Link href="/approvals" className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors">
                        <Icon name="pending" className="text-base" /> Approvals
                      </Link>
                    </Tooltip>
                  )}
                  {exec.status === 'running' && (
                    <Tooltip content="Stop execution">
                      <button onClick={(e) => cancel(exec.id, e)} disabled={cancelling === exec.id} className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors disabled:opacity-30 cursor-pointer">
                        <Icon name="stop_circle" className="text-base" /> Stop
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip content="Delete execution">
                      <button onClick={(e) => deleteExec(exec.id, e)} disabled={deleting === exec.id} className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors cursor-pointer disabled:opacity-30">
                        <Icon name="delete" className="text-base" /> Delete
                    </button>
                  </Tooltip>
                  <span className="p-2 text-outline-variant">
                    <Icon name="chevron_right" className="text-base" />
                  </span>
                </div>
              </div>
            );
          })}</div>
            <div className="flex items-center justify-between mt-4 text-sm">
              <span className="text-on-surface-variant">{total} execution{total !== 1 ? 's' : ''}</span>
              <div className="flex items-center gap-2">
                <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="m3-button-outlined text-sm disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
                <span className="text-on-surface-variant text-xs">Page {page + 1} of {Math.ceil(total / PAGE_SIZE) || 1}</span>
                <button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)} className="m3-button-outlined text-sm disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {deleteConfirm.dialog}
    </div>
  );

  // Detail view
  const cfg = selected ? statusConfig[selected.status] || statusConfig.pending : statusConfig.pending;
  const iconName = cfg.icon;
  const pausedTotal = selected?.output?._pausedTotal || 0;
  const waitingSince = selected?.output?._pausedAt
    ? Math.floor((Date.now() - selected.output._pausedAt) / 1000) + 's'
    : null;
  const execDuration = selected ? dur(selected.started_at, selected.completed_at, pausedTotal) : null;
  const isDebug = selected?.input?._debug;

  return (
    <div className="min-h-screen bg-surface-container">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <button onClick={() => { setView('list'); setSelected(null); setSteps([]); }} className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant"><Icon name="arrow_back" className="text-base" /> <span>Back</span></button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-on-surface">{isDebug ? 'Debug Trace' : 'Execution Details'}</h1>
              {isDebug && <span className="text-xs px-2 py-0.5 rounded-full bg-primary-container text-primary font-medium flex items-center gap-1"><Icon name="bug_report" className="text-xs" /> Debug</span>}
              {selected && <span className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>}
            </div>
            {selected && <p className="text-sm text-on-surface-variant mt-1">{fmtTime(selected.created_at)}{execDuration && <span className="ml-2 text-on-surface-variant">· run: {execDuration}</span>}{pausedTotal > 0 && <span className="ml-2 text-amber-500">· paused: {(pausedTotal / 1000).toFixed(0)}s</span>}{selected.status === 'awaiting_approval' && waitingSince && <span className="ml-2 text-amber-500">· waiting: {waitingSince}</span>}</p>}
          </div>
          {flowId && <Link href={`/flows/${flowId}/edit`} className="text-xs text-primary hover:text-primary font-medium">Open Editor</Link>}
        </div>

        {selected?.error && (
          <div className="bg-error-container border border-error rounded-lg p-4 mb-4 flex items-start gap-3">
            <Icon name="warning" className="text-2xl text-error shrink-0 mt-0.5" />
            <div><h3 className="text-sm font-semibold text-error mb-1">Execution Failed</h3><p className="text-xs text-error font-mono break-all">{selected.error}</p></div>
          </div>
        )}

        {steps.length === 0 ? (
          <div className="text-center py-12 bg-surface rounded-xl border"><Icon name="schedule" className="text-3xl text-outline-variant mx-auto mb-2" /><p className="text-sm text-on-surface-variant">No step data recorded</p></div>
        ) : (
          <div>
            <h2 className="text-sm font-semibold text-on-surface-variant uppercase tracking-wider mb-4">Step Trace ({steps.length} steps)</h2>
            <div className="space-y-2">{(function() {
              const groups: { iter: number; steps: any[] }[] = [];
              for (const step of steps) {
                const iter = step.iteration ?? 0;
                let group = groups.find(g => g.iter === iter);
                if (!group) { group = { iter, steps: [] }; groups.push(group); }
                group.steps.push(step);
              }
              // Sort groups by iteration
              groups.sort((a, b) => a.iter - b.iter);
              const elements: any[] = [];
              groups.forEach((group, gi) => {
                if (group.iter > 0) {
                  elements.push(
                    <div key={`sep-${group.iter}`} className="flex items-center gap-2 py-1">
                      <div className="flex-1 border-t border-dashed border-orange-300" />
                      <span className="text-[10px] font-medium text-orange-500 uppercase tracking-wider">⟳ Run {group.iter}</span>
                      <div className="flex-1 border-t border-dashed border-orange-300" />
                    </div>
                  );
                }
                group.steps.forEach((step: any) => {
              elements.push(
                <StepCard
                  key={step.id}
                  step={{
                    nodeId: step.id,
                    nodeType: step.node_type,
                    nodeLabel: step.node_label,
                    status: step.status,
                    input: step.input,
                    output: step.output,
                    error: step.error || null,
                    startedAt: step.started_at,
                    completedAt: step.completed_at,
                    tokens: step.tokens,
                    children: step.children,
                  }}
                  expanded={expanded[step.id] || false}
                  onToggle={() => toggle(step.id)}
                />
              );
              });
              });
              return elements;
            })()}</div>
            {selected?.output && <div className="mt-6 bg-surface rounded-lg border p-4"><h3 className="text-sm font-semibold text-on-surface mb-2">Final Output</h3><pre className="text-xs bg-surface-container p-3 rounded overflow-auto max-h-48 whitespace-pre-wrap break-all">{JSON.stringify(selected.output, null, 2)}</pre></div>}
          </div>
        )}
      </div>
    </div>
  );
}
