import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Tooltip } from '@/components/ui/Tooltip';
import { api } from '@/lib/api-client';
import { useConfirm } from '@/lib/useConfirm';
import { useAuth } from '@/lib/auth-context';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

export default function KnowledgePage() {
  const { user, userGroups } = useAuth();
  const canAdmin = user?.permissions?.includes('admin') ?? false;

  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [filterGroupId, setFilterGroupId] = useState<string | null>(null);

  useEffect(() => {
    if (canAdmin) {
      api.groups.list().then(setGroups).catch(() => {});
    } else {
      setGroups(userGroups);
    }
  }, [canAdmin, userGroups]);

  useAssistantContext({ pageKey: 'settings:knowledge', description: 'Managing knowledge bases' });

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
            <Link href="/settings" className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant"><Icon name="arrow_back" className="text-base" /> <span>Back</span></Link>
          </div>
          <Separator.Root orientation="vertical" className="w-px h-6 bg-outline-variant" />
          <Link href="/settings" className="flex items-center gap-1 leading-none text-on-surface-variant hover:text-on-surface-variant"><Icon name="arrow_back" className="text-base" /> <span>Back</span></Link>
          <div className="flex-1"><h1 data-testid="knowledge-heading" className="text-2xl font-bold text-on-surface">Knowledge Bases</h1><p className="text-sm text-on-surface-variant mt-1">Embedding providers and vector stores for RAG</p></div>
        </div>

        {/* Group filter */}
        {groups.length > 0 && (
          <div className="mb-4 max-w-xs">
            <SearchableSelect
              label="Filter by group"
              value={filterGroupId || ''}
              onChange={(v) => setFilterGroupId(v || null)}
              items={groups.map(function(g){return{value:g.id,label:g.name}})}
              includeAll={true}
              allLabel="All items"
            />
          </div>
        )}

        <EmbeddingProviders filterGroupId={filterGroupId} groupItems={groups.map(function(g){return{value:g.id,label:g.name}})} />
        <div className="mt-6"><VectorStores filterGroupId={filterGroupId} groupItems={groups.map(function(g){return{value:g.id,label:g.name}})} /></div>
      </div>
    </div>
  );
}

