import { useAssistantContext } from '@/hooks/useAssistantContext';
import { useRouter } from 'next/router';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { FlowEditor } from '@/components/flow/FlowEditor';
import { NodeCatalog } from '@/components/flow/NodeCatalog';
import { NodeConfigModal } from '@/components/flow/NodeConfigModal';
import { DebugOverlay } from '@/components/flow/DebugOverlay';
import { Icon } from '@/components/ui/Icon';
import { BrandLogo } from '@/components/BrandLogo';
import { TextField } from '@/components/ui/TextField';
import { useConfirm } from '@/lib/useConfirm';
import * as Separator from '@radix-ui/react-separator';
import { useTheme } from '@/hooks/useTheme';
import Link from 'next/link';
import { Tooltip } from '@/components/ui/Tooltip';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { getNodeFields } from '@/components/flow/config/InputPreview';
import { ChatApiSettings } from '@/components/flow/ChatApiSettings';

// Eagerly create a draft flow with a client-generated id, retrying with a
// numbered name if the default name is already taken.
async function createDraftFlow(id: string, triggerNode: any, triggerType: string): Promise<any> {
  const baseName = triggerType === 'subflow' ? 'New Subflow' : 'New Flow';
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName} ${attempt + 1}`;
    try {
      return await api.flows.create({ id, name, description: '', nodes: [triggerNode], edges: [] });
    } catch (err: any) {
      if (err?.status === 409) continue;
      throw err;
    }
  }
  throw new Error('Could not create draft flow');
}

export default function FlowEditPage() {
  const router = useRouter();
  const { id } = router.query;
  const [flow, setFlow] = useState<any>(null);
  const [isNew, setIsNew] = useState(false);
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const addNodeRef = useRef<((type: string, defaultConfig: Record<string, any>) => void) | null>(null);
  const setNodeDataRef = useRef<((nodeId: string, config: Record<string, any>) => void) | null>(null);
  const deleteNodeRef = useRef<((nodeId: string) => void) | null>(null);
  const setNodeLabelRef = useRef<((nodeId: string, label: string) => void) | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  useAssistantContext({ pageKey: 'flow:' + (flow?.id || ""), description: 'Editing flow' });
  const revealSecretConfirm = useConfirm({ title: 'Reveal secret?', message: 'Reveal the value of this secret? It will be visible on screen for 10 seconds.', variant: 'default' });
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, { value: string; expiresAt: number }>>({});
  const [now, setNow] = useState(Date.now());
  const [personalApiKey, setPersonalApiKey] = useState<string | null>(null);
  const [showKeyModal, setShowKeyModal] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Selected node for config editing
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Check name uniqueness via API
  const [nameAvailable, setNameAvailable] = useState(true);
  useEffect(() => {
    if (!flow?.name?.trim()) { setNameAvailable(false); return; }
    const timer = setTimeout(() => {
      api.flows.checkName(flow.name.trim(), isNew ? undefined : flow.id).then(r => setNameAvailable(r.available)).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [flow?.name, flow?.id, isNew]);

  const isChatFlow = useMemo(() => nodes.some(n => n.data?.type === 'trigger' && n.data?.config?.triggerType === 'chat'), [nodes]);
  const isSubflowFlow = useMemo(() => nodes.some(n => n.data?.type === 'trigger' && n.data?.config?.triggerType === 'subflow'), [nodes]);

  // Validation: save button disabled when flow name is empty or not unique
  const saveError = useMemo(() => {
    if (!flow?.name?.trim()) return 'Flow name is required';
    if (!nameAvailable) return 'Another flow with this name already exists';
    if (isSubflowFlow) {
      if (!nodes.some(n => n.data?.type === 'output')) return 'Subflow: requires an Output node';
    }
    if (isChatFlow) {
      if (!nodes.some(n => n.data?.type === 'output')) return 'Chat flow: requires an Output node';
      for (const out of nodes) {
        if (out.data?.type !== 'output') continue;
        const fields = out.data?.config?.inputFields as string[] | undefined;
        if (!fields || fields.length !== 1) return 'Chat flow: each Output node must have exactly one field selected';
        const fp = fields[0];
        if (fp.includes('.')) {
          const dot = fp.indexOf('.');
          const rawLabel = fp.slice(0, dot);
          const fieldName = fp.slice(dot + 1);
          const upNode = nodes.find(n => (n.data?.label || n.data?.type || n.id) === rawLabel);
          if (upNode) {
            const nodeFields = getNodeFields(upNode);
            const fieldDef = nodeFields.find(f => f.name === fieldName);
            if (fieldDef && fieldDef.type !== 'string') return 'Chat flow: output field must be a string type (select e.g. message)';
          }
        } else {
          return 'Chat flow: select a specific field (e.g. Trigger.message) instead of the whole node';
        }
      }
    }
    return null;
  }, [flow?.name, nameAvailable, isChatFlow, nodes]);

  const hasErrors = saveError !== null;

  // Duplicate label detection
  const labelError = useMemo(() => {
    if (!selectedNodeId) return '';
    const selectedLabel = nodes.find(n => n.id === selectedNodeId)?.data?.label;
    if (!selectedLabel) return '';
    const dupe = nodes.find(n => n.id !== selectedNodeId && n.data?.label === selectedLabel);
    return dupe ? `Label "${selectedLabel}" is already used by another node` : '';
  }, [nodes, selectedNodeId]);

  // Compute node warnings (duplicate labels, etc.) and merge into node data
  useEffect(() => {
    const labelCounts = new Map<string, string[]>();
    for (const n of nodes) {
      const lbl = n.data?.label;
      if (!lbl) continue;
      const ids = labelCounts.get(lbl) || [];
      ids.push(n.id);
      labelCounts.set(lbl, ids);
    }
    const warnings = new Map<string, string[]>();
    for (const [lbl, ids] of labelCounts) {
      if (ids.length > 1) {
        for (const id of ids) {
          warnings.set(id, (warnings.get(id) || []).concat(`Duplicate label: "${lbl}"`));
        }
      }
    }
    setNodes(prev => prev.map(n => {
    const w = warnings.get(n.id);
    const currentWarnings = n.data?._warnings as string[] | undefined;
      if (currentWarnings === undefined && !w) return n;
      if (currentWarnings && w && JSON.stringify(currentWarnings) === JSON.stringify(w)) return n;
      return { ...n, data: { ...n.data, _warnings: w || undefined } };
    }));
  }, [nodes.map(n => n.data?.label).join(',')]);

  // Execution state
  const [isRunning, setIsRunning] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [output, setOutput] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Undo/Redo ──────────────────────────────────────────
  const undoStackRef = useRef<Array<{ nodes: any[]; edges: any[] }>>([]);
  const redoStackRef = useRef<Array<{ nodes: any[]; edges: any[] }>>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const snapshot = useCallback(() => {
    undoStackRef.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, [nodes, edges]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, [nodes, edges]);

  const handleRedo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push({ nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) });
    setNodes(next.nodes);
    setEdges(next.edges);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [nodes, edges]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo]);

  useEffect(() => {
    if (!id) return;
    if (typeof id !== 'string') return;
    if (id === 'new') {
      const triggerTypeFromQuery = (router.query.triggerType as string) || 'manual';
      const triggerNode = {
        id: `node_${Date.now()}_trigger`,
        type: 'trigger',
        position: { x: 100, y: 200 },
        data: { label: 'Trigger', type: 'trigger', config: { triggerType: triggerTypeFromQuery, inputSchema: '' } },
      };
      // Give the flow a real GUID immediately so per-flow co-pilot history and
      // flow-scoped secrets work from the first edit, before the first save.
      const draftId = crypto.randomUUID();
      setIsNew(true);
      createDraftFlow(draftId, triggerNode, triggerTypeFromQuery)
        .then((created) => {
          setIsNew(false);
          setFlow(created);
          setNodes(created.nodes || []);
          setEdges(created.edges || []);
          router.replace(`/flows/${created.id}/edit`);
        })
        .catch(() => {
          // Transient failure — keep editing locally; the Save button creates it.
          setFlow({
            id: draftId,
            name: triggerTypeFromQuery === 'subflow' ? 'New Subflow' : 'New Flow',
            description: '',
            nodes: [triggerNode],
            edges: [],
            version: 1,
          });
          setNodes([triggerNode]);
        })
        .finally(() => setLoading(false));
      return;
    }
    api.flows.get(id).then((f) => {
      setFlow(f);
      const raw = f.nodes || [];
      const ordered = [...raw.filter((n: any) => n.type === 'parallel'), ...raw.filter((n: any) => n.type !== 'parallel')];
      setNodes(ordered);
      setEdges(f.edges || []);
    }).catch((err) => {
      console.error('Failed to load flow:', err);
    }).finally(() => setLoading(false));
  }, [id]);

  // ── Group assignment ──────────────────────────────────
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    if (user.permissions?.includes('admin')) {
      fetch('/api/groups', { credentials: 'include' })
        .then(r => r.ok ? r.json() : Promise.reject('Failed'))
        .then(setGroups)
        .catch(() => {});
    } else {
      setGroups((user as any).groups || []);
    }
  }, [user]);

  // Auto-open debug overlay from ?debug=1
  useEffect(() => {
    if (router.query.debug === '1') setShowDebug(true);
  }, [router.query.debug]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistFlow = useCallback(async (updates: Record<string, any>) => {
    if (!flow) return;
    if (isNew) {
      const triggerNode = nodes.find((n: any) => n.data?.type === 'trigger');
      const isSubflow = triggerNode?.data?.config?.triggerType === 'subflow';
      const created = await api.flows.create({ ...flow, ...updates, is_subflow: isSubflow });
      setIsNew(false);
      setFlow(created);
      if (created.personalApiKey?.rawKey) {
        setPersonalApiKey(created.personalApiKey.rawKey);
        setShowKeyModal(true);
      }
      router.replace(`/flows/${created.id}/edit`);
    } else {
      const updated = await api.flows.update(flow.id, { ...flow, ...updates });
      setFlow(updated);
      if (updated.personalApiKey?.rawKey) {
        setPersonalApiKey(updated.personalApiKey.rawKey);
        setShowKeyModal(true);
      }
    }
  }, [flow, router, nodes, isNew]);

  const handleSave = useCallback(async () => {
    if (!flow || hasErrors) return;
    setSaving(true);
    try {
      // Sync child nodes into parallel node configs, ensure parent nodes come first
      const syncedNodes = nodes.map(n => {
        if (n.type === 'parallel') {
          const children = nodes.filter(c => c.parentId === n.id);
          return { ...n, data: { ...n.data, config: { ...n.data.config, subNodes: children } } };
        }
        return n;
      });
      // Sort: parallel nodes first, then children, then others
      const ordered = [...syncedNodes.filter(n => n.type === 'parallel'), ...syncedNodes.filter(n => n.type !== 'parallel')];

      await persistFlow({ nodes: ordered, edges });
    } finally {
      setSaving(false);
    }
  }, [flow, nodes, edges, persistFlow, hasErrors]);

  const handleAddNode = useCallback((type: string, defaultConfig: Record<string, any>) => {
    if (type === 'hitl' && isChatFlow) return;
    snapshot();
    addNodeRef.current?.(type, defaultConfig);
  }, [snapshot, isChatFlow]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId) return;
    const node = nodes.find(n => n.id === selectedNodeId);
    if (node?.data?.type === 'trigger') return;
    snapshot();
    deleteNodeRef.current?.(selectedNodeId);
    setSelectedNodeId(null);
  }, [selectedNodeId, nodes, snapshot]);

  const handleConfigChange = useCallback((newConfig: Record<string, any>) => {
    if (!selectedNodeId) return;
    snapshot();
    setNodeDataRef.current?.(selectedNodeId, newConfig);
    setNodes((prev) => prev.map((n) =>
      n.id === selectedNodeId
        ? { ...n, data: { ...n.data, config: { ...n.data.config, ...newConfig } } }
        : n
    ));
  }, [selectedNodeId, snapshot]);

  const handleLabelChange = useCallback((label: string) => {
    if (!selectedNodeId) return;
    snapshot();
    setNodeLabelRef.current?.(selectedNodeId, label);
    setNodes((prev: any[]) => prev.map((n: any) => {
      if (n.id !== selectedNodeId) return n;
      return { ...n, data: { ...n.data, label, _warnings: undefined } };
    }));
  }, [selectedNodeId, snapshot]);

  const abortRef = useRef<AbortController | null>(null);

  const handleRun = async (inputStr: string) => {
    setEvents([]);
    setOutput(null);
    setError(null);
    setSelectedNodeId(null);
    setIsRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let input: any;
    try { input = JSON.parse(inputStr); } catch { input = { message: inputStr }; }

    try {
      const eventStream = api.flows.executeStream(flow.id, input, controller.signal);

      for await (const event of eventStream) {
        setEvents((prev) => [...prev, event]);

        if (event.type === 'execution.completed') {
          setOutput(event.data.output);
        }
        if (event.type === 'execution.failed') {
          setError(event.data.error || 'Execution failed');
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError(err.message || 'Execution error');
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  };

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Flow Settings modal ──
  const [showFlowSettings, setShowFlowSettings] = useState(false);
  const [flowSettingsDraft, setFlowSettingsDraft] = useState<Record<string, any>>({});
  const [flowSecrets, setFlowSecrets] = useState<any[]>([]);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [newSecretType, setNewSecretType] = useState<'core' | 'cyberark'>('core');
  const [flowEnvVars, setFlowEnvVars] = useState<Array<{ name: string; type: string; value: string }>>([]);
  const [newEnvVarName, setNewEnvVarName] = useState('');
  const [newEnvVarType, setNewEnvVarType] = useState<'static' | 'core_secret' | 'cyberark'>('static');
  const [newEnvVarValue, setNewEnvVarValue] = useState('');
  const [inheritedSecrets, setInheritedSecrets] = useState<Array<{ name: string; scope: string; groupName?: string }>>([]);
  const [inheritedEnvVars, setInheritedEnvVars] = useState<Array<{ name: string; value: string; scope: string }>>([]);
  const [availableSecrets, setAvailableSecrets] = useState<Array<{ value: string; label: string }>>([]);
  const [availableCyberArks, setAvailableCyberArks] = useState<Array<{ value: string; label: string }>>([]);

  const loadInheritedData = useCallback(async (groupId: string | null) => {
    const secrets: Array<{ name: string; scope: string; groupName?: string }> = [];
    const envVars: Array<{ name: string; value: string; scope: string }> = [];

    // App-level secrets
    try {
      const appSec = await fetch('/api/secrets?scope=app', { credentials: 'include' }).then(r => r.ok ? r.json() : []);
      if (Array.isArray(appSec)) appSec.forEach((s: any) => secrets.push({ name: s.name, scope: 'app' }));
    } catch {}

    // App-level env vars
    try {
      const appEv = await fetch('/api/env-vars', { credentials: 'include' }).then(r => r.ok ? r.json() : []);
      if (Array.isArray(appEv)) appEv.forEach((v: any) => envVars.push({ name: v.name, value: v.value, scope: 'App-wide' }));
    } catch {}

    // Group-level secrets and env vars
    if (groupId) {
      try {
        const grpSec = await fetch(`/api/secrets?scope=group&scopeId=${groupId}`, { credentials: 'include' }).then(r => r.ok ? r.json() : []);
        const grpName = groups.find(g => g.id === groupId)?.name || 'Group';
        if (Array.isArray(grpSec)) grpSec.forEach((s: any) => secrets.push({ name: s.name, scope: 'group', groupName: grpName }));
      } catch {}
      try {
        const grpEv = await fetch(`/api/env-vars/groups/${groupId}`, { credentials: 'include' }).then(r => r.ok ? r.json() : []);
        const grpName = groups.find(g => g.id === groupId)?.name || 'Group';
        if (Array.isArray(grpEv)) grpEv.forEach((v: any) => envVars.push({ name: v.name, value: v.value, scope: grpName }));
      } catch {}
    }

    setInheritedSecrets(secrets);
    setInheritedEnvVars(envVars);
  }, [groups]);

  // Fetch available secrets for the core_secret and cyberark dropdowns in env vars
  useEffect(() => {
    const fetchSecrets = async () => {
      const coreResults: Array<{ value: string; label: string }> = [];
      const cyberResults: Array<{ value: string; label: string }> = [];
      const scopes = [{ url: '/api/secrets?scope=app', label: 'app' }];
      if (flow?.group_id) scopes.push({ url: `/api/secrets?scope=group&scopeId=${flow.group_id}`, label: 'group' });
      if (flow?.id) scopes.push({ url: `/api/secrets?scope=flow&scopeId=${flow.id}`, label: 'flow' });
      for (const scope of scopes) {
        try {
          const data = await fetch(scope.url, { credentials: 'include' }).then(r => r.ok ? r.json() : []);
          if (Array.isArray(data)) {
            data.forEach((s: any) => {
              if (s.secretType === 'cyberark') {
                cyberResults.push({ value: s.referencePath || s.name, label: `${s.referencePath || s.name} (${scope.label})` });
              } else {
                coreResults.push({ value: s.name, label: `${s.name} (${scope.label})` });
              }
            });
          }
        } catch {}
      }
      setAvailableSecrets(coreResults);
      setAvailableCyberArks(cyberResults);
    };
    fetchSecrets();
  }, [flow?.id, flow?.group_id, flowSecrets]);

  const openFlowSettings = useCallback(() => {
    setFlowSettingsDraft({
      name: flow?.name || '',
      description: flow?.description || '',
      flow_context: flow?.flow_context || '',
      group_id: flow?.group_id || '',
    });
    setFlowEnvVars((flow as any)?.env_vars || []);
    loadInheritedData(flow?.group_id || null);
    if (flow?.id) {
      fetch(`/api/secrets?scope=flow&scopeId=${flow.id}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : [])
        .then(setFlowSecrets)
        .catch(() => setFlowSecrets([]));
    } else {
      setFlowSecrets([]);
    }
    setShowFlowSettings(true);
  }, [flow, loadInheritedData]);

  const saveFlowSettings = useCallback(async (extraFields?: Record<string, unknown>) => {
    if (!flow || isNew) return;
    const { name, description, flow_context, group_id } = flowSettingsDraft;
    setFlow((prev: any) => ({ ...prev, name, description, flow_context, group_id: group_id || null, envVars: flowEnvVars }));
    await api.flows.update(flow.id, { name, description, flow_context, group_id: group_id || null, envVars: flowEnvVars, ...extraFields });
  }, [flow, flowSettingsDraft, flowEnvVars]);

  const { theme, toggle: toggleTheme } = useTheme();
  const selectedNode = selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null;

  if (loading) return <div className="flex items-center justify-center h-screen text-on-surface-variant">Loading flow...</div>;
  if (!flow) return <div className="flex items-center justify-center h-screen text-on-surface-variant">Flow not found</div>;

  return (
    <div className="h-screen flex flex-col">
      {/* Floating top bar — title & description */}
      <div className="pointer-events-none fixed inset-x-0 top-3 flex justify-center z-40">
        <div className="pointer-events-auto flex items-center gap-2 bg-surface/90 backdrop-blur border rounded-lg shadow-sm px-3 py-1.5">
          <Link href="/" className="flex items-center gap-1.5 shrink-0 leading-none text-on-surface-variant hover:text-on-surface-variant" title="Home">
            <BrandLogo size="sm" />
            <span>Home</span>
          </Link>
          <TextField label="Flow name" value={flow.name} onChange={(v) => setFlow((prev: any) => ({ ...prev, name: v }))} className="min-w-[80px] max-w-[160px]" />
          <TextField label="Description" value={flow.description || ''} onChange={(v) => setFlow((prev: any) => ({ ...prev, description: v }))} className="min-w-[100px] max-w-[200px] focus:max-w-[400px] transition-all" />
          <Tooltip content="Flow settings">
            <button data-testid="flow-settings-btn" onClick={openFlowSettings} className="flex items-center gap-1 px-1.5 py-1 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container rounded transition-colors">
              <Icon name="settings" className="text-base" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1">
          <FlowEditor
            initialNodes={nodes}
            initialEdges={edges}
            onNodesChange={setNodes}
            onEdgesChange={setEdges}
            addNodeCallbackRef={addNodeRef}
            setNodeDataCallbackRef={setNodeDataRef}
            deleteNodeCallbackRef={deleteNodeRef}
            setNodeLabelRef={setNodeLabelRef}
            onNodeClick={handleNodeClick}
            onNodeDragStart={() => snapshot()}
          />
        </div>

        {selectedNode && (
          <NodeConfigModal
            node={selectedNode}
            nodes={nodes}
            edges={edges}
            flowId={flow.id}
            flow={flow}
            onConfigChange={handleConfigChange}
            onLabelChange={handleLabelChange}
            onDelete={handleDeleteNode}
            onClose={() => setSelectedNodeId(null)}
            labelError={labelError}
          />
        )}
      </div>

      {/* Backdrop for catalog */}
      {showCatalog && (
        <div className="fixed inset-0 z-30" onClick={() => setShowCatalog(false)} />
      )}

      {/* Floating add node — left side */}
      <div className="pointer-events-none fixed left-4 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center">
        <Tooltip content="Add node">
          <button id="add-node-btn" data-testid="add-node-btn" onClick={() => setShowCatalog(p => !p)} className="pointer-events-auto w-10 h-10 bg-primary border-2 border-primary rounded-xl shadow-lg flex items-center justify-center text-white hover:bg-primary hover:shadow-xl transition-all">
            <Icon name="add" className="text-xl" />
          </button>
        </Tooltip>
        <span className="pointer-events-auto mt-1.5 text-[9px] text-primary font-bold tracking-wider uppercase">Add Node</span>
        {showCatalog && (
          <div className="pointer-events-auto fixed left-16 top-1/2 -translate-y-1/2 z-40">
            <NodeCatalog onAddNode={(type, config) => { handleAddNode(type, config); setShowCatalog(false); }} onClose={() => setShowCatalog(false)} disabledTypes={isChatFlow ? ['hitl'] : []} disabledReasons={{ hitl: 'HITL is not supported in chat-triggered flows' }} />
          </div>
        )}
      </div>

      {/* Floating bottom bar */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center z-40">
        <div className="pointer-events-auto flex items-center gap-1 bg-surface border rounded-lg shadow-lg px-2 py-1.5">
          <Tooltip content="Undo (Ctrl+Z)">
            <button onClick={handleUndo} disabled={!canUndo} className="flex items-center gap-1 px-1.5 py-1 text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded hover:bg-surface-container-high">
              <Icon name="undo" className="text-sm" /> Undo
            </button>
          </Tooltip>
          <Separator.Root orientation="vertical" className="w-px h-4 bg-outline-variant" />
          <Tooltip content="Redo (Ctrl+Shift+Z)">
            <button onClick={handleRedo} disabled={!canRedo} className="flex items-center gap-1 px-1.5 py-1 text-xs text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors rounded hover:bg-surface-container-high">
              <Icon name="redo" className="text-sm" /> Redo
            </button>
          </Tooltip>
          <Separator.Root orientation="vertical" className="w-px h-4 bg-outline-variant mx-0.5" />
          <Tooltip content="Run history">
            <Link href={`/flows/${flow?.id}/executions`} className="flex items-center gap-1 px-1.5 py-1 text-xs text-on-surface-variant hover:text-on-surface-variant transition-colors rounded hover:bg-surface-container-high">
              <Icon name="history" className="text-sm" /> Runs
            </Link>
          </Tooltip>
          <Tooltip content="Debug run — trace execution step by step">
            <button data-testid="debug-btn" onClick={() => setShowDebug(true)} className="flex items-center gap-1 px-1.5 py-1 text-xs text-on-surface-variant hover:text-primary hover:bg-secondary-container transition-colors rounded">
              <Icon name="bug_report" className="text-sm" /> Debug
            </button>
          </Tooltip>
          <Separator.Root orientation="vertical" className="w-px h-4 bg-outline-variant" />
          <Tooltip content={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
            <button onClick={toggleTheme} className="flex items-center gap-1 px-1.5 py-1 text-xs text-on-surface-variant hover:text-on-surface-variant transition-colors rounded hover:bg-surface-container-high">
              {theme === 'light' ? <Icon name="dark_mode" className="text-sm" /> : <Icon name="light_mode" className="text-sm" />} {theme === 'light' ? 'Dark' : 'Light'}
            </button>
          </Tooltip>
          <Separator.Root orientation="vertical" className="w-px h-4 bg-outline-variant" />
          {hasErrors ? (
            <Tooltip content={saveError!}>
              <button onClick={handleSave} disabled={saving || hasErrors} className="m3-button disabled:opacity-50">
                <Icon name="save" className="text-sm" /> {saving ? 'Saving...' : 'Save'}
              </button>
            </Tooltip>
          ) : (
            <button onClick={handleSave} disabled={saving || hasErrors} className="m3-button disabled:opacity-50">
              <Icon name="save" className="text-sm" /> {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {/* Debug overlay */}
      {showDebug && flow && (
        <DebugOverlay flowId={flow.id} nodes={nodes} edges={edges} onClose={() => setShowDebug(false)} />
      )}

      {/* Flow Settings modal */}
      {showFlowSettings && (
        <div data-co-pilot-modal="flow-settings" className="fixed inset-0 z-50 flex items-start justify-center pt-12" onClick={() => setShowFlowSettings(false)}>
          <div className="bg-surface rounded-xl shadow-m3-4 w-full max-w-3xl mx-4 max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <h2 className="text-lg font-semibold text-on-surface">Flow Settings</h2>
              <button onClick={() => setShowFlowSettings(false)} className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error-container rounded transition-colors cursor-pointer">
                <Icon name="close" className="text-base" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <TextField label="Flow name" value={flowSettingsDraft.name || ''} onChange={(v) => setFlowSettingsDraft(p => ({ ...p, name: v }))} />
                {groups.length > 0 && (
                  <SearchableSelect
                    label="Group"
                    value={flowSettingsDraft.group_id || ''}
                    onChange={(v) => { setFlowSettingsDraft(p => ({ ...p, group_id: v || null })); saveFlowSettings({ group_id: v || null }); loadInheritedData(v || null); }}
                    items={groups.map(g => ({ value: g.id, label: g.name }))}
                    includeAll={true}
                    allLabel="No group"
                  />
                )}
              </div>
              <TextField label="Description" value={flowSettingsDraft.description || ''} onChange={(v) => { setFlowSettingsDraft(p => ({ ...p, description: v })); saveFlowSettings({ description: v }); }} multiline rows={2} />
              <div>
                <label className="text-xs font-medium text-on-surface-variant block mb-1">Flow Context</label>
                <textarea
                  value={flowSettingsDraft.flow_context || ''}
                  onChange={e => { setFlowSettingsDraft(p => ({ ...p, flow_context: e.target.value })); saveFlowSettings({ flow_context: e.target.value }); }}
                  placeholder="Context for this specific flow..."
                  rows={6}
                  className="w-full text-sm border border-outline rounded-lg px-3 py-2 font-mono bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-y"
                />
                <p className="mt-1 text-[10px] text-on-surface-variant">This context is injected between the group context and the agent contexts.</p>
              </div>

              {/* ── Inherited Secrets (read-only) ── */}
              {inheritedSecrets.length > 0 && (
                <div className="border-t border-outline-variant pt-4">
                  <span className="text-xs font-medium text-on-surface-variant block mb-2">Inherited Secrets</span>
                  <p className="text-[10px] text-on-surface-variant mb-2">Available via {'{{secrets.NAME}}'} templates. These are inherited from upper scopes and are read-only here.</p>
                  <div className="space-y-1">
                    {inheritedSecrets.map((s, i) => (
                      <div key={i} className="flex items-center gap-2 bg-surface-container rounded px-2 py-1.5">
                        <Icon name="key" className="text-xs text-on-surface-variant shrink-0" />
                        <span className="text-xs font-mono text-on-surface">{s.name}</span>
                        <span className="text-[10px] text-on-surface-variant ml-auto">{s.scope === 'app' ? 'App-wide' : s.groupName || 'Group'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Inherited Env Vars (read-only) ── */}
              {inheritedEnvVars.length > 0 && (
                <div className="border-t border-outline-variant pt-4">
                  <span className="text-xs font-medium text-on-surface-variant block mb-2">Inherited Environment Variables</span>
                  <p className="text-[10px] text-on-surface-variant mb-2">Available via {'{{env.NAME}}'} templates. These are inherited from upper scopes and are read-only here.</p>
                  <div className="space-y-1">
                    {inheritedEnvVars.map((v, i) => (
                      <div key={i} className="flex items-center gap-2 bg-surface-container rounded px-2 py-1.5">
                        <Icon name="settings" className="text-xs text-on-surface-variant shrink-0" />
                        <span className="text-xs font-mono text-on-surface">{v.name}</span>
                        <span className="text-xs text-on-surface-variant ml-2">{v.value}</span>
                        <span className="text-[10px] text-on-surface-variant ml-auto">{v.scope}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Flow-level Secrets ── */}
              {flow?.id && (
                <div className="border-t border-outline-variant pt-4">
                  <span className="text-xs font-medium text-on-surface-variant block mb-2">Flow Secrets</span>
                  {flowSecrets.length > 0 && (
                    <div className="space-y-1 mb-3">
                      {flowSecrets.map(s => (
                        <div key={s.id} className="flex items-center justify-between bg-surface-container rounded px-2 py-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-mono text-on-surface truncate">{s.name}</span>
                            {s.secretType === 'cyberark' ? (
                              <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-surface-container-high text-on-surface-variant shrink-0">CyberArk</span>
                            ) : (
                              <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-primary-container text-primary shrink-0">Core</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {revealedSecrets[s.id] ? (
                              <div className="flex items-center gap-2 px-2 py-1 bg-secondary-container rounded text-xs">
                                <span className="font-mono text-on-surface max-w-[150px] truncate">{revealedSecrets[s.id].value}</span>
                                <span className="text-[10px] text-on-surface-variant whitespace-nowrap">{Math.max(0, Math.floor((revealedSecrets[s.id].expiresAt - now) / 1000))}s</span>
                              </div>
                            ) : (
                              <button
                                onClick={async () => {
                                  const confirmed = await revealSecretConfirm.confirm({ message: `Reveal the value of "${s.name}"?`, confirmLabel: 'Reveal' });
                                  if (!confirmed) return;
                                  const res = await fetch(`/api/secrets/${s.id}/reveal`, { method: 'POST', credentials: 'include' });
                                  if (res.ok) {
                                    const data = await res.json();
                                    const expiresAt = Date.now() + 10000;
                                    setRevealedSecrets(prev => ({ ...prev, [s.id]: { value: data.value, expiresAt } }));
                                    setTimeout(() => {
                                      setRevealedSecrets(prev => {
                                        const next = { ...prev };
                                        delete next[s.id];
                                        return next;
                                      });
                                    }, 10000);
                                  }
                                }}
                                className="p-1 text-on-surface-variant hover:text-primary rounded text-xs"
                              ><Icon name="visibility" className="text-sm" /></button>
                            )}
                            <button
                              onClick={async () => {
                                await fetch(`/api/secrets/${s.id}`, { method: 'DELETE', credentials: 'include' });
                                setFlowSecrets(prev => prev.filter(x => x.id !== s.id));
                              }}
                              className="p-1 text-on-surface-variant hover:text-error rounded text-xs"
                            ><Icon name="delete" className="text-sm" /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2 items-start">
                    <input
                      data-testid="flow-secret-name"
                      placeholder="Secret name"
                      value={newSecretName}
                      onChange={e => setNewSecretName(e.target.value)}
                      className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                    />
                    <div className="flex gap-1 shrink-0 items-center pt-1">
                      <button
                        onClick={() => setNewSecretType('core')}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${newSecretType === 'core' ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'}`}
                      >Core</button>
                      <button
                        onClick={() => setNewSecretType('cyberark')}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${newSecretType === 'cyberark' ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant'}`}
                      >CyberArk</button>
                    </div>
                    {newSecretType === 'cyberark' ? (
                      <input
                        placeholder="Reference path"
                        value={newSecretValue}
                        onChange={e => setNewSecretValue(e.target.value)}
                        className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                      />
                    ) : (
                      <input
                        data-testid="flow-secret-value"
                        placeholder="Value"
                        value={newSecretValue}
                        onChange={e => setNewSecretValue(e.target.value)}
                        type="password"
                        className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                      />
                    )}
                    <button
                      onClick={async () => {
                        if (!newSecretName || !newSecretValue) return;
                        const body: Record<string, unknown> = { name: newSecretName, scope: 'flow', scopeId: flow.id, secretType: newSecretType };
                        if (newSecretType === 'core') body.value = newSecretValue;
                        else body.referencePath = newSecretValue;
                        const res = await fetch(`/api/secrets`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify(body),
                        });
                        if (res.ok) {
                          const created = await res.json();
                          setFlowSecrets(prev => [...prev, created]);
                          setNewSecretName('');
                          setNewSecretValue('');
                        }
                      }}
                      className="m3-button text-xs shrink-0"
                    ><Icon name="add" className="text-xs" /></button>
                  </div>
                  <p className="mt-1 text-[10px] text-on-surface-variant">Secrets are encrypted at rest. Use {'{{secrets.core.flow:NAME}}'} in templates.</p>
              </div>
              )}

              {/* ── Flow-level Env Vars ── */}
              <div className="border-t border-outline-variant pt-4">
                <span className="text-xs font-medium text-on-surface-variant block mb-2">Environment Variables</span>
                <p className="text-[10px] text-on-surface-variant mb-2">Available as {'{{env.NAME}}'} in templates and {'$NAME'} in bash commands.</p>
                {flowEnvVars.length > 0 && (
                  <div className="space-y-1 mb-3">
                    {flowEnvVars.map((ev, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-surface-container rounded px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-on-surface">{ev.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ev.type === 'static' ? 'bg-primary-container text-primary' : ev.type === 'core_secret' ? 'bg-secondary-container text-secondary' : 'bg-tertiary-container text-tertiary'}`}>
                            {ev.type === 'static' ? 'Static' : ev.type === 'core_secret' ? 'Core Secret' : 'CyberArk'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              const newVal = prompt('Edit value:', ev.value);
                              if (newVal !== null) {
                                setFlowEnvVars(prev => prev.map((x, i) => i === idx ? { ...x, value: newVal } : x));
                              }
                            }}
                            className="p-1 text-on-surface-variant hover:text-primary rounded text-xs"
                          ><Icon name="edit" className="text-sm" /></button>
                          <button
                            onClick={async () => {
                              const updated = flowEnvVars.filter((_, i) => i !== idx);
                              setFlowEnvVars(updated);
                              if (flow.id && !isNew) {
                                await api.flows.update(flow.id, { envVars: updated }).catch(() => {});
                              }
                            }}
                            className="p-1 text-on-surface-variant hover:text-error rounded text-xs"
                          ><Icon name="delete" className="text-sm" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-start">
                  <input
                    placeholder="Variable name"
                    value={newEnvVarName}
                    onChange={e => setNewEnvVarName(e.target.value)}
                    className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                  />
                  <select
                    value={newEnvVarType}
                    onChange={e => setNewEnvVarType(e.target.value as any)}
                    className="text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                  >
                    <option value="static">Static</option>
                    <option value="core_secret">Core Secret</option>
                    <option value="cyberark">CyberArk</option>
                  </select>
                  {newEnvVarType === 'core_secret' ? (
                    <select
                      value={newEnvVarValue}
                      onChange={e => setNewEnvVarValue(e.target.value)}
                      className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                    >
                      <option value="">— Select a secret —</option>
                      {availableSecrets.map(s => (
                        <option key={s.value + s.label} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  ) : newEnvVarType === 'cyberark' ? (
                    <select
                      value={newEnvVarValue}
                      onChange={e => setNewEnvVarValue(e.target.value)}
                      className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                    >
                      <option value="">— Select a CyberArk secret —</option>
                      {availableCyberArks.map(s => (
                        <option key={s.value + s.label} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      placeholder="Value"
                      value={newEnvVarValue}
                      onChange={e => setNewEnvVarValue(e.target.value)}
                      className="flex-1 text-xs border border-outline rounded px-2 py-1.5 bg-surface"
                    />
                  )}
                  <button
                    onClick={async () => {
                      if (!newEnvVarName || !newEnvVarValue) return;
                      const updated = [...flowEnvVars, { name: newEnvVarName.trim(), type: newEnvVarType, value: newEnvVarValue.trim() }];
                      setFlowEnvVars(updated);
                      setNewEnvVarName('');
                      setNewEnvVarValue('');
                      if (flow.id && !isNew) {
                        await api.flows.update(flow.id, { envVars: updated }).catch(() => {});
                      }
                    }}
                    className="m3-button text-xs shrink-0"
                  ><Icon name="add" className="text-xs" /></button>
                </div>
              </div>
              {flow?.id && !isNew && isChatFlow && (
                <ChatApiSettings
                  flowId={flow.id}
                  isChatFlow={isChatFlow}
                />
              )}
            </div>
          </div>
        </div>
      )}
      {revealSecretConfirm.dialog}

      {/* Personal API Key creation modal */}
      {showKeyModal && personalApiKey && (
        <div data-co-pilot-modal="api-key" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-surface rounded-xl shadow-m3-4 p-6 max-w-md w-full mx-4 space-y-4">
            <h3 className="m3-title-small text-on-surface">Personal API Key Created</h3>
            <p className="m3-body-small text-on-surface-variant">
              This key is shown once. Copy it now. If you lose it, you can renew it in the trigger settings.
            </p>
            <div className="flex items-center gap-2 bg-surface-container rounded-lg p-3">
              <code className="flex-1 text-xs font-mono break-all">{personalApiKey}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(personalApiKey); }}
                className="m3-button-tonal text-xs px-3 py-1.5"
              >
                <Icon name="content_copy" className="text-sm" />
                Copy
              </button>
            </div>
            <button
              onClick={() => { setShowKeyModal(false); setPersonalApiKey(null); }}
              className="m3-button w-full"
            >
              I&apos;ve copied my key
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
