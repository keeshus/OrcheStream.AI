import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { useAuth } from '@/lib/auth-context';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface PendingHitl {
  nodeId: string;
  prompt: string;
  buttons?: string[];
  savedOutputs?: Record<string, unknown>;
  assignmentType?: string;
  assignees?: { userIds?: string[]; roleIds?: string[]; groupIds?: string[] };
  requiredApprovals?: number;
}

interface Execution {
  id: string;
  flow_id: string;
  flow_name: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
  pending_hitls: string | PendingHitl[];
}

function getWaitingTime(startedAt: string): { label: string; hours: number } {
  const diff = Date.now() - new Date(startedAt).getTime();
  const hours = diff / (1000 * 60 * 60);
  if (hours < 1) return { label: `${Math.floor(diff / (1000 * 60))}m`, hours };
  if (hours < 24) return { label: `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`, hours };
  const days = Math.floor(hours / 24);
  return { label: `${days}d ${Math.floor(hours % 24)}h`, hours };
}

function getPendingHitls(exec: Execution): PendingHitl[] {
  if (!exec.pending_hitls) return [];
  if (Array.isArray(exec.pending_hitls)) return exec.pending_hitls;
  try {
    return JSON.parse(exec.pending_hitls);
  } catch {
    return [];
  }
}

export default function ExecutionsPage() {
  const { user } = useAuth();
  const isAdmin = user?.permissions?.includes('admin') ?? false;

  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const cancelConfirm = useConfirm({ title: 'Cancel execution?', message: 'Force-cancel this pending execution? This cannot be undone.', confirmLabel: 'Cancel execution', variant: 'danger' });

  useAssistantContext({ pageKey: 'settings:executions', description: 'Managing pending HITL executions' });

  const fetchExecutions = useCallback(async () => {
    try {
      const res = await fetch(`/api/executions?status=awaiting_approval&limit=100`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      setExecutions(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchExecutions(); }, [fetchExecutions]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchExecutions, 30000);
    return () => clearInterval(interval);
  }, [fetchExecutions]);

  const handleCancel = async (id: string) => {
    const confirmed = await cancelConfirm.confirm();
    if (!confirmed) return;
    setCancelling(id);
    try {
      const res = await fetch(`/api/executions/${id}/admin-cancel`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Cancel failed');
      setExecutions(prev => prev.filter(e => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setCancelling(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-surface-container flex items-center justify-center">
        <div className="text-on-surface-variant text-center">
          <Icon name="lock" className="text-5xl mx-auto mb-3" />
          <p className="font-medium">Access denied</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container">
      <div className="max-w-5xl mx-auto p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
              <BrandLogo size="sm" />
              <span>Home</span>
            </Link>
            <Separator.Root orientation="vertical" className="w-px h-6 bg-outline-variant mx-0.5" />
            <Link href="/settings" className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant">
              <Icon name="arrow_back" className="text-base" /> <span>Back</span>
            </Link>
          </div>
          <Separator.Root orientation="vertical" className="w-px h-6 bg-outline-variant" />
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-on-surface">Pending Approvals</h1>
            <p className="text-sm text-on-surface-variant mt-1">
              {loading ? 'Loading...' : `${executions.length} pending execution${executions.length === 1 ? '' : 's'} awaiting approval`}
            </p>
          </div>
          <button
            onClick={fetchExecutions}
            disabled={loading}
            className="m3-button-outlined gap-2 disabled:opacity-50"
          >
            <Icon name="refresh" className={`text-base ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 bg-error-container border border-red-200 rounded-lg flex items-center gap-2 text-sm text-error">
            <Icon name="error" className="text-base flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-12 text-on-surface-variant text-sm">Loading executions...</div>
        )}

        {/* Empty state */}
        {!loading && !error && executions.length === 0 && (
          <div className="text-center py-16 bg-surface rounded-lg border border-outline-variant">
            <Icon name="check_circle" className="text-5xl text-success mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">All caught up! No pending executions.</p>
            <p className="text-on-surface-variant text-sm mt-1">Every execution has been processed.</p>
          </div>
        )}

        {/* Executions table */}
        {!loading && executions.length > 0 && (
          <div className="bg-surface rounded-lg border border-outline-variant overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant bg-surface-container">
                  <th className="text-left px-4 py-3 font-medium text-on-surface-variant text-xs">Flow</th>
                  <th className="text-left px-4 py-3 font-medium text-on-surface-variant text-xs">Started</th>
                  <th className="text-left px-4 py-3 font-medium text-on-surface-variant text-xs">Waiting for</th>
                  <th className="text-left px-4 py-3 font-medium text-on-surface-variant text-xs">Flow ID</th>
                  <th className="text-right px-4 py-3 font-medium text-on-surface-variant text-xs">Actions</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((exec) => {
                  const pendingHitls = getPendingHitls(exec);
                  const waiting = getWaitingTime(exec.started_at);
                  const rowClass = waiting.hours > 72
                    ? 'bg-error-container/20'
                    : waiting.hours > 24
                      ? 'bg-warning/10'
                      : '';
                  return (
                    <tr key={exec.id} className={`border-b border-outline-variant last:border-b-0 hover:bg-surface-container/50 transition-colors ${rowClass}`}>
                      <td className="px-4 py-3">
                        <span className="font-medium text-on-surface">{exec.flow_name}</span>
                      </td>
                      <td className="px-4 py-3 text-on-surface-variant whitespace-nowrap">
                        <Tooltip content={new Date(exec.started_at).toLocaleString()}>
                          <span>{new Date(exec.started_at).toLocaleDateString('nl-NL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </Tooltip>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <span className={`text-xs font-medium ${waiting.hours > 72 ? 'text-error' : waiting.hours > 24 ? 'text-warning' : 'text-on-surface-variant'}`}>
                            {waiting.label}
                          </span>
                          {waiting.hours > 72 && <Icon name="warning" className="text-sm text-error" />}
                          {pendingHitls.length > 0 && (
                            <Tooltip content={pendingHitls[0].prompt || 'Awaiting approval'}>
                              <Icon name="handshake" className="text-sm text-primary ml-1" />
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <code className="text-[10px] text-on-surface-variant font-mono">{exec.flow_id.slice(0, 8)}...</code>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleCancel(exec.id)}
                          disabled={cancelling === exec.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-error hover:bg-error-container rounded-lg transition-colors disabled:opacity-50"
                        >
                          {cancelling === exec.id ? (
                            <Icon name="sync" className="text-sm animate-spin" />
                          ) : (
                            <Icon name="cancel" className="text-sm" />
                          )}
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {cancelConfirm.dialog}
    </div>
  );
}
