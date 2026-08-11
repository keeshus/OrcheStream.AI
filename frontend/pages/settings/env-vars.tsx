import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { API_URL } from '@/lib/api-client';
import { useConfirm } from '@/lib/useConfirm';
import { useAuth } from '@/lib/auth-context';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface EnvVarEntry {
  name: string;
  type: 'static' | 'core_secret' | 'cyberark';
  value: string;
}

export default function EnvVarsPage() {
  const { user } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const isAdmin = can('admin');
  useAssistantContext({ pageKey: 'settings:env-vars', description: 'Managing environment variables' });

  const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingType, setEditingType] = useState<'static' | 'core_secret' | 'cyberark'>('static');
  const [editingSaving, setEditingSaving] = useState(false);

  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [formGroupId, setFormGroupId] = useState('');

  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newType, setNewType] = useState<'static' | 'core_secret' | 'cyberark'>('static');
  const [newSaving, setNewSaving] = useState(false);

  const [availableSecrets, setAvailableSecrets] = useState<Array<{ id: string; name: string }>>([]);

  const deleteConfirm = useConfirm({ title: 'Delete environment variable?', message: 'Are you sure you want to delete this environment variable? This cannot be undone.' });

  const fetchEnvVars = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let items: any[] = [];
      if (selectedGroupId) {
        const res = await fetch(`${API_URL}/env-vars/groups/${selectedGroupId}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load environment variables');
        const raw = await res.json();
        items = (Array.isArray(raw) ? raw : raw?.envVars || []).map((v: any) => ({ ...v, _scope: 'group', _groupName: groups.find(g => g.id === selectedGroupId)?.name }));
      } else {
        // Fetch app-level + all groups
        const appRes = await fetch(`${API_URL}/env-vars`, { credentials: 'include' });
        const appData = appRes.ok ? (await appRes.json()) : [];
        items = Array.isArray(appData) ? appData.map((v: any) => ({ ...v, _scope: 'app' })) : [];
        const groupResults = await Promise.all(
          groups.map(g =>
            fetch(`${API_URL}/env-vars/groups/${g.id}`, { credentials: 'include' })
              .then(r => r.ok ? r.json() : [])
              .then(data => (Array.isArray(data) ? data : []).map((v: any) => ({ ...v, _scope: 'group', _groupName: g.name })))
              .catch(() => [])
          )
        );
        items = [...items, ...groupResults.flat()];
      }
      setEnvVars(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load environment variables');
    } finally { setLoading(false); }
  }, [selectedGroupId, groups]);

  useEffect(() => { fetchEnvVars(); }, [fetchEnvVars]);

  useEffect(() => {
    const g = isAdmin
      ? fetch(`${API_URL}/groups`, { credentials: 'include' }).then(r => r.ok ? r.json() : [])
      : Promise.resolve(user?.groups || []);
    g.then(setGroups).catch(() => {});
  }, [isAdmin, user?.groups]);

  useEffect(() => {
    const fetchSecrets = async () => {
      const appRes = await fetch(`${API_URL}/secrets?scope=app`, { credentials: 'include' });
      const appData = appRes.ok ? await appRes.json() : [];
      let allSecrets = Array.isArray(appData) ? [...appData] : [];
      if (formGroupId) {
        const grpRes = await fetch(`${API_URL}/secrets?scope=group&scopeId=${formGroupId}`, { credentials: 'include' });
        const grpData = grpRes.ok ? await grpRes.json() : [];
        if (Array.isArray(grpData)) allSecrets = [...allSecrets, ...grpData];
      }
      setAvailableSecrets(allSecrets);
    };
    fetchSecrets();
  }, [formGroupId]);

  const saveEnvVars = async (vars: EnvVarEntry[], groupIdOverride?: string | null) => {
    const body = { envVars: vars };
    const url = groupIdOverride !== undefined
      ? (groupIdOverride ? `${API_URL}/env-vars/groups/${groupIdOverride}` : `${API_URL}/env-vars`)
      : (formGroupId
        ? `${API_URL}/env-vars/groups/${formGroupId}`
        : `${API_URL}/env-vars`);
    const res = await fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: 'Save failed' }));
      throw new Error(errBody.message || errBody.error || 'Save failed');
    }
  };

  const resetForm = () => {
    setNewName(''); setNewValue(''); setNewType('static'); setFormGroupId('');
    setShowForm(false);
  };

  const handleCreate = async () => {
    if (!newName || !newValue) {
      setError('Please fill in all required fields.');
      return;
    }
    setNewSaving(true); setError(null);
    try {
      const entry: EnvVarEntry = { name: newName.trim(), type: newType, value: newValue };
      // Only include items from the current scope (don't mix scopes when saving)
      const isAppItem = (v: any) => !v._scope || v._scope === 'app';
      const scopeItems = (envVars as any[]).filter(v => formGroupId ? v._scope === 'group' && v._groupName === groups.find(g => g.id === formGroupId)?.name : isAppItem(v));
      await saveEnvVars([...scopeItems, entry]);
      resetForm();
      await fetchEnvVars();
    } catch (err) { setError(err instanceof Error ? err.message : 'Create failed'); }
    finally { setNewSaving(false); }
  };

  const handleDelete = async (name: string, scope?: string, groupName?: string) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    setDeleting(name);
    try {
      const isGroup = scope === 'group' && groupName;
      const g = isGroup ? groups.find(g => g.name === groupName) : null;
      const url = g ? `${API_URL}/env-vars/groups/${g.id}` : `${API_URL}/env-vars`;
      const allItems = envVars as any[];
      const isAppItem = (v: any) => !v._scope || v._scope === 'app';
      const scopeItems = g
        ? allItems.filter(v => v._scope === 'group' && v._groupName === groupName)
        : allItems.filter(v => isAppItem(v));
      const res = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ envVars: scopeItems.filter((v: any) => v.name !== name).map((v: any) => ({ name: v.name, type: v.type, value: v.value })) }),
      });
      if (!res.ok) throw new Error('Delete failed');
      await fetchEnvVars();
    } catch { setError('Delete failed'); }
    finally { setDeleting(null); }
  };

  const handleEdit = async (name: string) => {
    if (!editingValue) { setError('Value is required.'); return; }
    setEditingSaving(true); setError(null);
    try {
      // Determine the edited row's scope from the row itself (the Add form's
      // formGroupId is unrelated to inline editing).
      const target = (envVars as any[]).find(v => v.name === name);
      const isGroup = target?._scope === 'group' && target?._groupName;
      const g = isGroup ? groups.find(g => g.name === target._groupName) : null;
      const isAppItem = (v: any) => !v._scope || v._scope === 'app';
      const scopeItems = g
        ? (envVars as any[]).filter(v => v._scope === 'group' && v._groupName === target._groupName)
        : (envVars as any[]).filter(v => isAppItem(v));
      const updated = scopeItems.map((v: any) =>
        v.name === name ? { ...v, type: editingType, value: editingValue } : v
      );
      await saveEnvVars(updated, g ? g.id : null);
      setEditingName(null); setEditingValue('');
      await fetchEnvVars();
    } catch (err) { setError(err instanceof Error ? err.message : 'Update failed'); }
    finally { setEditingSaving(false); }
  };

  // App-scope env vars are admin-only. Group-scope env vars can be edited by
  // admins and by the group's admins (the backend enforces membership role
  // 'admin' for non-admin users).
  const isGroupAdmin = (groupId: string | null) => {
    if (!groupId) return false;
    return isAdmin || (user?.groups || []).some(g => g.id === groupId && g.role === 'admin');
  };
  // Page-level read-only when nothing is editable; per-row read-only is
  // computed in the row render below.
  const readOnly = selectedGroupId ? !isGroupAdmin(selectedGroupId) : !isAdmin;

  const typeOptions = [
    { value: 'static', label: 'Static' },
    { value: 'core_secret', label: 'Core Secret' },
    ...(formGroupId ? [{ value: 'cyberark', label: 'CyberArk' }] : []),
  ];

  const secretOptions = availableSecrets.map(s => ({ value: s.name, label: s.name }));

  const badge = (type: string) => {
    switch (type) {
      case 'static':
        return <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-surface-container-high text-on-surface-variant">Static</span>;
      case 'core_secret':
        return <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-primary-container text-primary">Core Secret</span>;
      case 'cyberark':
        return <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-secondary-container text-on-surface">CyberArk</span>;
      default:
        return null;
    }
  };

  const renderValueField = (type: string, value: string, onChange: (v: string) => void, label: string) => {
    if (type === 'core_secret') {
      return (
        <SelectField
          label={label}
          value={value}
          onChange={onChange}
          options={[
            { value: '', label: '— Select a secret —' },
            ...secretOptions,
          ]}
        />
      );
    }
    if (type === 'cyberark') {
      return (
        <TextField
          label={label}
          value={value}
          onChange={onChange}
        />
      );
    }
    return (
      <TextField
        label={label}
        value={value}
        onChange={onChange}
      />
    );
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
          <div className="flex-1">
            <h1 data-testid="env-vars-heading" className="text-2xl font-bold text-on-surface">Environment Variables</h1>
            <p className="text-sm text-on-surface-variant mt-1">Manage environment variables for app-wide use and per-group scopes.</p>
          </div>
          {!showForm && (selectedGroupId || isAdmin) && (
            <button data-testid="add-variable-btn" onClick={() => setShowForm(true)} className="m3-button gap-2">
              <Icon name="add" className="text-base" /> Add Variable
            </button>
          )}
        </div>

        {error && <div className="bg-error-container border text-error text-sm rounded p-3 mb-4">{error}</div>}

        {/* Group filter */}
        {groups.length > 0 && (
          <div className="mb-4 max-w-xs">
            <SearchableSelect
              label="Filter by group"
              value={selectedGroupId}
              onChange={(v) => setSelectedGroupId(v)}
              items={groups.map(function(g){return{value:g.id,label:g.name}})}
              includeAll={true}
              allLabel="All items"
            />
          </div>
        )}

        {/* Add form */}
        {showForm && (
          <div data-testid="add-var-form" className="bg-surface rounded-xl border p-4 mb-6 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-on-surface">New Environment Variable</h3>
            </div>
            {groups.length > 0 && (
              <SearchableSelect
                label="Group"
                value={formGroupId}
                onChange={(v) => setFormGroupId(v)}
                items={groups.map(function(g){return{value:g.id,label:g.name}})}
                includeAll={true}
                allLabel="App-wide"
                className="col-span-1"
              />
            )}
            <TextField label="Variable name" value={newName} onChange={setNewName} />
            <SelectField
              label="Type"
              value={newType}
              onChange={(v) => { setNewType(v as 'static' | 'core_secret' | 'cyberark'); setNewValue(''); }}
              options={typeOptions}
            />
            {renderValueField(newType, newValue, setNewValue, 'Value')}
            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                data-testid="cancel-var-btn"
                onClick={resetForm}
                className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors"
              >
                Cancel
              </button>
              <Tooltip content={(!newName || !newValue) ? 'Fill in all required fields' : ''}>
                <span>
                  <button data-testid="create-var-btn" onClick={handleCreate} disabled={newSaving || !newName || !newValue} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">{newSaving ? 'Saving...' : 'Create'}</button>
                </span>
              </Tooltip>
            </div>
          </div>
        )}

        {/* Env vars list */}
        {loading ? (
          <p className="text-on-surface-variant text-sm">Loading...</p>
        ) : envVars.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border">
            <Icon name="code" className="text-5xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">
              {selectedGroupId ? 'No environment variables in this group' : 'No environment variables'}
            </p>
            <p className="text-xs text-on-surface-variant mt-1">
              {selectedGroupId ? 'Add a variable above.' : isAdmin ? 'Add an app-wide variable or select a group to manage group variables.' : 'Select a group to manage group variables.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {envVars.map(v => {
              const isEditing = editingName === v.name;
              return (
                <div key={(v as any)._scope ? `${v.name}-${(v as any)._scope}-${(v as any)._groupName || ''}` : v.name} data-testid="env-var-item" className="bg-surface rounded-lg border px-4 py-2.5">
                  {isEditing ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-on-surface">{v.name}</span>
                      </div>
                      <SelectField
                        label="Type"
                        value={editingType}
                        onChange={(val) => setEditingType(val as 'static' | 'core_secret' | 'cyberark')}
                        options={typeOptions}
                      />
                      {renderValueField(editingType, editingValue, setEditingValue, 'Value')}
                      <div className="flex items-center gap-2 justify-end">
                        <button type="button" onClick={() => { setEditingName(null); setEditingValue(''); }} className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors">Cancel</button>
                        <Tooltip content={!editingValue ? 'Fill in value' : ''}>
                          <span>
                            <button onClick={() => handleEdit(v.name)} disabled={editingSaving || !editingValue} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">{editingSaving ? 'Saving...' : 'Save'}</button>
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-on-surface">{v.name}</span>
                        {badge((v as any).type)}
                        <span className="text-xs font-mono text-on-surface-variant ml-2">{(v as any).value}</span>
                        {(v as any)._scope === 'app' ? (
                          <span className="text-[10px] text-on-surface-variant ml-2">app-wide</span>
                        ) : (v as any)._groupName ? (
                          <span className="text-[10px] text-on-surface-variant ml-2">{(v as any)._groupName}</span>
                        ) : null}
                        {readOnly && <span className="text-[10px] text-on-surface-variant ml-1">· read-only</span>}
                      </div>
                      {!readOnly && (
                        <div className="flex items-center gap-1 shrink-0 ml-3">
                          <Tooltip content="Edit variable">
                            <button data-testid="edit-var-btn" onClick={() => { setEditingName(v.name); setEditingValue(v.value); setEditingType(v.type); }} className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded text-xs">
                              <Icon name="edit" className="text-sm" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete variable">
                            <button data-testid="delete-var-btn" onClick={() => handleDelete(v.name, (v as any)._scope, (v as any)._groupName)} disabled={deleting === v.name} className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container rounded text-xs">
                              <Icon name="delete" className="text-sm" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {deleteConfirm.dialog}
    </div>
  );
}
