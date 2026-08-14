import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

interface FlowItem {
  id: string;
  name: string;
  description: string;
  group_id: string | null;
  nodes: any[];
}

interface GroupItem {
  id: string;
  name: string;
}

interface Props {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}

export function FlowToolConfig({ config, onChange }: Props) {
  const { user, userGroups } = useAuth();
  const canAdmin = user?.permissions?.includes('admin') ?? false;
  const [flows, setFlows] = useState<FlowItem[]>([]);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [filterGroupId, setFilterGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const selectedIds: string[] = config?.flowIds || [];
  const selectedFlows: Array<{ id: string; name: string; groupId?: string | null }> = config?.selectedFlows || [];
  const emptyRetries = useRef(0);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [flowData, groupData] = await Promise.all([
          api.flows.list({ trigger_type: 'webhook', group_id: filterGroupId || undefined, limit: 100 }),
          canAdmin ? api.groups.list() : Promise.resolve(userGroups),
        ]);
        const list = (flowData as any)?.data || flowData || [];
        setFlows(list);
        setGroups(groupData as GroupItem[] || []);
        // A flow created moments before the modal opened can miss the first
        // fetch (the list query raced the save in the other editor). The
        // component stays mounted between opens and never refetches, so
        // converge with a few backoff retries instead of showing a stale
        // empty list.
        if (Array.isArray(list) && list.length === 0 && emptyRetries.current < 3) {
          emptyRetries.current += 1;
          setTimeout(load, 1000 * emptyRetries.current);
          return;
        }
        emptyRetries.current = 0;
      } catch { /* ignore */ }
      setLoading(false);
    };
    load();
  }, [filterGroupId, canAdmin, userGroups]);

  const filtered = flows.filter(f =>
    !search || f.name.toLowerCase().includes(search.toLowerCase())
  );

  const toggleFlow = (flowId: string, flow: FlowItem) => {
    const exists = selectedIds.includes(flowId);
    let newIds: string[];
    let newMeta: Array<{ id: string; name: string; groupId?: string | null }>;
    if (exists) {
      newIds = selectedIds.filter(id => id !== flowId);
      newMeta = selectedFlows.filter(s => s.id !== flowId);
    } else {
      newIds = [...selectedIds, flowId];
      newMeta = [...selectedFlows, { id: flowId, name: flow.name, groupId: flow.group_id }];
    }
    onChange({ ...config, flowIds: newIds, selectedFlows: newMeta });
  };

  const getSchemaFieldCount = (flow: FlowItem): number => {
    try {
      const triggerNode = flow.nodes?.find((n: any) => n.data?.type === 'trigger');
      const schema = triggerNode?.data?.config?.inputSchema;
      if (!schema) return -1;
      const parsed = typeof schema === 'string' ? JSON.parse(schema) : schema;
      if (parsed?.properties) return Object.keys(parsed.properties).length;
      return Object.keys(parsed).length;
    } catch { return -1; }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <SearchableSelect
          label="Filter by group"
          value={filterGroupId}
          onChange={setFilterGroupId}
          items={groups.map(g => ({ value: g.id, label: g.name }))}
          includeAll
          allLabel="All groups"
        />
        <div>
          <label className="text-xs font-medium text-on-surface-variant block mb-1">Search</label>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search flows..."
            className="w-full rounded-t bg-surface-container-high border-b-2 border-outline-variant min-h-[48px] px-4 text-sm text-on-surface outline-none focus:border-primary"
          />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-on-surface-variant">Loading flows...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No webhook flows found{filterGroupId ? ' for this group' : ''}.</p>
      ) : (
        <div className="space-y-1 max-h-64 overflow-y-auto border border-outline-variant rounded-lg p-2">
          {filtered.map(f => {
            const checked = selectedIds.includes(f.id);
            const fieldCount = getSchemaFieldCount(f);
            return (
              <label
                key={f.id}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${checked ? 'bg-primary-container' : 'hover:bg-surface-container-high'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleFlow(f.id, f)}
                  className="accent-primary rounded"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-on-surface truncate">{f.name}</span>
                    {fieldCount >= 0 ? (
                      <span className="text-[10px] px-1 py-0.5 rounded bg-surface-container-high text-on-surface-variant shrink-0">{fieldCount} field{fieldCount !== 1 ? 's' : ''}</span>
                    ) : (
                      <span title="No input schema defined — callable without parameters." className="text-[10px] text-on-surface-variant shrink-0 cursor-help">⚪</span>
                    )}
                  </div>
                  {f.description && <p className="text-xs text-on-surface-variant truncate">{f.description}</p>}
                </div>
                {f.group_id && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-secondary-container text-secondary shrink-0">{groups.find(g => g.id === f.group_id)?.name || 'group'}</span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="text-xs text-on-surface-variant">
          {selectedIds.length} flow{selectedIds.length > 1 ? 's' : ''} selected — each becomes a tool with the <code className="font-mono bg-surface-container-high px-1 rounded">flow_</code> prefix.
        </div>
      )}
    </div>
  );
}