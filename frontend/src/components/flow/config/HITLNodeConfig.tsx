import { useState, useEffect, useRef } from 'react';
import { TemplateAutocomplete } from '@/components/flow/config/TemplateAutocomplete';
import { API_URL } from '@/lib/api-client';
import { Icon } from '@/components/ui/Icon';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { Tooltip } from '@/components/ui/Tooltip';

interface HITLNodeConfigProps {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
  nodeId: string;
  nodes: any[];
  edges: any[];
}

interface Role {
  id: string;
  name: string;
}

interface User {
  id: string;
  email: string;
  name: string;
}

const PAGE_SIZE = 5;

function SearchableList({
  items,
  selectedId,
  placeholder,
  onSelect,
  renderItem,
  getItemId,
  loading,
}: {
  items: { id: string; [key: string]: any }[];
  selectedId: string;
  placeholder: string;
  onSelect: (id: string) => void;
  renderItem: (item: any) => React.ReactNode;
  getItemId: (item: any) => string;
  loading?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = query
    ? items.filter(item => {
        const searchStr = Object.values(item).join(' ').toLowerCase();
        return searchStr.includes(query.toLowerCase());
      })
    : items;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paged = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const selected = items.find(i => i.id === selectedId);

  return (
    <div>
      <div className="space-y-1">
        {selected ? (
          <div className="flex items-center gap-2 border border-outline rounded p-2 text-sm bg-surface-container">
            <div className="flex-1">{renderItem(selected)}</div>
            <button onClick={() => { onSelect(''); setQuery(''); setPage(0); }} aria-label="Clear selection" className="text-on-surface-variant hover:text-error shrink-0">
              <Icon name="close" className="text-xs" />
            </button>
          </div>
        ) : (
          <>
            <TextField label={placeholder} value={query} onChange={(v) => { setQuery(v); setPage(0); }} />
            {loading ? (
              <div className="flex items-center justify-center py-4"><Icon name="sync" className="text-base animate-spin text-on-surface-variant" /></div>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-on-surface-variant text-center py-4">No {placeholder.toLowerCase()} found</p>
            ) : (
              <div className="border border-outline-variant rounded overflow-hidden">
                {paged.map(item => (
                  <button
                    key={getItemId(item)}
                    onClick={() => { onSelect(getItemId(item)); setQuery(''); setPage(0); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-surface-container-high border-b border-outline-variant last:border-0"
                  >
                    {renderItem(item)}
                  </button>
                ))}
              </div>
            )}
            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-1">
                <button
                  disabled={safePage === 0}
                  onClick={() => setPage(p => p - 1)}
                  className="text-xs text-on-surface-variant hover:text-primary disabled:opacity-30"
                >Previous</button>
                <span className="text-xs text-on-surface-variant">{safePage + 1} / {totalPages}</span>
                <button
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                  className="text-xs text-on-surface-variant hover:text-primary disabled:opacity-30"
                >Next</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UserSearch({ assignedUserId, onSelect }: { assignedUserId: string; onSelect: (userId: string) => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/users`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setUsers(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <SearchableList
      items={users}
      selectedId={assignedUserId}
      placeholder="Search users"
      onSelect={onSelect}
      getItemId={(u) => u.id}
      renderItem={(u) => <><span className="font-medium text-on-surface">{u.name}</span><span className="text-on-surface-variant ml-2">{u.email}</span></>}
      loading={loading}
    />
  );
}

function GroupSearch({ assignedGroupId, onSelect }: { assignedGroupId: string; onSelect: (groupId: string) => void }) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/groups`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setGroups(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <SearchableList
      items={groups}
      selectedId={assignedGroupId}
      placeholder="Search groups"
      onSelect={onSelect}
      getItemId={(g) => g.id}
      renderItem={(g) => <span className="font-medium text-on-surface">{g.name}</span>}
      loading={loading}
    />
  );
}

function RoleSelect({ assignedRoleId, onSelect }: { assignedRoleId: string; onSelect: (roleId: string) => void }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/roles`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then(data => setRoles(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <SearchableList
      items={roles}
      selectedId={assignedRoleId}
      placeholder="Search roles"
      onSelect={onSelect}
      getItemId={(r) => r.id}
      renderItem={(r) => <span className="font-medium text-on-surface">{r.name}</span>}
      loading={loading}
    />
  );
}

function MultiAssignPicker({ config, onChange }: { config: any; onChange: (updates: any) => void }) {
  const assigned = config.assignees || { userIds: [], roleIds: [], groupIds: [] };
  const [showPicker, setShowPicker] = useState<'user' | 'role' | 'group' | null>(null);

  const removeUser = (id: string) => onChange({ assignees: { ...assigned, userIds: assigned.userIds.filter((u: string) => u !== id) } });
  const removeRole = (id: string) => onChange({ assignees: { ...assigned, roleIds: assigned.roleIds.filter((r: string) => r !== id) } });
  const removeGroup = (id: string) => onChange({ assignees: { ...assigned, groupIds: assigned.groupIds.filter((g: string) => g !== id) } });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {assigned.userIds.map((id: string) => (
          <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-primary-container text-primary font-medium">
            User:{id.slice(0, 8)}
            <button onClick={() => removeUser(id)} aria-label="Remove user" className="hover:text-error"><Icon name="close" className="text-[10px]" /></button>
          </span>
        ))}
        {assigned.roleIds.map((id: string) => (
          <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-secondary-container text-on-secondary-container font-medium">
            Role:{id.slice(0, 8)}
            <button onClick={() => removeRole(id)} aria-label="Remove role" className="hover:text-error"><Icon name="close" className="text-[10px]" /></button>
          </span>
        ))}
        {assigned.groupIds?.map((id: string) => (
          <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-tertiary-container text-on-tertiary-container font-medium">
            Group:{id.slice(0, 8)}
            <button onClick={() => removeGroup(id)} aria-label="Remove group" className="hover:text-error"><Icon name="close" className="text-[10px]" /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setShowPicker(showPicker === 'user' ? null : 'user')} className="text-xs text-primary hover:underline">+ Add user</button>
        <button onClick={() => setShowPicker(showPicker === 'role' ? null : 'role')} className="text-xs text-primary hover:underline">+ Add role</button>
        <button onClick={() => setShowPicker(showPicker === 'group' ? null : 'group')} className="text-xs text-primary hover:underline">+ Add group</button>
      </div>
      {showPicker === 'user' && (
        <UserSearch
          assignedUserId=""
          onSelect={(userId) => { onChange({ assignees: { ...assigned, userIds: [...assigned.userIds, userId] } }); setShowPicker(null); }}
        />
      )}
      {showPicker === 'role' && (
        <RoleSelect
          assignedRoleId=""
          onSelect={(roleId) => { onChange({ assignees: { ...assigned, roleIds: [...assigned.roleIds, roleId] } }); setShowPicker(null); }}
        />
      )}
      {showPicker === 'group' && (
        <GroupSearch
          assignedGroupId=""
          onSelect={(groupId) => { onChange({ assignees: { ...assigned, groupIds: [...(assigned.groupIds || []), groupId] } }); setShowPicker(null); }}
        />
      )}
    </div>
  );
}

export function HITLNodeConfig({ config, onChange, nodeId, nodes, edges }: HITLNodeConfigProps) {
  const mode = config.mode || 'simple';

  return (
    <div className="space-y-3">
      {/* Mode selector */}
      <div>
        <span className="text-xs font-medium text-on-surface-variant block mb-1">Mode</span>
        <div className="flex gap-2">
          {(['simple', 'custom'] as const).map(m => (
            <button
              key={m}
              onClick={() => onChange({ mode: m, buttons: m === 'simple' ? undefined : config.buttons })}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                mode === m ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container'
              }`}
            >
              {m === 'simple' ? 'Simple' : 'Custom'}
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-on-surface-variant">Prompt for the User</span>
        <TemplateAutocomplete
          value={config.prompt || ''}
          onChange={(v) => onChange({ prompt: v })}
          placeholder="Please review the generated content before proceeding..."
          rows={3}
          nodeId={nodeId}
          nodes={nodes}
          edges={edges}
          selectedFields={config?.inputFields}
        />
      </label>

      {mode === 'custom' && (
        <div className="space-y-2">
          <span className="text-sm font-medium text-on-surface-variant block">Buttons</span>
          {(config.buttons || []).map((btn: any, i: number) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-3 gap-2">
                <TextField label="Label" value={btn.label} onChange={(v) => {
                  const btns = [...(config.buttons || [])];
                  btns[i] = { ...btns[i], label: v };
                  onChange({ buttons: btns });
                }} />
                <TextField label="Icon" value={btn.icon || ''} onChange={(v) => {
                  const btns = [...(config.buttons || [])];
                  btns[i] = { ...btns[i], icon: v };
                  onChange({ buttons: btns });
                }} />
                <TextField label="Value" value={btn.value} onChange={(v) => {
                  const btns = [...(config.buttons || [])];
                  btns[i] = { ...btns[i], value: v };
                  onChange({ buttons: btns });
                }} />
              </div>
              <div className="flex items-center gap-1 pt-1">
                {btn.icon && <Icon name={btn.icon} className="text-sm text-on-surface-variant" />}
                <Tooltip content="Remove">
                  <button onClick={() => {
                    const btns = [...(config.buttons || [])];
                    btns.splice(i, 1);
                    onChange({ buttons: btns.length > 0 ? btns : [{ label: 'Approve', value: 'approved', icon: 'check_circle' }] });
                  }} className="p-1.5 text-on-surface-variant hover:text-error">
                    <Icon name="close" className="text-sm" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
          <button onClick={() => onChange({ buttons: [...(config.buttons || []), { label: '', value: '', icon: '' }] })} className="text-sm text-primary hover:underline block">
            + Add Button
          </button>
        </div>
      )}

      {/* Assignment — multi-approver only in Simple mode */}
      <div className="border-t border-outline-variant pt-3">
        <span className="text-sm font-medium text-on-surface-variant block mb-2">Assignment</span>
        <SelectField
          label="Assignment type"
          value={config.assignmentType || 'none'}
          onChange={(v) => { const assignmentType = v === 'none' ? '' : v; onChange({ assignmentType, assignees: assignmentType === 'multi' ? (config.assignees || { userIds: [], roleIds: [] }) : undefined }); }}
          options={[
            { value: 'none', label: 'Select assignment type...' },
            { value: 'user', label: 'Specific user' },
            { value: 'group', label: 'Specific group' },
            { value: 'role', label: 'Specific role' },
            ...(mode === 'simple' ? [{ value: 'multi', label: 'Multi-approver' }] : []),
          ]}
        />
        {!config.assignmentType && (
          <p className="text-xs text-error mt-1">Please select an assignment type.</p>
        )}
      </div>

      {config.assignmentType === 'user' && (
        <UserSearch
          assignedUserId={config.assignedUserId || ''}
          onSelect={(userId) => onChange({ assignedUserId: userId })}
        />
      )}

      {config.assignmentType === 'group' && (
        <GroupSearch
          assignedGroupId={config.assignedGroupId || ''}
          onSelect={(groupId) => onChange({ assignedGroupId: groupId })}
        />
      )}

      {config.assignmentType === 'role' && (
        <RoleSelect
          assignedRoleId={config.assignedRoleId || ''}
          onSelect={(roleId) => onChange({ assignedRoleId: roleId })}
        />
      )}

      {mode === 'simple' && config.assignmentType === 'multi' && (
            <div className="space-y-3">
              <TextField
                label="Required approvals"
                type="number"
                value={String(config.requiredApprovals ?? 1)}
                onChange={(v) => onChange({ requiredApprovals: Math.max(1, parseInt(v) || 1) })}
                helpText="How many selected approvers must approve before the flow continues."
                className="w-24"
              />
              <MultiAssignPicker config={config} onChange={onChange} />
              <p className="text-[10px] text-on-surface-variant">Selected approvers will see this HITL. If anyone rejects, the flow stops immediately.</p>
            </div>
          )}

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={config?.allowFeedback !== false} onChange={(e) => onChange({ allowFeedback: e.target.checked })} className="rounded accent-primary" />
        <span className="text-sm font-medium text-on-surface-variant">Allow reviewer feedback</span>
        <span className="text-xs text-on-surface-variant">(text input field)</span>
      </label>

      <TextField label="Max iterations" type="number" value={String(config?.maxIterations ?? 0)} onChange={(v) => onChange({ maxIterations: Math.max(0, parseInt(v) || 0) })} helpText="When exceeded, flow exits through the red max iterations handle. (0 = unlimited)" className="w-24" />
    </div>
  );
}
