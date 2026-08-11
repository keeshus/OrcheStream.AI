import { useEffect, useState, useCallback } from 'react';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useRouter } from 'next/router';
import { useAuth } from '@/lib/auth-context';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

interface PendingExec {
  id: string;
  flow_id: string;
  status: string;
  input: any;
  output: any;
  pending_hitls: any[];
  created_at: string;
  flow_name?: string;
}

export default function ApprovalsPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const isReader = user && !can('flow:create');
  useAssistantContext({ pageKey: 'approvals', description: 'Reviewing pending approvals' });

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };
  const [execs, setExecs] = useState<PendingExec[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/executions/pending`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch');
      const pending = await res.json();

      // Enrich with flow names
      const enriched = await Promise.all(pending.map(async (e: any) => {
        try {
          const flowRes = await fetch(`${API_URL}/flows/${e.flow_id}`, { credentials: 'include' });
          const flow = flowRes.ok ? await flowRes.json() : null;
          return { ...e, flow_name: flow?.name || e.flow_id?.slice(0, 8) };
        } catch {
          return { ...e, flow_name: e.flow_id?.slice(0, 8) };
        }
      }));
      setExecs(enriched);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    fetchPending();
    const interval = setInterval(fetchPending, 5000);
    return () => clearInterval(interval);
  }, [authLoading, fetchPending]);

  const handleAction = async (execId: string, decision: string, hitlNodeId?: string) => {
    setActing(prev => ({ ...prev, [execId]: true }));
    try {
      const fb = feedback[execId] || '';
      await fetch(`${API_URL}/executions/${execId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ decision, feedback: fb, hitlNodeId }),
      });
      // Remove from list
      setExecs(prev => prev.filter(e => e.id !== execId));
    } catch {
      setError('Failed to process approval');
    } finally {
      setActing(prev => ({ ...prev, [execId]: false }));
    }
  };

  const handleReject = async (execId: string) => {
    setActing(prev => ({ ...prev, [execId]: true }));
    try {
      await fetch(`${API_URL}/executions/${execId}/reject`, {
        method: 'POST',
        credentials: 'include',
      });
      setExecs(prev => prev.filter(e => e.id !== execId));
    } catch {
      setError('Failed to reject');
    } finally {
      setActing(prev => ({ ...prev, [execId]: false }));
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-surface-container flex items-center justify-center">
            <Icon name="sync" className="text-2xl text-on-surface-variant animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-container">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          {!isReader && (
            <Link href="/" className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant">
              <Icon name="arrow_back" className="text-base" /> <span>Back</span>
            </Link>
          )}
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-on-surface">Pending Approvals</h1>
            <p className="text-sm text-on-surface-variant mt-1">Review and respond to Human-in-the-Loop requests</p>
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <>
                <span className="text-xs text-on-surface-variant">{user.name}</span>
                <div className="grid grid-cols-2 justify-items-end gap-x-3">
                  <Tooltip content="Profile">
                    <Link href="/profile" className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors">
                      <Icon name="person" className="text-xl" /> Profile
                    </Link>
                  </Tooltip>
                  <Tooltip content="Sign Out">
                    <button onClick={handleLogout} className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors">
                      <Icon name="logout" className="text-xl" /> Sign Out
                    </button>
                  </Tooltip>
                </div>
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-error-container border border-red-200 text-error text-sm rounded p-3 mb-4 flex items-center gap-2">
            <Icon name="warning" className="text-base shrink-0" /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
        <Icon name="sync" className="text-2xl text-on-surface-variant animate-spin" />
          </div>
        ) : execs.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border">
            <Icon name="thumb_up" className="text-5xl text-outline-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">All caught up!</p>
            <p className="text-xs text-on-surface-variant mt-1">No pending approvals</p>
          </div>
        ) : (
          <div className="space-y-4">
            {execs.map(exec => {
              const pendingHitls: any[] = exec.pending_hitls || [];
              const hitl = pendingHitls[0] || {};
              const buttons = hitl.buttons || exec.output?._hitlButtons || [{ label: 'Approve', value: 'approved' }];
              const prompt = hitl.prompt || exec.output?._hitlPrompt || '';
              const allowFeedback = exec.output?._hitlAllowFeedback !== false;
              const isActing = acting[exec.id];
              const isMulti = hitl.assignmentType === 'multi';
              const approvals: Array<{ userId: string; decision: string }> = hitl.approvals || [];
              const approvedCount = approvals.filter(a => a.decision === 'approved').length;
              const required = hitl.requiredApprovals || 1;

              return (
                <div key={exec.id} className="bg-surface rounded-xl border p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Icon name="schedule" className="text-base text-amber-500" />
                      <span className="text-sm font-semibold text-on-surface">{exec.flow_name || 'Flow'}</span>
                      <span className="text-[10px] text-on-surface-variant font-mono">{exec.id?.slice(0, 8)}</span>
                    </div>
                    <span className="text-[10px] text-on-surface-variant">{new Date(exec.created_at).toLocaleString('nl-NL')}</span>
                  </div>

                  {isMulti && (
                    <div className="mb-3 flex items-center gap-2 text-xs">
                      <span className="text-on-surface-variant">Approvals:</span>
                      <div className="flex gap-1">
                        {Array.from({ length: required }).map((_, i) => (
                          <span key={i} className={`w-3 h-3 rounded-full ${i < approvedCount ? 'bg-success' : 'bg-outline-variant'}`} />
                        ))}
                      </div>
                      <span className="text-on-surface-variant">{approvedCount}/{required} required</span>
                    </div>
                  )}

                  {prompt && (
                    <div className="mb-3 p-3 bg-secondary-container border border-secondary rounded-lg text-sm max-h-48 overflow-y-auto prose prose-sm max-w-none">
                      <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{prompt}</ReactMarkdown>
                    </div>
                  )}

                  {allowFeedback && (
                      <TextField
                        label="Feedback"
                        value={feedback[exec.id] || ''}
                        onChange={(v) => setFeedback(prev => ({ ...prev, [exec.id]: v }))}
                        multiline
                        rows={2}
                        className="w-full mb-3"
                      />
                  )}

                  <div className="flex items-center gap-2 justify-end">
                    {buttons.map((btn: any) => (
                      <button
                        key={btn.value}
                        onClick={() => handleAction(exec.id, btn.value, hitl.nodeId)}
                        disabled={isActing}
                        className={`m3-button-tonal disabled:opacity-50 flex items-center gap-1 ${
                          btn.value === 'approved'
                            ? '!bg-success-container !text-success'
                            : ''
                        }`}
                      >
                        {btn.icon ? <Icon name={btn.icon} className="text-xs" /> : <Icon name="check_circle" className="text-xs" />}
                        {btn.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}
