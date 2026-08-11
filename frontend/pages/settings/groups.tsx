import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useConfirm } from '@/lib/useConfirm';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { TextField } from '@/components/ui/TextField';
import { API_URL } from '@/lib/api-client';
import { Tooltip } from '@/components/ui/Tooltip';
import { BrandLogo } from '@/components/BrandLogo';
import * as Separator from '@radix-ui/react-separator';

interface Group {
  id: string;
  name: string;
  description: string;
  provider: string;
  membercount: number;
  created_at: string;
}

interface GroupMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role?: string;
}

interface User {
  id: string;
  name: string;
  email: string;
}

export default function GroupsSettingsPage() {
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const deleteConfirm = useConfirm({ title: 'Delete group?', message: 'Delete this group? Memberships will be removed.' });
  useAssistantContext({ pageKey: 'settings:groups', description: 'Managing groups' });

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editError, setEditError] = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const [showAddMember, setShowAddMember] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [addingMember, setAddingMember] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/groups`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load');
      setGroups(await res.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const loadMembers = async (groupId: string) => {
    setMembersLoading(true);
    try {
      const res = await fetch(`${API_URL}/groups/${groupId}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
      }
    } catch {} finally {
      setMembersLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newName?.trim()) { setCreateError('Name is required'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch(`${API_URL}/groups`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: newName.trim(), description: newDescription.trim() }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Create failed' })); throw new Error(err.error); }
      setShowCreate(false);
      setNewName(''); setNewDescription('');
      await load();
    } catch (err: any) { setCreateError(err.message); }
    finally { setCreating(false); }
  };

  const handleEdit = async () => {
    if (!editingGroup) return;
    if (!editName?.trim()) { setEditError('Name is required'); return; }
    setEditError('');
    try {
      const res = await fetch(`${API_URL}/groups/${editingGroup.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: editName.trim(), description: editDescription.trim() }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Update failed' })); throw new Error(err.error); }
      setEditingGroup(null);
      await load();
    } catch (err: any) { setEditError(err.message); }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await deleteConfirm.confirm();
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_URL}/groups/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('Delete failed');
      if (expandedId === id) { setExpandedId(null); setMembers([]); }
      await load();
    } catch (err: any) { setError(err.message); }
  };

  const handleAddMember = async (groupId: string, userId: string) => {
    setAddingMember(true);
    try {
      const res = await fetch(`${API_URL}/groups/${groupId}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error('Failed');
      await loadMembers(groupId);
      setShowAddMember(false);
      setMemberSearch('');
    } catch {} finally { setAddingMember(false); }
  };

  const handleRemoveMember = async (groupId: string, userId: string) => {
    try {
      await fetch(`${API_URL}/groups/${groupId}/members/${userId}`, { method: 'DELETE', credentials: 'include' });
      await loadMembers(groupId);
    } catch {}
  };

  const handleUpdateMemberRole = async (groupId: string, userId: string, role: string) => {
    try {
      await fetch(`${API_URL}/groups/${groupId}/members/${userId}/role`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role }),
      });
      await loadMembers(groupId);
    } catch {}
  };

  const toggleExpand = async (groupId: string) => {
    if (expandedId === groupId) {
      setExpandedId(null);
      setMembers([]);
    } else {
      setExpandedId(groupId);
      await loadMembers(groupId);
    }
  };

  const openEdit = (g: Group) => {
    setEditingGroup(g);
    setEditName(g.name);
    setEditDescription(g.description || '');
    setEditError('');
  };

  useEffect(() => {
    if (showAddMember) {
      fetch(`${API_URL}/users`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : [])
        .then(data => setUsers(Array.isArray(data) ? data : []))
        .catch(() => {});
    }
  }, [showAddMember]);

  const filteredUsers = memberSearch
    ? users.filter(u => u.name.toLowerCase().includes(memberSearch.toLowerCase()) || u.email.toLowerCase().includes(memberSearch.toLowerCase()))
    : users;

  const filteredGroups = search
    ? groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()) || (g.description || '').toLowerCase().includes(search.toLowerCase()))
    : groups;

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
            <h1 className="text-2xl font-bold text-on-surface">Groups</h1>
            <p className="text-sm text-on-surface-variant mt-1">Manage user groups for flow visibility and HITL assignment</p>
          </div>
          <button onClick={() => setShowCreate(true)} className="m3-button">
            <Icon name="add" className="text-xs" /> Create Group
          </button>
        </div>

        <div className="mb-4 max-w-xs">
          <TextField label="Search groups" value={search} onChange={setSearch} />
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
        ) : filteredGroups.length === 0 ? (
          <div className="text-center py-16 bg-surface rounded-xl border border-outline-variant">
            <Icon name="group" className="text-5xl text-on-surface-variant mx-auto mb-3" />
            <p className="text-on-surface-variant font-medium">No groups</p>
            <p className="text-xs text-on-surface-variant mt-1">Create a group to organize users</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredGroups.map(g => {
              const isLocal = g.provider === 'local';
              return (
                <div key={g.id} className="bg-surface rounded-xl border border-outline-variant overflow-hidden">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleExpand(g.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(g.id); } }}
                    className="w-full flex items-center justify-between p-4 hover:bg-surface-container-high transition-colors text-left cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon name={expandedId === g.id ? "expand_less" : "expand_more"} className="text-base text-on-surface-variant shrink-0" />
                      <div className="min-w-0">
                        <span className="font-medium text-on-surface">{g.name}</span>
                        <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                          isLocal
                            ? 'bg-primary-container text-primary'
                            : 'bg-secondary-container text-on-secondary-container'
                        }`}>
                          {isLocal ? 'local' : g.provider}
                        </span>
                        <p className="text-xs text-on-surface-variant mt-0.5 truncate max-w-md">{g.description || 'No description'}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-on-surface-variant">{g.membercount || 0} member{(g.membercount || 0) !== 1 ? 's' : ''}</span>
                      {isLocal && (
                        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                          <Tooltip content="Edit group">
                            <button data-testid="group-edit-btn" onClick={() => openEdit(g)} className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-primary-container rounded transition-colors">
                              <Icon name="edit" className="text-sm" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete group">
                            <button data-testid="group-delete-btn" onClick={() => handleDelete(g.id)} className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors">
                              <Icon name="delete" className="text-sm" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  </div>

                  {expandedId === g.id && (
                    <div className="border-t border-outline-variant px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-on-surface-variant">Members</span>
                        {isLocal && (
                          <button onClick={() => setShowAddMember(true)} className="text-xs text-primary hover:underline">+ Add member</button>
                        )}
                      </div>
                      {membersLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Icon name="sync" className="text-base animate-spin text-on-surface-variant" />
                        </div>
                      ) : members.length === 0 ? (
                        <p className="text-xs text-on-surface-variant text-center py-4">No members</p>
                      ) : (
                        <div className="space-y-1">
                          {members.map(m => (
                            <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-container-high">
                              <div className="min-w-0 flex items-center gap-2">
                                <span className="text-sm text-on-surface">{m.name}</span>
                                <span className="text-xs text-on-surface-variant">{m.email}</span>
                                {m.role === 'admin' && (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary-container text-secondary">Admin</span>
                                )}
                              </div>
                              {isLocal && (
                                <div className="flex items-center gap-1">
                                  {m.role !== 'admin' && (
                                    <Tooltip content="Make group admin">
                                      <button onClick={() => handleUpdateMemberRole(g.id, m.userId, 'admin')} className="p-1 text-on-surface-variant hover:text-primary rounded transition-colors shrink-0">
                                        <Icon name="admin_panel_settings" className="text-xs" />
                                      </button>
                                    </Tooltip>
                                  )}
                                  {m.role === 'admin' && (
                                    <Tooltip content="Demote to member">
                                      <button onClick={() => handleUpdateMemberRole(g.id, m.userId, 'member')} className="p-1 text-on-surface-variant hover:text-warning rounded transition-colors shrink-0">
                                        <Icon name="person" className="text-xs" />
                                      </button>
                                    </Tooltip>
                                  )}
                                  <Tooltip content="Remove member">
                                    <button onClick={() => handleRemoveMember(g.id, m.userId)} className="p-1 text-on-surface-variant hover:text-error rounded transition-colors shrink-0">
                                      <Icon name="close" className="text-xs" />
                                    </button>
                                  </Tooltip>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {showAddMember && isLocal && (
                        <div className="mt-3 border border-outline-variant rounded p-3 bg-surface-container">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-on-surface-variant">Select a user to add</span>
                            <button onClick={() => { setShowAddMember(false); setMemberSearch(''); }} className="text-xs text-on-surface-variant hover:text-error">
                              <Icon name="close" className="text-sm" />
                            </button>
                          </div>
                          <TextField label="Search users" value={memberSearch} onChange={setMemberSearch} />
                          <div className="mt-2 max-h-40 overflow-y-auto space-y-1">
                            {filteredUsers
                              .filter(u => !members.find(m => m.userId === u.id))
                              .map(u => (
                                <button
                                  key={u.id}
                                  onClick={() => handleAddMember(g.id, u.id)}
                                  disabled={addingMember}
                                  className="w-full text-left px-2 py-1.5 text-sm hover:bg-surface-container-high rounded disabled:opacity-50"
                                >
                                  <span className="font-medium text-on-surface">{u.name}</span>
                                  <span className="text-xs text-on-surface-variant ml-2">{u.email}</span>
                                </button>
                              ))}
                            {filteredUsers.filter(u => !members.find(m => m.userId === u.id)).length === 0 && (
                              <p className="text-xs text-on-surface-variant text-center py-2">No users found</p>
                            )}
                          </div>
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

      {showCreate && (
        <div data-co-pilot-modal="create-group" className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setShowCreate(false)}>
          <div className="bg-surface rounded-lg shadow-m3-4 max-w-md w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-on-surface">Create Group</h3>
              <button onClick={() => setShowCreate(false)} className="flex items-center gap-1 text-on-surface-variant hover:text-error hover:bg-error-container p-1.5 rounded transition-colors"><Icon name="close" className="text-base" /> Close</button>
            </div>
            {createError && <div className="bg-error-container border border-red-200 text-error text-sm rounded p-3 mb-4">{createError}</div>}
            <div className="space-y-3">
              <TextField label="Name" value={newName} onChange={setNewName} />
              <TextField label="Description" value={newDescription} onChange={setNewDescription} multiline rows={2} />
              <Tooltip content={!creating && !newName?.trim() ? 'Fill in all required fields' : ''}>
                <span>
                  <button onClick={handleCreate} disabled={creating || !newName?.trim()} className="w-full m3-button disabled:opacity-50 disabled:cursor-not-allowed">
                    {creating ? 'Creating...' : 'Create Group'}
                  </button>
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      )}

      {editingGroup && (
        <div data-co-pilot-modal="edit-group" className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setEditingGroup(null)}>
          <div className="bg-surface rounded-lg shadow-m3-4 max-w-md w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-on-surface">Edit Group</h3>
              <button onClick={() => setEditingGroup(null)} className="flex items-center gap-1 text-on-surface-variant hover:text-error hover:bg-error-container p-1.5 rounded transition-colors"><Icon name="close" className="text-base" /> Close</button>
            </div>
            {editError && <div className="bg-error-container border border-red-200 text-error text-sm rounded p-3 mb-4">{editError}</div>}
            <div className="space-y-3">
              <TextField label="Name" value={editName} onChange={setEditName} />
              <TextField label="Description" value={editDescription} onChange={setEditDescription} multiline rows={2} />
              <Tooltip content={!editName?.trim() ? 'Fill in all required fields' : ''}>
                <span>
                  <button onClick={handleEdit} className="w-full m3-button">Save</button>
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