function EmbeddingProviders({ filterGroupId, groupItems }: { filterGroupId: string | null; groupItems: Array<{ value: string; label: string }> }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', providerType: 'openai', baseUrl: '', apiKey: '', model: 'text-embedding-ada-002', groupId: '' });
  const [saving, setSaving] = useState(false);
  const deleteConfirm = useConfirm({ title: 'Delete embedding provider?', message: 'Delete this embedding provider? This cannot be undone.' });

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await api.embeddingProviders.list(filterGroupId ? { groupId: filterGroupId } : undefined);
      setItems(Array.isArray(data) ? data : []);
    } catch { setItems([]); }
    setLoading(false);
  };
  useEffect(() => { loadData(); }, [filterGroupId]);

  const reset = () => { setForm({ name: '', providerType: 'openai', baseUrl: '', apiKey: '', model: 'text-embedding-ada-002', groupId: '' }); setEditingId(null); setShowForm(false); };

  return (
    <div>
      {showForm && (
        <form onSubmit={async e => { e.preventDefault(); setSaving(true);
          const body: Record<string, unknown> = {
            name: form.name,
            providerType: form.providerType,
            baseUrl: form.baseUrl || null,
            apiKey: form.apiKey,
            model: form.model,
            groupId: form.groupId || null,
          };
          if (editingId) { await api.embeddingProviders.update(editingId, body); }
          else { await api.embeddingProviders.create(body); }
          setSaving(false); reset(); loadData();
        }} className="mb-6 bg-surface rounded-lg border border-outline-variant p-5 space-y-4">
          <h2 className="text-base font-semibold text-on-surface">{editingId ? 'Edit Embedding Provider' : 'New Embedding Provider'}</h2>
          <div className="grid grid-cols-2 gap-4">
            <TextField label="Name" value={form.name} onChange={(v) => setForm({...form, name: v})} data-testid="embedding-name" />
            <SelectField label="Provider" value={form.providerType} onChange={(v) => setForm({...form, providerType: v})} options={[{ value: 'openai', label: 'OpenAI' }, { value: 'litellm', label: 'LiteLLM' }]} />
            <TextField label="Base URL" value={form.baseUrl} onChange={(v) => setForm({...form, baseUrl: v})} />
            <TextField label="API Key" type="password" value={form.apiKey} onChange={(v) => setForm({...form, apiKey: v})} showPasswordToggle />
            <TextField label="Model" value={form.model} onChange={(v) => setForm({...form, model: v})} />
            {groupItems.length > 0 && (
              <SearchableSelect label="Group" value={form.groupId} onChange={(v) => setForm({...form, groupId: v})} items={groupItems} includeAll={true} allLabel="App-wide" className="col-span-1" />
            )}
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button type="button" onClick={reset} className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors">Cancel</button>
            <Tooltip content={!saving && (!form.name || (!editingId && !form.apiKey)) ? 'Fill in all required fields' : ''}>
              <span>
                <button type="submit" disabled={saving || !form.name || (!editingId && !form.apiKey)} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">{saving ? 'Saving...' : editingId ? 'Update' : 'Create'}</button>
              </span>
            </Tooltip>
          </div>
        </form>
      )}
      <div data-testid="embedding-providers-section" className="bg-surface rounded-lg border border-outline-variant p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-on-surface flex items-center gap-2"><Icon name="memory" className="text-base text-primary" /> Embedding Providers</h2>
          {!showForm && <button data-testid="add-embedding-btn" onClick={() => setShowForm(true)} className="m3-button"><Icon name="add" className="text-xs" /> Add</button>}
        </div>
      {loading ? <p className="text-sm text-on-surface-variant">Loading...</p> : items.length === 0 ? <p className="text-sm text-on-surface-variant">No embedding providers configured</p> : (
        <div className="space-y-2">
          {items.map((ep: any) => (
            <div key={ep.id} data-testid="embedding-item" className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium">{ep.name}</p>
                  {ep.group_id ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-medium">
                      {groupItems.find((i) => i.value === ep.group_id)?.label || 'Group'}
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-medium">App-wide</span>
                  )}
                </div>
                <p className="text-xs text-on-surface-variant">{ep.provider_type} · {ep.model} · {ep.base_url || 'default'}</p>
              </div>
              <div className="flex gap-1">
                <button data-testid="edit-embedding-btn" onClick={() => { setForm({ name: ep.name, providerType: ep.provider_type, baseUrl: ep.base_url || '', apiKey: '', model: ep.model, groupId: ep.group_id || '' }); setEditingId(ep.id); setShowForm(true); }} className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors"><Icon name="edit" className="text-sm" /> Edit</button>
                <button data-testid="delete-embedding-btn" onClick={async () => { const ok = await deleteConfirm.confirm({ message: 'Delete embedding provider "' + ep.name + '"? This cannot be undone.' }); if (!ok) return; await api.embeddingProviders.delete(ep.id); loadData(); }} className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors"><Icon name="delete" className="text-sm" /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {deleteConfirm.dialog}
      </div>
    </div>
  );
}

function VectorStores({ filterGroupId, groupItems }: { filterGroupId: string | null; groupItems: Array<{ value: string; label: string }> }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', url: '', apiKey: '', storeType: 'qdrant', groupId: '' });
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const deleteConfirm = useConfirm({ title: 'Delete vector store?', message: 'Delete this vector store? This cannot be undone.' });

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await api.vectorStores.list(filterGroupId ? { groupId: filterGroupId } : undefined);
      setItems(Array.isArray(data) ? data : []);
    } catch { setItems([]); }
    setLoading(false);
  };
  useEffect(() => { loadData(); }, [filterGroupId]);

  const handleRefresh = async (id: string) => {
    setRefreshing(id);
    try {
      const updated = await api.vectorStores.refresh(id);
      setItems(prev => prev.map(v => v.id === id ? updated : v));
    } catch {}
    setRefreshing(null);
  };

  const reset = () => { setForm({ name: '', url: '', apiKey: '', storeType: 'qdrant', groupId: '' }); setEditingId(null); setShowForm(false); };

  return (
    <div>
      {showForm && (
        <form onSubmit={async e => { e.preventDefault(); setSaving(true);
          const body: Record<string, unknown> = {
            name: form.name,
            storeType: form.storeType,
            url: form.url,
            apiKey: form.apiKey || undefined,
            groupId: form.groupId || null,
          };
          if (editingId) { await api.vectorStores.update(editingId, body); }
          else { await api.vectorStores.create(body); }
          setSaving(false); reset(); loadData();
        }} className="mb-6 bg-surface rounded-lg border border-outline-variant p-5 space-y-4">
          <h2 className="text-base font-semibold text-on-surface">{editingId ? 'Edit Vector Store' : 'New Vector Store'}</h2>
          <div className="grid grid-cols-2 gap-4">
            <TextField label="Name" value={form.name} onChange={(v) => setForm({...form, name: v})} />
            <SelectField label="Type" value={form.storeType} onChange={(v) => setForm({...form, storeType: v})} options={[{ value: 'qdrant', label: 'Qdrant' }, { value: 'neo4j', label: 'Neo4j' }]} />
            <TextField label="URL" value={form.url} onChange={(v) => setForm({...form, url: v})} />
            <TextField label="API Key" type="password" value={form.apiKey} onChange={(v) => setForm({...form, apiKey: v})} showPasswordToggle />
            {groupItems.length > 0 && (
              <SearchableSelect label="Group" value={form.groupId} onChange={(v) => setForm({...form, groupId: v})} items={groupItems} includeAll={true} allLabel="App-wide" className="col-span-1" />
            )}
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button type="button" onClick={reset} className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors">Cancel</button>
            <Tooltip content={!saving && (!form.name || !form.url) ? 'Fill in all required fields' : ''}>
              <span>
                <button type="submit" disabled={saving || !form.name || !form.url} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">{saving ? 'Saving...' : editingId ? 'Update' : 'Create'}</button>
              </span>
            </Tooltip>
          </div>
        </form>
      )}
      <div data-testid="vector-stores-section" className="bg-surface rounded-lg border border-outline-variant p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-on-surface flex items-center gap-2"><Icon name="database" className="text-base text-primary" /> Vector Stores</h2>
          {!showForm && <button data-testid="add-vectorstore-btn" onClick={() => setShowForm(true)} className="m3-button"><Icon name="add" className="text-xs" /> Add</button>}
        </div>
      {loading ? <p className="text-sm text-on-surface-variant">Loading...</p> : items.length === 0 ? <p className="text-sm text-on-surface-variant">No vector stores configured</p> : (
        <div className="space-y-2">
          {items.map((vs: any) => (
            <div key={vs.id} data-testid="vectorstore-item" className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium">{vs.name}</p>
                  {vs.group_id ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-medium">
                      {groupItems.find((i) => i.value === vs.group_id)?.label || 'Group'}
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-medium">App-wide</span>
                  )}
                </div>
                <p className="text-xs text-on-surface-variant">{vs.store_type} · {vs.url}</p>
                {vs.collections?.length > 0 && (
                  <p className="text-[10px] text-on-surface-variant mt-1">{vs.collections.length} collection{vs.collections.length !== 1 ? 's' : ''}</p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  data-testid="edit-vectorstore-btn"
                  onClick={() => { setForm({ name: vs.name, url: vs.url, apiKey: '', storeType: vs.store_type, groupId: vs.group_id || '' }); setEditingId(vs.id); setShowForm(true); }}
                  className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors"
                >
                  <Icon name="edit" className="text-sm" /> Edit
                </button>
                <button
                  onClick={() => handleRefresh(vs.id)}
                  disabled={refreshing === vs.id}
                  className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors disabled:opacity-50"
                >
                  <Icon name="refresh" className={`text-sm ${refreshing === vs.id ? 'animate-spin' : ''}`} /> Refresh
                </button>
                <button data-testid="delete-vectorstore-btn" onClick={async () => { const ok = await deleteConfirm.confirm({ message: 'Delete vector store "' + vs.name + '"? This cannot be undone.' }); if (!ok) return; await api.vectorStores.delete(vs.id); loadData(); }} className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors"><Icon name="delete" className="text-sm" /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {deleteConfirm.dialog}
      </div>
    </div>
  );
}
