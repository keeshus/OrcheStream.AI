import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { api } from '@/lib/api-client';
import { Tooltip } from '@/components/ui/Tooltip';
import { useAuth } from '@/lib/auth-context';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface FormState {
  name: string;
  url: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  url: '',
  enabled: true,
};

export default function MCPServersPage() {
  const { user, userGroups } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const canAdmin = can('admin');

  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useAssistantContext({ pageKey: 'settings:mcp-servers', description: 'Managing MCP servers' });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteConfirm = useConfirm({ title: 'Delete MCP server?', message: 'Are you sure you want to delete this MCP server?' });
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [filterGroupId, setFilterGroupId] = useState<string | null>(null);
  const [formGroupId, setFormGroupId] = useState('');

  useEffect(() => {
    if (canAdmin) {
      api.groups.list().then(setGroups).catch(() => {});
    } else {
      setGroups(userGroups);
    }
  }, [canAdmin, userGroups]);

  const fetchServers = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.mcpServers.list(filterGroupId ? { groupId: filterGroupId } : undefined);
      setServers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServers();
  }, [filterGroupId]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
    setFormGroupId('');
  };

  const handleEdit = (srv: any) => {
    setForm({
      name: srv.name,
      url: srv.url,
      enabled: srv.enabled,
    });
    setEditingId(srv.id);
    setFormGroupId(srv.group_id || '');
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    setDeleting(id);
    try {
      await api.mcpServers.delete(id);
      setServers((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete server');
    } finally {
      setDeleting(null);
    }
  };

  const handleRefresh = async (id: string) => {
    setRefreshing(id);
    setError(null);
    try {
      const updated = await api.mcpServers.refreshTools(id);
      setServers((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh tools');
    } finally {
      setRefreshing(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (editingId) {
        const updateData: Record<string, unknown> = {
          name: form.name,
          url: form.url,
          enabled: form.enabled,
          groupId: formGroupId || null,
        };
        const updated = await api.mcpServers.update(editingId, updateData);
        setServers((prev) => prev.map((s) => (s.id === editingId ? updated : s)));
      } else {
        const created = await api.mcpServers.create({
          name: form.name,
          url: form.url,
          enabled: form.enabled,
          groupId: formGroupId || null,
        });
        setServers((prev) => [...prev, created]);
      }
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save server');
    } finally {
      setSaving(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="min-h-screen bg-surface-container">
            <div className="max-w-4xl mx-auto p-6">
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
            <h1 data-testid="mcp-servers-heading" className="text-2xl font-bold text-on-surface">MCP Servers</h1>
            <p className="text-sm text-on-surface-variant mt-1">
              Configure Model Context Protocol servers and their available tools
            </p>
          </div>
          {!showForm && (
            <button
              data-testid="add-mcp-server-btn"
              onClick={() => setShowForm(true)}
              className="m3-button gap-2"
            >
              <Icon name="add" className="text-base" />
              Add Server
            </button>
          )}
        </div>

        {/* Group filter */}
        {groups.length > 0 && (
          <div className="mb-4 max-w-xs">
            <SearchableSelect
              label="Filter by group"
              value={filterGroupId || ''}
              onChange={(v) => { setFilterGroupId(v || null); setShowForm(false); }}
              items={groups.map(function(g){return{value:g.id,label:g.name}})}
              includeAll={true}
              allLabel="All items"
            />
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 bg-error-container border border-red-200 rounded-lg flex items-center gap-2 text-sm text-error">
            <Icon name="error" className="text-base flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Add / Edit form */}
        {showForm && (
          <form
            onSubmit={handleSubmit}
            className="mb-6 bg-surface rounded-lg border border-outline-variant p-5 space-y-4"
          >
            <h2 className="text-base font-semibold text-on-surface">
              {editingId ? 'Edit MCP Server' : 'New MCP Server'}
            </h2>

            <TextField
              label="Name"
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            />

            <TextField
              label="URL"
              value={form.url}
              onChange={(v) => setForm((f) => ({ ...f, url: v }))}
            />

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-outline text-primary"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
              <span className="text-sm font-medium text-on-surface-variant">Enabled</span>
            </label>

            {groups.length > 0 && (
              <SearchableSelect
                label="Group"
                value={formGroupId}
                onChange={setFormGroupId}
                items={groups.map(function(g){return{value:g.id,label:g.name}})}
                includeAll={true}
                allLabel="App-wide"
                className="col-span-1"
              />
            )}

            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors"
              >
                Cancel
              </button>
              <Tooltip content={!saving && (!form.name || !form.url) ? 'Fill in all required fields' : ''}>
                <span>
                  <button
                    type="submit"
                    disabled={saving || !form.name || !form.url}
                    className="m3-button disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving...' : editingId ? 'Update Server' : 'Create Server'}
                  </button>
                </span>
              </Tooltip>
            </div>
          </form>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-12 text-on-surface-variant text-sm">
            Loading MCP servers...
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && servers.length === 0 && (
          <div className="text-center py-16 bg-surface rounded-lg border border-outline-variant">
            <Icon name="dns" className="text-4xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">No MCP servers configured</p>
            <p className="text-on-surface-variant text-sm mt-1">
              Add an MCP server to connect external tools
            </p>
          </div>
        )}

        {/* Server list */}
        {!loading && servers.length > 0 && (
          <div className="space-y-2">
            {servers.map((srv) => (
              <div key={srv.id} className="bg-surface rounded-lg border border-outline-variant">
                {/* Server header row */}
                <div className="p-4 flex items-start gap-4">
                  <div className="p-2 bg-surface-container rounded-lg">
                    <Icon name="dns" className="text-xl text-on-surface-variant" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium text-on-surface">{srv.name}</h3>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          srv.enabled
                            ? 'bg-success-container text-success'
                            : 'bg-surface-container-high text-on-surface-variant'
                        }`}
                      >
                        {srv.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      {srv.group_id ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-medium">
                          {groups.find((g) => g.id === srv.group_id)?.name || 'Group'}
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-medium">App</span>
                      )}
                    </div>
                    <p className="text-sm text-on-surface-variant mt-1 font-mono text-ellipsis overflow-hidden">
                      {srv.url}
                    </p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-on-surface-variant">
                      <span>
                        {srv.tools.length} tool{srv.tools.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {srv.tools.length > 0 && (
                      <Tooltip content={expandedId === srv.id ? 'Collapse tools' : 'Expand tools'}>
                        <button
                          onClick={() => toggleExpand(srv.id)}
                          className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-on-surface-variant hover:bg-surface-container-high rounded transition-colors"
                        >
                          {expandedId === srv.id ? (
                            <Icon name="expand_more" className="text-base" />
                          ) : (
                            <Icon name="chevron_right" className="text-base" />
                          )} {srv.tools.length} tools
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Refresh tools">
                      <button
                        onClick={() => handleRefresh(srv.id)}
                        disabled={refreshing === srv.id}
                        className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-green-600 hover:bg-success-container rounded transition-colors disabled:opacity-50"
                      >
                        <Icon
                          name="refresh"
                          className={`text-base ${refreshing === srv.id ? 'animate-spin' : ''}`}
                        /> Refresh
                      </button>
                    </Tooltip>
                    <Tooltip content="Edit server">
                      <button
                        onClick={() => handleEdit(srv)}
                        className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors"
                      >
                        <Icon name="edit" className="text-base" /> Edit
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete server">
                      <button
                        onClick={() => handleDelete(srv.id)}
                        disabled={deleting === srv.id}
                        className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors disabled:opacity-50"
                      >
                        <Icon name="delete" className="text-base" /> Delete
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* Expandable tools list */}
                {expandedId === srv.id && srv.tools.length > 0 && (
                  <div className="border-t bg-surface-container rounded-b-lg">
                    <div className="px-4 py-2">
                      <p className="text-xs font-medium text-on-surface-variant uppercase tracking-wider mb-2">
                        Available Tools
                      </p>
                      <div className="space-y-1">
                        {srv.tools.map((tool: any) => (
                          <div
                            key={tool.name}
                            className="bg-surface rounded border border-outline-variant px-3 py-2"
                          >
                            <p className="text-sm font-medium text-on-surface">
                              {tool.name}
                            </p>
                            {tool.description && (
                              <p className="text-xs text-on-surface-variant mt-0.5">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {deleteConfirm.dialog}
      </div>
    </div>
  );
}
