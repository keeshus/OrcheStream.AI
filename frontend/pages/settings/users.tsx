import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { SelectField } from '@/components/ui/SelectField';
import { API_URL } from '@/lib/api-client';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface Role {
  id: string;
  name: string;
}

interface User {
  id: string;
  email: string;
  name: string;
  role_id: string | null;
  role_name: string | null;
  provider: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  groups?: Array<{ id: string; name: string; provider: string }>;
}

export default function UsersSettingsPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [allGroups, setAllGroups] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const deleteConfirm = useConfirm({ title: 'Delete user?', message: 'Delete this user? This cannot be undone.' });
  useAssistantContext({ pageKey: 'settings:users', description: 'Managing users' });
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [groupUser, setGroupUser] = useState<User | null>(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [savingGroups, setSavingGroups] = useState(false);

  const handleCreate = async () => {
    if (!newName || !newEmail || !newPassword) { setCreateError('All fields required'); return; }
    if (newPassword.length < 8) { setCreateError('Password must be at least 8 characters'); return; }
    setCreating(true);
    setCreateError('');
    try {
      // Use the admin-only endpoint — register would set a session cookie
      // for the new user and hijack the admin's session.
      const res = await fetch(`${API_URL}/users`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: newEmail, password: newPassword, name: newName }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: 'User creation failed' })); throw new Error(err.error); }
      setShowCreate(false);
      setNewName(''); setNewEmail(''); setNewPassword('');
      await load();
    } catch (err: any) { setCreateError(err.message); }
    finally { setCreating(false); }
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [usersRes, rolesRes, groupsRes] = await Promise.all([
        fetch(`${API_URL}/users`, { credentials: 'include' }),
        fetch(`${API_URL}/roles`, { credentials: 'include' }),
        fetch(`${API_URL}/groups`, { credentials: 'include' }),
      ]);
      if (!usersRes.ok || !rolesRes.ok || !groupsRes.ok) throw new Error('Failed to load');
      setUsers(await usersRes.json());
      setRoles(await rolesRes.json());
      setAllGroups(await groupsRes.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filteredUsers = search
    ? users.filter(u =>
        u.name.toLowerCase().includes(search.toLowerCase()) ||
        u.email.toLowerCase().includes(search.toLowerCase()) ||
        (u.role_name || '').toLowerCase().includes(search.toLowerCase()) ||
        u.provider.toLowerCase().includes(search.toLowerCase()) ||
        (u.groups || []).some(g => g.name.toLowerCase().includes(search.toLowerCase()))
      )
    : users;

  const handleRoleChange = async (userId: string, roleId: string) => {
    try {
      const res = await fetch(`${API_URL}/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role_id: roleId || null }),
      });
      if (!res.ok) throw new Error('Failed to update role');
      setUsers(prev => prev.map(u => {
        if (u.id !== userId) return u;
        const role = roles.find(r => r.id === roleId);
        return { ...u, role_id: roleId || null, role_name: role?.name || null };
      }));
    } catch (err: any) {
      setError(err.message);
    }
  };

const openGroupManager = (u: User) => {
  setGroupUser(u);
  setSelectedGroupIds((u.groups || []).map(g => g.id));
};

  const handleDelete = async (userId: string) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    setDeleting(userId);
    try {
      const res = await fetch(`${API_URL}/users/${userId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete user');
      setUsers(prev => prev.filter(u => u.id !== userId));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDeleting(null);
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
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-on-surface">Users</h1>
            <p className="text-sm text-on-surface-variant mt-1">Manage user accounts and roles</p>
          </div>
          <button onClick={() => setShowCreate(true)} className="m3-button">
            <Icon name="add" className="text-xs" /> Create User
          </button>

        </div>

        <div className="mb-4 max-w-xs">
          <TextField label="Search users" value={search} onChange={setSearch} />
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
        ) : users.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border border-outline-variant">
            <Icon name="shield" className="text-5xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">No users</p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border border-outline-variant">
            <Icon name="search_off" className="text-5xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">No users match your search</p>
          </div>
        ) : (
          <div className="bg-surface rounded-xl border border-outline-variant overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-surface-container">
                  <th className="text-left p-3 font-medium text-on-surface-variant text-xs uppercase tracking-wider">Name</th>
                  <th className="text-left p-3 font-medium text-on-surface-variant text-xs uppercase tracking-wider">Email</th>
                  <th className="text-left p-3 font-medium text-on-surface-variant text-xs uppercase tracking-wider">Role</th>
                  <th className="text-left p-3 font-medium text-on-surface-variant text-xs uppercase tracking-wider">Provider</th>
                  <th className="text-left p-3 font-medium text-on-surface-variant text-xs uppercase tracking-wider">Groups</th>
                  <th className="text-left p-3 font-medium text-on-surface-variant text-xs uppercase tracking-wider">Last Login</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map(u => (
                  <tr key={u.id} className="border-b last:border-0 hover:bg-surface-container-high">
                    <td className="p-3 font-medium text-on-surface">{u.name}</td>
                    <td className="p-3 text-on-surface-variant">{u.email}</td>
                    <td className="p-3">
                      <SelectField
                        label="Role"
                        value={u.role_id || roles[0]?.id || ''}
                        onChange={(v) => handleRoleChange(u.id, v)}
                        options={roles.map(r => ({ value: r.id, label: r.name }))}
                      />
                    </td>
                    <td className="p-3 text-on-surface-variant capitalize">{u.provider}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1">
                        {(u as any).groups?.map((g: any) => (
                          <span key={g.id} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-secondary-container text-on-secondary-container font-medium">
                            {g.name}
                          </span>
                        ))}
                        {(!(u as any).groups || (u as any).groups.length === 0) && <span className="text-xs text-on-surface-variant">—</span>}
                      </div>
                    </td>
                    <td className="p-3 text-on-surface-variant text-xs">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('nl-NL') : 'never'}
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip content="Manage groups">
                          <button
                            onClick={() => openGroupManager(u)}
                            className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-primary hover:bg-primary-container rounded transition-colors"
                          >
                            <Icon name="group" className="text-base" /> Groups
                          </button>
                        </Tooltip>
                        <Tooltip content="Delete user">
                          <button
                            onClick={() => handleDelete(u.id)}
                            disabled={deleting === u.id}
                            className="flex items-center gap-1 p-1.5 text-xs text-on-surface-variant hover:text-error hover:bg-error-container disabled:opacity-50 rounded transition-colors"
                          >
                            {deleting === u.id ? <Icon name="sync" className="text-base animate-spin" /> : <Icon name="delete" className="text-base" />} Delete
                          </button>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>
      {deleteConfirm.dialog}

      {/* Manage Groups Dialog */}
      {groupUser && (
        <div data-co-pilot-modal="user-groups" className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setGroupUser(null)}>
          <div className="bg-surface rounded-lg shadow-m3-4 max-w-md w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-on-surface">Groups for {groupUser.name}</h3>
              <button onClick={() => setGroupUser(null)} className="flex items-center gap-1 text-on-surface-variant hover:text-error hover:bg-error-container p-1.5 rounded transition-colors"><Icon name="close" className="text-base" /> Close</button>
            </div>
            {savingGroups && <div className="text-sm text-on-surface-variant mb-3">Saving...</div>}
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {allGroups.map(g => {
                const isSelected = selectedGroupIds.includes(g.id);
                return (
                  <label key={g.id} className="flex items-center gap-3 p-2 rounded hover:bg-surface-container-high cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        setSelectedGroupIds(prev =>
                          isSelected ? prev.filter(id => id !== g.id) : [...prev, g.id]
                        );
                      }}
                      className="rounded accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-on-surface">{g.name}</span>
                      <span className={`ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        g.provider === 'local' ? 'bg-primary-container text-primary' : 'bg-secondary-container text-on-secondary-container'
                      }`}>{g.provider}</span>
                    </div>
                  </label>
                );
              })}
            </div>
            <button
              onClick={async () => {
                setSavingGroups(true);
                try {
                  await fetch(`${API_URL}/users/${groupUser.id}/groups`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ groupIds: selectedGroupIds }),
                  });
                  setGroupUser(null);
                } catch {} finally { setSavingGroups(false); }
              }}
              disabled={savingGroups}
              className="w-full m3-button mt-4 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreate && (
        <div data-co-pilot-modal="create-user" className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setShowCreate(false)}>
          <div className="bg-surface rounded-lg shadow-m3-4 max-w-md w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-on-surface">Create User</h3>
              <button onClick={() => setShowCreate(false)} className="flex items-center gap-1 text-on-surface-variant hover:text-error hover:bg-error-container p-1.5 rounded transition-colors"><Icon name="close" className="text-base" /> Close</button>
            </div>
            {createError && <div className="bg-error-container border border-red-200 text-error text-sm rounded p-3 mb-4">{createError}</div>}
            <div className="space-y-3">
              <TextField label="Name" value={newName} onChange={setNewName} />
              <TextField label="Email" type="email" value={newEmail} onChange={setNewEmail} />
              <TextField label="Password" type="password" value={newPassword} onChange={setNewPassword} helpText="Minimum 8 characters" />
              <button onClick={handleCreate} disabled={creating} className="w-full m3-button disabled:opacity-50">
                {creating ? 'Creating...' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
