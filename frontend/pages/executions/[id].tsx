import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { StepTree } from '@/components/execution/StepTree';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function ExecutionDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const [execution, setExecution] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`${API_URL}/executions/${id}`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => { setExecution(data); })
      .catch(() => { setExecution(null); })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-container flex items-center justify-center">
        <div className="text-center">
          <Icon name="sync" className="text-3xl text-primary animate-spin mx-auto mb-3" />
          <p className="text-sm text-on-surface-variant">Loading execution...</p>
        </div>
      </div>
    );
  }

  if (!execution) {
    return (
      <div className="min-h-screen bg-surface-container flex items-center justify-center">
        <div className="text-center">
          <Icon name="cancel" className="text-5xl text-error mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-on-surface">Execution not found</h2>
          <Link href="/flows" className="text-sm text-primary mt-2 inline-block">Back to flows</Link>
        </div>
      </div>
    );
  }

  const steps = (execution.steps || []).map((s: any) => ({
    nodeId: s.node_id || s.nodeId,
    nodeType: s.node_type || s.nodeType,
    nodeLabel: s.node_label || s.nodeLabel,
    status: s.status || 'pending',
    input: s.input,
    output: s.output,
    error: s.error || null,
    startedAt: s.started_at || s.startedAt || '',
    completedAt: s.completed_at || s.completedAt || null,
    tokens: s.tokens || [],
    iteration: s.iteration ?? 0,
    children: s.children,
    hierarchy: s.hierarchy,
  }));

  const statusIconMap: Record<string, string> = {
    running: 'sync',
    completed: 'check_circle',
    failed: 'cancel',
    pending: 'schedule',
    awaiting_approval: 'schedule',
    cancelled: 'cancel',
  };
  const statusIcon = statusIconMap[execution.status as string] || 'schedule';

  const statusColorMap: Record<string, string> = {
    running: 'text-primary',
    completed: 'text-success',
    failed: 'text-error',
    pending: 'text-on-surface-variant',
    awaiting_approval: 'text-warning',
    cancelled: 'text-on-surface-variant',
  };
  const statusColor = statusColorMap[execution.status as string] || 'text-on-surface-variant';

  const isRunning = execution.status === 'running' || execution.status === 'pending';

  return (
    <div className="min-h-screen bg-surface-container">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <Tooltip content="Back to flows">
            <Link href="/flows" className="flex items-center gap-1 text-sm text-on-surface-variant hover:text-on-surface transition-colors">
              <Icon name="arrow_back" className="text-base" /> Back
            </Link>
          </Tooltip>
        </div>

        {/* Execution summary card */}
        <div className="bg-surface rounded-xl border p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {isRunning ? (
                <Icon name={statusIcon} className={`text-2xl ${statusColor} animate-spin`} />
              ) : (
                <Icon name={statusIcon} className={`text-2xl ${statusColor}`} />
              )}
              <div>
                <h1 className="text-xl font-bold text-on-surface">{execution.flow_name || execution.flowId || 'Execution'}</h1>
                <p className="text-sm text-on-surface-variant">Execution {execution.id?.slice(0, 8)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {execution.status === 'completed' && (
                <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-success-container text-success">
                  <Icon name="check_circle" className="text-sm" /> Completed
                </span>
              )}
              {execution.status === 'failed' && (
                <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-error-container text-error">
                  <Icon name="cancel" className="text-sm" /> Failed
                </span>
              )}
              {execution.status === 'running' && (
                <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-primary-container text-primary">
                  <Icon name="sync" className="text-sm animate-spin" /> Running
                </span>
              )}
              {execution.status === 'pending' && (
                <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-surface-container-high text-on-surface-variant">
                  <Icon name="schedule" className="text-sm" /> Pending
                </span>
              )}
              {execution.status === 'awaiting_approval' && (
                <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-warning-container text-warning">
                  <Icon name="schedule" className="text-sm" /> Awaiting Approval
                </span>
              )}
              {execution.status === 'cancelled' && (
                <span className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-error-container text-error">
                  <Icon name="cancel" className="text-sm" /> Cancelled
                </span>
              )}
            </div>
          </div>

          {/* Links */}
          <div className="flex items-center gap-4 text-sm">
            {execution.flowId && (
              <Link href={`/flows/${execution.flowId}/edit`} className="flex items-center gap-1 text-primary hover:text-primary transition-colors">
                <Icon name="open_in_new" className="text-sm" /> View Flow
              </Link>
            )}
            {execution.parent_execution_id && (
              <Link href={`/executions/${execution.parent_execution_id}`} className="flex items-center gap-1 text-primary hover:text-primary transition-colors">
                <Icon name="call_made" className="text-sm" /> View Parent Execution
              </Link>
            )}
            {execution.flowId && (
              <Link href={`/flows/${execution.flowId}/executions`} className="flex items-center gap-1 text-on-surface-variant hover:text-on-surface transition-colors">
                <Icon name="history" className="text-sm" /> All Executions
              </Link>
            )}
          </div>

          {/* Timing */}
          <div className="flex items-center gap-4 mt-3 text-xs text-on-surface-variant">
            {execution.started_at && (
              <span>Started: {new Date(execution.started_at).toLocaleString('nl-NL')}</span>
            )}
            {execution.completed_at && (
              <span>Completed: {new Date(execution.completed_at).toLocaleString('nl-NL')}</span>
            )}
            {execution.created_at && (
              <span>Created: {new Date(execution.created_at).toLocaleString('nl-NL')}</span>
            )}
          </div>

          {/* Error */}
          {execution.error && (
            <div className="mt-4 bg-error-container border border-error rounded-lg p-3 flex items-start gap-2">
              <Icon name="warning" className="text-base text-error mt-0.5 shrink-0" />
              <p className="text-sm text-error font-mono break-all">{execution.error}</p>
            </div>
          )}

          {/* Input / Output */}
          {execution.input && Object.keys(execution.input).length > 0 && (
            <details className="mt-4">
              <summary className="text-xs font-medium text-on-surface-variant cursor-pointer hover:text-on-surface">Execution Input</summary>
              <pre className="text-xs bg-surface-container rounded p-3 mt-2 overflow-auto max-h-48 font-mono">{JSON.stringify(execution.input, null, 2)}</pre>
            </details>
          )}
          {execution.output && (
            <details className="mt-2">
              <summary className="text-xs font-medium text-on-surface-variant cursor-pointer hover:text-on-surface">Execution Output</summary>
              <pre className="text-xs bg-surface-container rounded p-3 mt-2 overflow-auto max-h-48 font-mono">{JSON.stringify(execution.output, null, 2)}</pre>
            </details>
          )}
        </div>

        {/* Steps Tree */}
        {steps.length > 0 ? (
          <div>
            <h2 className="text-sm font-semibold text-on-surface mb-3">Execution Steps</h2>
            <StepTree
              steps={steps}
              showInputs={true}
              showOutputs={true}
              onViewSubExecution={(subId) => router.push(`/executions/${subId}`)}
              subExecutionLinks={execution.sub_execution_links}
            />
          </div>
        ) : (
          <div className="text-center py-16 bg-surface rounded-xl border">
            <Icon name="list_alt" className="text-5xl text-outline-variant mx-auto mb-3" />
            <p className="text-on-surface-variant">No execution steps recorded</p>
          </div>
        )}
      </div>
    </div>
  );
}
