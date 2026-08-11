import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { BrandLogo } from '@/components/BrandLogo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export default function ChatSessionList() {
  const router = useRouter();
  const { flowId } = router.query;
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const deleteConfirm = useConfirm({ title: 'Delete chat?', message: 'Delete this chat session?' });

  useEffect(() => {
    if (!flowId) return;
    fetch(`${API_URL}/chat/${flowId}/sessions`)
      .then(r => r.json())
      .then(setSessions)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [flowId]);

  const startNewChat = async () => {
    if (!flowId) return;
    const res = await fetch(`${API_URL}/chat/${flowId}/sessions`, { method: 'POST' });
    const session = await res.json();
    router.push(`/chat/${flowId}/${session.id}`);
  };

  const deleteSession = async (sessionId: string) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    await fetch(`${API_URL}/chat/sessions/${sessionId}`, { method: 'DELETE' });
    setSessions(sessions.filter(s => s.id !== sessionId));
  };

  useAssistantContext({ pageKey: 'chat-sessions:' + flowId, description: 'Viewing chat sessions' });

  return (
    <div className="min-h-screen bg-surface-container">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <Link href="/flows" className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant">
            <Icon name="arrow_back" className="text-base" /> <span>Back</span>
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-on-surface">Chat Sessions</h1>
            <p className="text-sm text-on-surface-variant">Conversations with this agent</p>
          </div>
          <button
            onClick={startNewChat}
            className="m3-button gap-2"
          >
            <Icon name="add" className="text-base" /> New Chat
          </button>
        </div>
        {loading ? (
          <p className="text-on-surface-variant text-sm">Loading...</p>
        ) : sessions.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border border-outline-variant">
            <Icon name="chat" className="text-5xl text-outline-variant mx-auto mb-3" />
            <p className="text-on-surface-variant mb-3">No conversations yet</p>
            <button onClick={startNewChat} className="text-primary hover:text-primary text-sm font-medium">
              Start a new chat
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map(s => (
              <div key={s.id} className="bg-surface rounded-lg border border-outline-variant p-4 flex items-center justify-between hover:shadow-sm transition-shadow">
                <Link href={`/chat/${flowId}/${s.id}`} className="flex-1 min-w-0">
                  <p className="font-medium text-on-surface hover:text-primary truncate">
                    {s.title || 'Untitled Chat'}
                  </p>
                  <p className="text-xs text-on-surface-variant mt-1">
                    {new Date(s.updated_at).toLocaleString('nl-NL')}
                  </p>
                </Link>
                <button
                  onClick={() => deleteSession(s.id)}
                  className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors shrink-0"
                >
                  <Icon name="delete" className="text-base" /> Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {deleteConfirm.dialog}
    </div>
  );
}
