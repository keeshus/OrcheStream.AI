import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface Group {
  id: string;
  name: string;
}

interface Vault {
  id: string;
  name: string;
  base_url: string;
  account: string;
  login: string;
  hasApiKey: boolean;
  ca_cert: string | null;
  self_hosted: boolean;
  connected: boolean;
  groups: Group[];
}

interface FormState {
  name: string;
  baseUrl: string;
  account: string;
  login: string;
  apiKey: string;
  caCert: string;
  selfHosted: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  baseUrl: '',
  account: 'conjur',
  login: '',
  apiKey: '',
  caCert: '',
  selfHosted: false,
};

export default function SecretVaultsPage() {
  const { user } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;

  const [vaults, setVaults] = useState<Vault[]>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [filterGroupId, setFilterGroupId] = useState<string | null>(null);
  const [formGroupId, setFormGroupId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useAssistantContext({ pageKey: 'settings:secret-vaults', description: 'Managing secret vaults' });
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteConfirm = useConfirm({ title: 'Delete vault?', message: 'Are you sure you want to delete this secret vault? This cannot be undone.' });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});

  const fetchVaults = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.secretVaults.list(filterGroupId ? { groupId: filterGroupId } : undefined);
      setVaults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load secret vaults');
    } finally {
      setLoading(false);
    }
  };

  const isAdmin = can('admin');

  useEffect(() => {
    fetchVaults();
  }, [filterGroupId]);

  useEffect(() => {
    const g = isAdmin
      ? fetch('/api/groups', { credentials: 'include' }).then(r => r.ok ? r.json() : [])
      : Promise.resolve(user?.groups || []);
    g.then(setGroups).catch(() => {});
  }, [isAdmin, user?.groups]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormGroupId('');
    setShowForm(false);
  };

  const handleEdit = (v: Vault) => {
    setForm({
      name: v.name,
      baseUrl: v.base_url,
      account: v.account,
      login: v.login,
      apiKey: '',
      caCert: v.ca_cert || '',
      selfHosted: v.self_hosted,
    });
    setEditingId(v.id);
    setShowForm(true);
  };

  const handleDelete = async (v: Vault) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    setDeleting(v.id);
    try {
      await api.secretVaults.delete(v.id);
      setVaults((prev) => prev.filter((vault) => vault.id !== v.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete vault');
    } finally {
      setDeleting(null);
    }
  };

  const handleTestConnection = async (id: string) => {
    setTesting(id);
    setTestResults((prev) => ({ ...prev, [id]: undefined as any }));
    try {
      const result = await api.secretVaults.test(id);
      setTestResults((prev) => ({ ...prev, [id]: result.success ?? true }));
      if (!result.success) {
        setError(result.error || 'Connection test failed');
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [id]: false }));
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    const body: Record<string, unknown> = {
      name: form.name,
      baseUrl: form.baseUrl,
      login: form.login,
      apiKey: form.apiKey,
      groupId: formGroupId || undefined,
    };
    if (form.account) body.account = form.account;
    if (form.caCert) body.caCert = form.caCert;
    if (form.selfHosted) body.selfHosted = true;

    try {
      if (editingId) {
        const updated = await api.secretVaults.update(editingId, body);
        setVaults((prev) => prev.map((v) => (v.id === editingId ? updated : v)));
      } else {
        const created = await api.secretVaults.create(body);
        setVaults((prev) => [...prev, created]);
      }
      resetForm();
      fetchVaults();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save vault');
    } finally {
      setSaving(false);
    }
  };

  if (!can('admin') && !can('vaults:write')) {
    return (
      <div className="min-h-screen bg-surface-container">
        <div className="max-w-4xl mx-auto p-6">
          <div className="text-center py-16 bg-surface rounded-lg border border-outline-variant">
            <Icon name="lock" className="text-4xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">Access denied</p>
            <p className="text-on-surface-variant text-sm mt-1">You do not have permission to view this page.</p>
          </div>
        </div>
      </div>
    );
  }

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
            <h1 className="text-2xl font-bold text-on-surface">Secret Vaults</h1>
            <p className="text-sm text-on-surface-variant mt-1">
              Manage external secret vault connections for credential lookup
            </p>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="m3-button gap-2"
            >
              <Icon name="add" className="text-base" />
              Add Vault
            </button>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 bg-error-container border border-red-200 rounded-lg flex items-center gap-2 text-sm text-error">
            <Icon name="error" className="text-base flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Group filter */}
        {groups.length > 0 && (
          <div className="mb-4 max-w-xs">
            <SearchableSelect
              label="Filter by group"
              value={filterGroupId || ''}
              onChange={(v) => setFilterGroupId(v || null)}
              items={groups.map(g => ({ value: g.id, label: g.name }))}
              includeAll={true}
              allLabel="All items"
            />
          </div>
        )}

        {/* Add / Edit form */}
        {showForm && (
          <form
            onSubmit={handleSubmit}
            className="mb-6 bg-surface rounded-lg border border-outline-variant p-5 space-y-4"
          >
            <h2 className="text-base font-semibold text-on-surface">
              {editingId ? 'Edit Vault' : 'New Vault'}
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TextField
                label="Name"
                value={form.name}
                onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              />

              {!editingId && groups.length > 0 && (
                <SearchableSelect
                  label="Bind to group (required)"
                  value={formGroupId}
                  onChange={setFormGroupId}
                  items={groups.map(g => ({ value: g.id, label: g.name }))}
                  includeAll={false}
                  placeholder="Select a group..."
                />
              )}

              <TextField
                label="URL"
                value={form.baseUrl}
                onChange={(v) => setForm((f) => ({ ...f, baseUrl: v }))}
                helpText="CyberArk Conjur base URL, e.g. https://conjur.example.com"
              />

              <TextField
                label="Conjur Account"
                value={form.account}
                onChange={(v) => setForm((f) => ({ ...f, account: v }))}
                helpText="Default: conjur (for Conjur Cloud: conjur)"
              />

              <TextField
                label="Login"
                value={form.login}
                onChange={(v) => setForm((f) => ({ ...f, login: v }))}
                helpText="For host identities: host%2Fmyapp"
              />

              <TextField
                label="API Key"
                type="password"
                value={form.apiKey}
                onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))}
                helpText={editingId ? 'Leave blank to keep current' : undefined}
              />

              <label className="flex items-center gap-2 text-sm cursor-pointer col-span-2">
                <input type="checkbox" checked={form.selfHosted} onChange={(e) => setForm(f => ({ ...f, selfHosted: e.target.checked }))} className="rounded accent-primary" />
                <span className="text-on-surface">Self-hosted Conjur (omit /api prefix)</span>
              </label>

              <div className="col-span-2">
                <label className="text-xs font-medium text-on-surface-variant block mb-1">CA Certificate</label>
                <textarea
                  value={form.caCert}
                  onChange={(e) => setForm((f) => ({ ...f, caCert: e.target.value }))}
                  rows={4}
                  className="w-full rounded border border-outline p-2 text-sm bg-surface font-mono"
                  placeholder="Paste CA certificate content here..."
                />
                <p className="mt-1 text-[10px] text-on-surface-variant">Optional. Used for self-signed or internal CA certificates.</p>
              </div>
            </div>

            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors"
              >
                Cancel
              </button>
              <Tooltip content={(!form.name || !form.baseUrl || !form.login || (!editingId && !form.apiKey)) ? 'Fill in all required fields' : (!editingId && !formGroupId) ? 'Select a group' : ''}>
                <span>
                  <button
                    type="submit"
                    disabled={saving || !form.name || !form.baseUrl || !form.login || (!editingId && !form.apiKey) || (!editingId && !formGroupId)}
                    className="m3-button disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving...' : editingId ? 'Update Vault' : 'Create Vault'}
                  </button>
                </span>
              </Tooltip>
            </div>
          </form>
        )}

        {/* Loading state */}
        {loading && (
          <div className="text-center py-12 text-on-surface-variant text-sm">
            Loading secret vaults...
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && vaults.length === 0 && (
          <div className="text-center py-16 bg-surface rounded-lg border border-outline-variant">
            <Icon name="lock" className="text-4xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">No vaults configured</p>
            <p className="text-on-surface-variant text-sm mt-1">
              Add a vault to manage external secrets
            </p>
          </div>
        )}

        {/* Vault list */}
        {!loading && vaults.length > 0 && (
          <div className="space-y-3">
            {vaults.map((v) => (
              <div
                key={v.id}
                className="bg-surface rounded-lg border border-outline-variant p-4 flex items-start gap-4"
              >
                <div className="p-2 bg-surface-container rounded-lg">
                  <Icon name="lock" className="text-xl text-on-surface-variant" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-on-surface">{v.name}</h3>
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        v.connected ? 'bg-success' : 'bg-error'
                      }`}
                      title={v.connected ? 'Connected' : 'Disconnected'}
                    />
                  </div>
                  <p className="text-sm text-on-surface-variant mt-1 font-mono text-ellipsis overflow-hidden whitespace-nowrap">
                    {v.base_url}
                  </p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-on-surface-variant">
                    <span>{v.groups.length} group{v.groups.length !== 1 ? 's' : ''}</span>
                    {v.groups.length > 0 && (
                      <span className="text-on-surface-variant">
                        — {v.groups.map((g) => g.name).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Tooltip content="Test connection">
                    <button
                      onClick={() => handleTestConnection(v.id)}
                      disabled={testing === v.id}
                      className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-green-600 hover:bg-success-container rounded transition-colors disabled:opacity-50"
                    >
                      {testing === v.id ? (
                        <Icon name="sync" className="text-base animate-spin" />
                      ) : testResults[v.id] === true ? (
                        <Icon name="check_circle" className="text-base text-success" />
                      ) : testResults[v.id] === false ? (
                        <Icon name="cancel" className="text-base text-error" />
                      ) : (
                        <Icon name="wifi_find" className="text-base" />
                      )} Test
                    </button>
                  </Tooltip>
                  <Tooltip content="Edit vault">
                    <button
                      onClick={() => handleEdit(v)}
                      className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors"
                    >
                      <Icon name="edit" className="text-base" /> Edit
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete vault">
                    <button
                      onClick={() => handleDelete(v)}
                      disabled={deleting === v.id}
                      className="flex items-center gap-1 p-2 text-xs text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors disabled:opacity-50"
                    >
                      <Icon name="delete" className="text-base" /> Delete
                    </button>
                  </Tooltip>
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
