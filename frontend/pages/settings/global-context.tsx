import { useEffect, useRef, useState } from 'react';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { Icon } from '@/components/ui/Icon';
import Link from 'next/link';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { API_URL } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface GroupOption {
  id: string;
  name: string;
  role?: string;
}

export default function GlobalContextPage() {
  const { user } = useAuth();
  const isAdmin = user?.permissions?.includes('admin') ?? false;
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [value, setValue] = useState('');
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useAssistantContext({ pageKey: 'settings:global-context', description: 'Editing the global context for all flows' });

  useEffect(() => {
    const g = isAdmin
      ? fetch(`${API_URL}/groups`, { credentials: 'include' }).then(r => r.ok ? r.json() : [])
      : Promise.resolve((user as any)?.groups || []);
    g.then(data => setGroups(Array.isArray(data) ? data : [])).catch(() => {});
  }, [isAdmin, user]);

  const selectedGroup = groups.find(g => g.id === selectedGroupId) || null;
  const isGroupAdmin = (groupId: string) =>
    isAdmin || ((user as any)?.groups || []).some((g: any) => g.id === groupId && g.role === 'admin');
  // Global context is admin-only; group context is editable by the group's admins.
  const readOnly = selectedGroupId ? !isGroupAdmin(selectedGroupId) : !isAdmin;

  useEffect(() => {
    let cancelled = false;
    dirtyRef.current = false;
    setLoading(true);
    setMessage(null);
    const scope = selectedGroupId;
    const req = scope
      ? fetch(`${API_URL}/groups/${scope}/context`, { credentials: 'include' })
      : fetch('/api/settings/global-context', { credentials: 'include' });
    req
      .then(r => r.ok ? r.json() : Promise.resolve({} as Record<string, string>))
      .then((data: Record<string, string>) => {
        if (cancelled) return;
        // Never clobber text the user typed while the fetch was in flight.
        if (dirtyRef.current) return;
        setValue(scope ? (data.context || '') : (data.value || ''));
      })
      .catch(() => { if (!cancelled && !dirtyRef.current) setValue(''); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedGroupId]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = selectedGroupId
        ? await fetch(`${API_URL}/groups/${selectedGroupId}/context`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: value }),
            credentials: 'include',
          })
        : await fetch('/api/settings/global-context', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
            credentials: 'include',
          });
      if (!res.ok) throw new Error('Failed to save');
      setMessage({ type: 'success', text: selectedGroup ? `Context saved for ${selectedGroup.name}.` : 'Global context saved.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to save context.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-container">
            <div className="max-w-4xl mx-auto p-6">
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
          <div>
            <h1 className="text-2xl font-bold text-on-surface">Global Context</h1>
            <p className="text-sm text-on-surface-variant mt-1">Set the global system context for all LLM agents across all flows</p>
          </div>
        </div>

        {groups.length > 0 && (
          <div className="mb-4 max-w-xs">
            <SearchableSelect
              label="Filter by group"
              value={selectedGroupId}
              onChange={(v) => setSelectedGroupId(v)}
              items={groups.map(g => ({ value: g.id, label: g.name }))}
              includeAll={true}
              allLabel="All groups"
            />
          </div>
        )}

        {loading ? (
          <p className="text-on-surface-variant text-sm">Loading...</p>
        ) : (
          <div className="bg-surface rounded-xl border p-4 space-y-4">
            <div>
              <label className="text-xs font-medium text-on-surface-variant block mb-1">
                {selectedGroup ? `Context for ${selectedGroup.name}` : 'Global Context'}
              </label>
              <textarea
                value={value}
                onChange={e => { dirtyRef.current = true; setValue(e.target.value); }}
                readOnly={readOnly}
                disabled={readOnly}
                placeholder={selectedGroup
                  ? `Describe this group's team, goals, brand voice, or any instructions that should apply to LLM agents running flows in this group...`
                  : 'Describe your organisation, goals, brand voice, or any universal instructions that should apply to all LLM agents across all flows...'}
                rows={15}
                className="w-full text-sm border border-outline rounded-lg px-3 py-2 font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-y disabled:opacity-60"
              />
              <p className="mt-1 text-[10px] text-on-surface-variant">
                {selectedGroup
                  ? `This context is injected into every LLM Agent call for flows in ${selectedGroup.name}, between the global context and the flow context. Only group admins can edit it.`
                  : 'This context is prepended to every LLM Agent call across all flows, before any group, flow, or node-specific context.'}
              </p>
              {readOnly && !selectedGroupId && !isAdmin && (
                <p className="mt-1 text-[10px] text-on-surface-variant">Global context is read-only — only admins can edit it.</p>
              )}
            </div>

            {!readOnly && (
              <div className="flex items-center gap-2">
                <button onClick={handleSave} disabled={saving} className="m3-button disabled:opacity-50">
                  <Icon name="save" className="text-sm" /> {saving ? 'Saving...' : 'Save'}
                </button>
                {message && (
                  <span className={`text-xs ${message.type === 'success' ? 'text-success' : 'text-error'}`}>
                    {message.text}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
