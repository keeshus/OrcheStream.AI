import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { API_URL, api } from '@/lib/api-client';
import { useConfirm } from '@/lib/useConfirm';
import { useAuth } from '@/lib/auth-context';
import { useAssistantContext } from '@/hooks/useAssistantContext';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

export default function SecretsPage() {
  const { user } = useAuth();
  const can = (perm: string) => user?.permissions?.includes(perm) ?? false;
  const isAdmin = can('admin');
  useAssistantContext({ pageKey: 'settings:secrets', description: 'Managing secrets' });

  const [secrets, setSecrets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [reEncrypting, setReEncrypting] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, { value: string; expiresAt: number }>>({});
  const [now, setNow] = useState(Date.now());
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [editingSaving, setEditingSaving] = useState(false);

  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');

  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [newSecretType, setNewSecretType] = useState<'core' | 'cyberark'>('core');
  const [newSecretSaving, setNewSecretSaving] = useState(false);
  const [formGroupId, setFormGroupId] = useState('');

  const deleteConfirm = useConfirm({ title: 'Delete secret?', message: 'Are you sure you want to delete this secret? This cannot be undone.' });
  const rotateConfirm = useConfirm({ title: 'Rotate encryption key?', message: 'Rotate the root encryption key used to encrypt all secrets at rest?', confirmLabel: 'Rotate' });
  const reEncryptConfirm = useConfirm({ title: 'Re-encrypt secrets?', message: 'Re-encrypt all secrets with the current key?', confirmLabel: 'Re-encrypt' });

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const g = isAdmin
      ? fetch(`${API_URL}/groups`, { credentials: 'include' }).then(r => r.ok ? r.json() : [])
      : Promise.resolve(user?.groups || []);
    g.then(setGroups).catch(() => {});
  }, [isAdmin, user?.groups]);

  const fetchSecrets = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (selectedGroupId) {
        const res = await fetch(`${API_URL}/secrets?scope=group&scopeId=${selectedGroupId}`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load secrets');
        const data = await res.json();
        setSecrets(Array.isArray(data) ? data.map((s: any) => ({ ...s, _scope: 'group', _groupName: groups.find(g => g.id === selectedGroupId)?.name })) : []);
      } else {
        const [appRes, ...groupResponses] = await Promise.all([
          fetch(`${API_URL}/secrets?scope=app`, { credentials: 'include' }),
          ...groups.map(g =>
            fetch(`${API_URL}/secrets?scope=group&scopeId=${g.id}`, { credentials: 'include' })
              .then(async r => {
                const data = r.ok ? await r.json() : [];
                return Array.isArray(data) ? data.map((s: any) => ({ ...s, _scope: 'group', _groupName: g.name })) : [];
              })
              .catch(() => [] as any[])
          ),
        ]);
        const appData = appRes.ok ? await appRes.json() : [];
        setSecrets([
          ...(Array.isArray(appData) ? appData.map((s: any) => ({ ...s, _scope: 'app' })) : []),
          ...groupResponses.flat(),
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load secrets');
    } finally { setLoading(false); }
  }, [selectedGroupId, groups]);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  const resetForm = () => {
    setNewSecretName(''); setNewSecretValue(''); setNewSecretType('core'); setFormGroupId('');
    setShowForm(false);
  };

  const handleCreate = async () => {
    if (!newSecretName || (newSecretType === 'core' && !newSecretValue) || (newSecretType === 'cyberark' && !newSecretValue)) {
      setError('Please fill in all required fields.');
      return;
    }
    setNewSecretSaving(true); setError(null);
    try {
      const scope = formGroupId ? 'group' : 'app';
      const body: Record<string, unknown> = { name: newSecretName, scope, secretType: newSecretType };
      if (formGroupId) {
        body.scopeId = formGroupId;
        if (newSecretType === 'core') body.value = newSecretValue;
        else body.referencePath = newSecretValue;
      } else {
        body.value = newSecretValue;
      }
      const res = await fetch(`${API_URL}/secrets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: 'Create failed' }));
        throw new Error(errBody.message || errBody.error || 'Create failed');
      }
      resetForm();
      await fetchSecrets();
    } catch (err) { setError(err instanceof Error ? err.message : 'Create failed'); }
    finally { setNewSecretSaving(false); }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    setDeleting(id);
    try {
      await fetch(`${API_URL}/secrets/${id}`, { method: 'DELETE', credentials: 'include' });
      await fetchSecrets();
    } catch { setError('Delete failed'); }
    finally { setDeleting(null); }
  };

  const handleReveal = async (id: string) => {
    const confirmed = await deleteConfirm.confirm({ title: 'Reveal secret?', message: 'Reveal the value? It will be visible for 10 seconds.', confirmLabel: 'Reveal' });
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_URL}/secrets/${id}/reveal`, { method: 'POST', credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRevealedSecrets(prev => ({ ...prev, [id]: { value: data.value, expiresAt: Date.now() + 10000 } }));
        setTimeout(() => setRevealedSecrets(prev => { const n = { ...prev }; delete n[id]; return n; }), 10000);
      }
    } catch {}
  };

  const handleEditSecret = async (id: string) => {
    if (!editingValue) { setError('Value is required.'); return; }
    setEditingSaving(true); setError(null);
    try {
      const target = secrets.find(s => s.id === id);
      const body: Record<string, unknown> = target?.secretType === 'cyberark'
        ? { referencePath: editingValue }
        : { value: editingValue };
      const res = await fetch(`${API_URL}/secrets/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Update failed');
      setEditingSecretId(null);
      setEditingValue('');
      await fetchSecrets();
    } catch (err) { setError(err instanceof Error ? err.message : 'Update failed'); }
    finally { setEditingSaving(false); }
  };

  const handleRotateKey = async () => {    const confirmed = await rotateConfirm.confirm();
    if (!confirmed) return;
    setRotating(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/secrets/rotate-key`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to rotate key');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to rotate key'); }
    finally { setRotating(false); }
  };

  const handleReEncrypt = async () => {
    const confirmed = await reEncryptConfirm.confirm();
    if (!confirmed) return;
    setReEncrypting(true); setError(null);
    try {
      const res = await fetch(`${API_URL}/secrets/re-encrypt`, { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to re-encrypt');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to re-encrypt'); }
    finally { setReEncrypting(false); }
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
            <h1 className="text-2xl font-bold text-on-surface">Secrets</h1>
            <p className="text-sm text-on-surface-variant mt-1">Manage encrypted secrets for app-wide use and per-group scopes.</p>
          </div>
          {!showForm && (selectedGroupId || isAdmin) && (
            <button onClick={() => setShowForm(true)} className="m3-button gap-2">
              <Icon name="add" className="text-base" /> Add Secret
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
              onChange={(v) => { setSelectedGroupId(v); setShowForm(false); }}
              items={groups.map(function(g){return{value:g.id,label:g.name}})}
              includeAll={true}
              allLabel="All items"
            />
          </div>
        )}

        {/* Add secret form */}
        {showForm && (
          <div className="bg-surface rounded-xl border p-4 mb-6 space-y-3">
            <h3 className="text-sm font-semibold text-on-surface">New Secret</h3>
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
            <TextField label="Secret name" value={newSecretName} onChange={setNewSecretName} />
            {formGroupId && (
              <div className="flex gap-1">
                <button
                  onClick={() => setNewSecretType('core')}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    newSecretType === 'core' ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >Core</button>
                <button
                  onClick={() => setNewSecretType('cyberark')}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    newSecretType === 'cyberark' ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >CyberArk</button>
              </div>
            )}
            {!formGroupId && (
              <p className="text-[10px] text-on-surface-variant">CyberArk secrets are only available for group-level secrets because vaults are configured per group.</p>
            )}
            {formGroupId && newSecretType === 'cyberark' ? (
              <TextField label="Reference path" value={newSecretValue} onChange={setNewSecretValue} helpText="e.g. prod/db/password — resolved live from Conjur" showPasswordToggle />
            ) : (
              <TextField label="Value" type="password" value={newSecretValue} onChange={setNewSecretValue} showPasswordToggle />
            )}
            <div className="flex items-center gap-2 justify-end">
              <button type="button" onClick={resetForm} className="px-4 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors">Cancel</button>
              <Tooltip content={(!newSecretName || (newSecretType === 'core' && !newSecretValue) || (newSecretType === 'cyberark' && !newSecretValue)) ? 'Fill in all required fields' : ''}>
                <span>
                  <button onClick={handleCreate} disabled={newSecretSaving || !newSecretName || (newSecretType === 'core' && !newSecretValue) || (newSecretType === 'cyberark' && !newSecretValue)} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">{newSecretSaving ? 'Saving...' : 'Create'}</button>
                </span>
              </Tooltip>
            </div>
          </div>
        )}

        {/* Secrets list */}
        {loading ? (
          <p className="text-on-surface-variant text-sm">Loading...</p>
        ) : secrets.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border">
            <Icon name="key" className="text-5xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">
              {selectedGroupId ? 'No secrets in this group' : 'No secrets'}
            </p>
            <p className="text-xs text-on-surface-variant mt-1">
              {selectedGroupId ? 'Add a secret above.' : isAdmin ? 'Add an app-wide secret or select a group to manage group secrets.' : 'Select a group to manage group secrets.'}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {secrets.map(s => {
              const isAppSecret = s._scope === 'app';
              const readOnly = !isAdmin && isAppSecret;
              return (
                <div key={s.id} className="flex items-center justify-between bg-surface rounded-lg border px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-on-surface">{s.name}</span>
                    {s.secretType === 'cyberark' ? (
                      <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-surface-container-high text-on-surface-variant">CyberArk</span>
                    ) : (
                      <span className="ml-1 inline-flex items-center px-1 py-0.5 rounded text-[9px] font-medium bg-primary-container text-primary">Core</span>
                    )}
                    {s.maskedValue && (
                      <span className="text-xs font-mono text-on-surface-variant ml-2">{s.maskedValue}</span>
                    )}
                    {s._scope === 'app' ? (
                      <span className="text-[10px] text-on-surface-variant ml-2">app-wide</span>
                    ) : (
                      <span className="text-[10px] text-on-surface-variant ml-2">{s._groupName || 'group'}</span>
                    )}
                    {readOnly && <span className="text-[10px] text-on-surface-variant ml-1">· read-only</span>}
                    {revealedSecrets[s.id] && now < revealedSecrets[s.id].expiresAt && (
                      <span className="text-xs font-mono text-success ml-2">🔓 {revealedSecrets[s.id].value}</span>
                    )}
                  </div>
                  {editingSecretId === s.id ? (
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <TextField
                        label={s.secretType === 'cyberark' ? 'Reference path' : 'Value'}
                        type={s.secretType === 'cyberark' ? undefined : 'password'}
                        value={editingValue}
                        onChange={setEditingValue}
                        showPasswordToggle
                        className="w-56"
                        data-testid="edit-secret-value"
                      />
                      <button type="button" onClick={() => { setEditingSecretId(null); setEditingValue(''); }} className="px-3 py-2 text-sm font-medium text-on-surface-variant bg-surface border border-outline rounded-lg hover:bg-surface-container-high transition-colors">Cancel</button>
                      <button data-testid="save-secret-value" onClick={() => handleEditSecret(s.id)} disabled={editingSaving || !editingValue} className="m3-button disabled:opacity-50 disabled:cursor-not-allowed">{editingSaving ? 'Saving...' : 'Save'}</button>
                    </div>
                  ) : !readOnly ? (
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      <Tooltip content="Edit value">
                        <button data-testid="edit-secret-btn" onClick={() => { setEditingSecretId(s.id); setEditingValue(''); }} className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded text-xs">
                          <Icon name="edit" className="text-sm" />
                        </button>
                      </Tooltip>
                      <Tooltip content="Reveal value">
                        <button onClick={() => handleReveal(s.id)} className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded text-xs">
                          <Icon name="visibility" className="text-sm" />
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete secret">
                        <button onClick={() => handleDelete(s.id)} disabled={deleting === s.id} className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container rounded text-xs">
                          <Icon name="delete" className="text-sm" />
                        </button>
                      </Tooltip>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      <Tooltip content="Reveal value">
                        <button onClick={() => handleReveal(s.id)} className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded text-xs">
                          <Icon name="visibility" className="text-sm" />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {can('admin') && (
          <div className="bg-surface rounded-xl border p-4 mt-8 space-y-3">
            <div className="flex items-center gap-2">
              <Icon name="vpn_key" className="text-xl text-on-surface-variant" />
              <div>
                <h3 className="text-sm font-semibold text-on-surface">Encryption Key Administration</h3>
                <p className="text-xs text-on-surface-variant">All secrets are encrypted at rest using a root encryption key. Rotating the key generates a new key for future secrets, while re-encrypting applies the current key to all existing secrets.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={handleRotateKey} disabled={rotating} className="px-4 py-2 text-sm font-medium text-primary border border-primary rounded-lg hover:bg-primary-container transition-colors disabled:opacity-50">
                {rotating ? 'Rotating...' : 'Rotate Key'}
              </button>
              <button onClick={handleReEncrypt} disabled={reEncrypting} className="px-4 py-2 text-sm font-medium text-error border border-error rounded-lg hover:bg-error-container transition-colors disabled:opacity-50">
                {reEncrypting ? 'Re-encrypting...' : 'Re-encrypt All'}
              </button>
            </div>
          </div>
        )}
      </div>
      {deleteConfirm.dialog}
      {rotateConfirm.dialog}
      {reEncryptConfirm.dialog}
    </div>
  );
}
