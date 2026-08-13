import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useUpdateNodeInternals,
  addEdge,
  type Connection,
  type OnConnect,
  ReactFlowProvider,
  type Node,
  type OnConnectEnd,
  type OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TriggerNode } from './nodes/TriggerNode';
import { LLMAgentNode } from './nodes/LLMAgentNode';
import { MCPToolNode } from './nodes/MCPToolNode';
import { FlowToolNode } from './nodes/FlowToolNode';
import { RetrieverNode } from './nodes/RetrieverNode';
import { ConditionNode } from './nodes/ConditionNode';
import { SwitchNode } from './nodes/SwitchNode';
import { CodeNode } from './nodes/CodeNode';
import { OutputNode } from './nodes/OutputNode';
import { ParallelNode } from './nodes/ParallelNode';
import { HITLNode } from './nodes/HITLNode';
import { SubflowNode } from './nodes/SubflowNode';
import { HttpNode } from './nodes/HttpNode';
import { LoopNode } from './nodes/LoopNode';
import { DelayNode } from './nodes/DelayNode';
import { AIActionNode } from './nodes/AIActionNode';
import { MapNode } from './nodes/MapNode';
import { NoteNode } from './nodes/NoteNode';
import { DeletableEdge } from './DeletableEdge';

const edgeTypes = { default: DeletableEdge, smoothstep: DeletableEdge };

const nodeTypes = {
  trigger: TriggerNode,
  'llm-agent': LLMAgentNode,
  'mcp-tool': MCPToolNode,
  'flow-tool': FlowToolNode,
  retriever: RetrieverNode,
  condition: ConditionNode,
  switch: SwitchNode,
  code: CodeNode,
  output: OutputNode,
  parallel: ParallelNode,
  hitl: HITLNode,
  subflow: SubflowNode,
  http: HttpNode,
  loop: LoopNode,
  delay: DelayNode,
  'ai-action': AIActionNode,
  map: MapNode,
  note: NoteNode,
};

interface FlowEditorProps {
  initialNodes?: any[];
  initialEdges?: any[];
  onNodesChange?: (nodes: any[]) => void;
  onEdgesChange?: (edges: any[]) => void;
  addNodeCallbackRef?: React.MutableRefObject<((type: string, defaultConfig: Record<string, any>) => void) | null>;
  setNodeDataCallbackRef?: React.MutableRefObject<((nodeId: string, config: Record<string, any>) => void) | null>;
  deleteNodeCallbackRef?: React.MutableRefObject<((nodeId: string) => void) | null>;
  setNodeLabelRef?: React.MutableRefObject<((nodeId: string, label: string) => void) | null>;
  onNodeClick?: (nodeId: string, nodeData: any) => void;
  onNodeDragStart?: (nodeId: string) => void;
}

export function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowEditorInner({ initialNodes = [], initialEdges = [], onNodesChange, onEdgesChange, addNodeCallbackRef, setNodeDataCallbackRef, deleteNodeCallbackRef, setNodeLabelRef, onNodeClick, onNodeDragStart }: FlowEditorProps) {
  const [nodes, setNodes, rawOnNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(initialEdges);
  const { screenToFlowPosition } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const serializedRef = useRef(JSON.stringify({ nodes: initialNodes, edges: initialEdges }));

  // Sync with parent state (undo/redo) without remounting the component
  useEffect(() => {
    const serialized = JSON.stringify({ nodes: initialNodes, edges: initialEdges });
    if (serialized !== serializedRef.current) {
      serializedRef.current = serialized;
      // The parent receives canvas changes via a debounced rAF propagation,
      // so on a config-driven re-render here its initialEdges can be stale
      // and would wipe edges created moments earlier. Preserve canvas-local
      // edges the parent hasn't received yet; the propagation will carry
      // them up.
      const pendingEdges = edges.filter(e => !initialEdges.some(ie => ie.id === e.id));
      setNodes(initialNodes);
      setEdges(pendingEdges.length > 0 ? [...initialEdges, ...pendingEdges] : initialEdges);
      // Force handle re-registration for nodes with dynamic handle counts (branch)
      const branchIds = initialNodes.filter(n => n.type === 'condition' && n.data?.config?.outputLabels?.length > 0).map(n => n.id);
      if (branchIds.length > 0) {
        requestAnimationFrame(() => { for (const id of branchIds) updateNodeInternals(id); });
      }
    }
  }, [initialNodes, initialEdges, edges, updateNodeInternals]);

  // Expose live canvas state for Co-Pilot tools
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__flowCanvasNodes = nodes;
      (window as any).__flowCanvasEdges = edges;
    }
  }, [nodes, edges]);

  // Filter out position/drag changes for child nodes (they snap to grid)
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const onNodesChangeInternal = useCallback((changes: any[]) => {
    rawOnNodesChange(changes.filter((c: any) => {
      // Prevent deletion of trigger nodes
      if (c.type === 'remove') {
        const node = nodesRef.current.find((n: any) => n.id === c.id);
        if (node?.data?.type === 'trigger') return false;
      }
      if (c.type !== 'position' && c.type !== 'dimensions') return true;
      if (c.type === 'position') {
        const node = nodesRef.current.find(n => n.id === c.id);
        if (node?.parentId) return false;
      }
      return true;
    }));
  }, [rawOnNodesChange]);
  const onNodesChangeRef = useRef(onNodesChange);
  const onEdgesChangeRef = useRef(onEdgesChange);
  onNodesChangeRef.current = onNodesChange;
  onEdgesChangeRef.current = onEdgesChange;

  // Propagate changes back to parent (debounced via requestAnimationFrame)
  const syncRef = useRef<number | null>(null);
  useEffect(() => {
    if (syncRef.current) cancelAnimationFrame(syncRef.current);
    syncRef.current = requestAnimationFrame(() => {
      onNodesChangeRef.current?.(nodes);
      onEdgesChangeRef.current?.(edges);
    });
  }, [nodes, edges]);

  // Resize parallel containers when their children change
  const resizeParallel = useCallback((nds: Node[]) => {
    let changed = false;
    const updated = nds.map(n => {
      if (n.type !== 'parallel') return n;
      const children = nds.filter(c => c.parentId === n.id);
      const childCount = children.length;
      if (childCount === 0) {
        if (n.style?.width !== 260 || n.style?.height !== 240) {
          changed = true;
          return { ...n, style: { ...n.style, width: 260, height: 240 }, width: 260, height: 240 };
        }
        return n;
      }
      const targetH = Math.max(250, 60 + childCount * 170);
      if (Number(n.style?.height || n.height || 240) !== targetH) {
        changed = true;
        return { ...n, style: { ...n.style, width: 260, height: targetH }, width: 260, height: targetH };
      }
      return n;
    });
    return changed ? updated : nds;
  }, []);

  useEffect(() => {
    setNodes(resizeParallel);
  }, [nodes, resizeParallel]);

  // Helper: re-layout children inside a parallel node (used by drag-stop handler)
  const layoutChildren = useCallback((parentId: string, nds: Node[]) => {
    const children = nds
      .filter(n => n.parentId === parentId)
      .sort((a, b) => a.id.localeCompare(b.id));
    return nds.map(n => {
      if (n.parentId !== parentId) return n;
      const idx = children.findIndex(c => c.id === n.id);
      if (idx < 0) return n;
      let ty = 50;
      for (let i = 0; i < idx; i++) {
        const prev = children[i];
        const h = prev.measured?.height || 140;
        ty += h + 30;
      }
      if (n.position.x === 20 && Math.abs(n.position.y - ty) <= 5) return n;
      return { ...n, position: { x: 20, y: ty } };
    });
  }, []);

  // Re-layout all children once after nodes change
  const layoutRef = useRef(false);
  useEffect(() => {
    if (layoutRef.current) return;
    layoutRef.current = true;
    const parallels = nodes.filter(n => n.type === 'parallel');
    if (parallels.length === 0) return;
    let result = nodes;
    for (const p of parallels) {
      result = layoutChildren(p.id, result);
    }
    if (result !== nodes) {
      setNodes(result);
    }
    // Reset after a tick
    setTimeout(() => { layoutRef.current = false; }, 100);
  }, [nodes, layoutChildren]);

  const addNode = useCallback((type: string, defaultConfig: Record<string, any>) => {
    const rf = document.querySelector('.react-flow') as HTMLElement | null;
    const cx = rf ? rf.clientWidth / 2 : window.innerWidth / 2;
    const cy = rf ? rf.clientHeight / 2 : window.innerHeight / 2;
    const center = screenToFlowPosition({ x: cx, y: cy });
    const existing = nodes.filter(n => n.type === type);
    const nextNum = existing.length + 1;
    const newNode: Node = {
      id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      position: {
        x: center.x - 75 + Math.random() * 40,
        y: center.y + Math.random() * 40,
      },
      data: { label: `${type}${nextNum}`, type, config: { ...defaultConfig } },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, nodes, screenToFlowPosition]);

  // Expose addNode to parent via ref and globally for Co-Pilot
  useEffect(() => {
    if (addNodeCallbackRef) {
      addNodeCallbackRef.current = addNode;
    }
    if (typeof window !== 'undefined') {
      (window as any).__addFlowNode = addNode;
    }
  }, [addNode, addNodeCallbackRef]);

  // Expose setNodeData to parent via ref — updates a node's config in-place
  const setNodeData = useCallback((nodeId: string, config: Record<string, any>) => {
    setNodes((nds) => nds.map((n) =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, config: { ...n.data.config, ...config } } }
        : n
    ));
    requestAnimationFrame(() => updateNodeInternals(nodeId));
  }, [setNodes, updateNodeInternals]);

  useEffect(() => {
    if (setNodeDataCallbackRef) {
      setNodeDataCallbackRef.current = setNodeData;
    }
  }, [setNodeData, setNodeDataCallbackRef]);

  // Expose setNodeLabel to parent via ref
  const setNodeLabel = useCallback((nodeId: string, label: string) => {
    setNodes((nds) => nds.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, label } } : n
    ));
  }, [setNodes]);

  useEffect(() => {
    if (setNodeLabelRef) {
      setNodeLabelRef.current = setNodeLabel;
    }
  }, [setNodeLabel, setNodeLabelRef]);

  // Expose deleteNode to parent via ref
  const deleteNode = useCallback((nodeId: string) => {
    // Prevent deletion of trigger nodes
    const target = nodes.find(n => n.id === nodeId);
    if (target && (target.data as any)?.type === 'trigger') return;

    // Collect all IDs to delete: the node itself + all descendants
    const toDelete = new Set([nodeId]);
    const collectChildren = (id: string) => {
      for (const n of nodes) {
        if (n.parentId === id && !toDelete.has(n.id)) {
          toDelete.add(n.id);
          collectChildren(n.id);
        }
      }
    };
    collectChildren(nodeId);

    setNodes((nds) => nds.filter(n => !toDelete.has(n.id)));
    setEdges((eds) => eds.filter(e => !toDelete.has(e.source) && !toDelete.has(e.target)));
  }, [setNodes, setEdges, nodes]);

  useEffect(() => {
    if (deleteNodeCallbackRef) {
      deleteNodeCallbackRef.current = deleteNode;
    }
    if (typeof window !== 'undefined') {
      (window as any).__deleteFlowNode = deleteNode;
    }
  }, [deleteNode, deleteNodeCallbackRef]);

  const connectNodes = useCallback(
    (source: string, target: string, sourceHandle?: string) => {
      setEdges((eds) => addEdge({
        source, target, sourceHandle,
      } as any, eds));
    },
    [setEdges]
  );

  const removeEdge = useCallback(
    (source: string, target: string, sourceHandle?: string) => {
      setEdges((eds) => eds.filter(e => !(e.source === source && e.target === target && (!sourceHandle || e.sourceHandle === sourceHandle))));
    },
    [setEdges]
  );

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__connectFlowNodes = connectNodes;
      (window as any).__removeFlowEdge = removeEdge;
    }
  }, [connectNodes, removeEdge]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const isFeedback = connection.targetHandle === 'feedback-input';
      setEdges((eds) => addEdge({
        ...connection,
        style: isFeedback ? { strokeDasharray: '5,5', stroke: 'var(--md-warning)', strokeWidth: 2 } : undefined,
        animated: isFeedback,
      }, eds));
    },
    [setEdges]
  );

  const isValidConnection = useCallback(
    (connection: Connection) => {
      // Tool input handles can have multiple connections
      if (connection.targetHandle?.startsWith('tool-input')) return true;
      // Feedback input handle: only allow edges from HITL nodes
      if (connection.targetHandle === 'feedback-input') {
        const sourceNode = nodes.find(n => n.id === connection.source);
        return sourceNode?.data?.type === 'hitl';
      }
      // Check if target already has an incoming connection on this handle
      const existing = edges.find(
        e => e.target === connection.target && e.targetHandle === connection.targetHandle
      );
      return !existing;
    },
    [edges, nodes]
  );

  return (
      <div className="w-full h-full bg-surface">
          <ReactFlow
            data-testid="flow-canvas"
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeInternal}
          onEdgesChange={onEdgesChangeInternal}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: 'var(--md-outline)', strokeWidth: 2 }, animated: false }}
          fitView
          fitViewOptions={{ minZoom: 0.5, maxZoom: 1, padding: 0.2 }}
          minZoom={0.25}
          maxZoom={2}
          deleteKeyCode={['Backspace', 'Delete']}
          onNodeClick={(_event, node) => onNodeClick?.(node.id, node.data)}
          onNodeDragStart={(_event, node) => onNodeDragStart?.(node.id)}
          onNodeDragStop={(_event, node) => {
            if (node.parentId) {
              // Check if dragged outside parent bounds — if so, detach
              const parent = nodes.find(n => n.id === node.parentId);
              if (parent) {
                const pw = (parent.style?.width || parent.width || 300) as number;
                const ph = (parent.style?.height || parent.height || 200) as number;
                // Node position is relative to parent, so check against (0,0) to (pw,ph)
                if (node.position.x < -50 || node.position.x > pw + 50 || node.position.y < -50 || node.position.y > ph + 50) {
                  const parentId = node.parentId;
                  setNodes(nds => {
                    const without = nds.map(n => n.id === node.id
                      ? { ...n, parentId: undefined, position: { x: parent.position.x + 50, y: parent.position.y + Number(ph) + 40 } }
                      : n
                    );
                    const laidOut = layoutChildren(parentId, without);
                    const resized = resizeParallel(laidOut);
                    const pars = resized.filter(n => n.type === 'parallel');
                    const others = resized.filter(n => n.type !== 'parallel');
                    return [...pars, ...others];
                  });
                  return;
                }
              }
            } else {
              // Check if dropped inside a parallel node
              const parallels = nodes.filter(n => n.type === 'parallel' && n.id !== node.id);
              for (const p of parallels) {
                const pw = (p.style?.width || p.width || 300) as number;
                const ph = (p.style?.height || p.height || 200) as number;
                const px = p.position.x;
                const py = p.position.y;
                const cx = node.position.x + ((node.measured?.width || 200) as number) / 2;
                const cy = node.position.y + ((node.measured?.height || 80) as number) / 2;
                if (cx >= px && cx <= px + pw && cy >= py && cy <= py + ph) {
                  if (node.type !== 'llm-agent') return;
                  setNodes(nds => {
                    const withParent = nds.map(n => n.id === node.id ? { ...n, parentId: p.id, position: { x: 20, y: 50 } } : n);
                    const laidOut = layoutChildren(p.id, withParent);
                    const resized = resizeParallel(laidOut);
                    const pars = resized.filter(n => n.type === 'parallel');
                    const others = resized.filter(n => n.type !== 'parallel');
                    return [...pars, ...others];
                  });
                  break;
                }
              }
            }
          }}
        >
          <Background gap={16} size={1.5} color="currentColor" />
          <Controls />
          <MiniMap
            style={{ background: 'var(--md-surface-container-high)' }}
            nodeColor="var(--md-primary-container)"
            nodeStrokeColor="var(--md-primary)"
            maskColor="var(--md-surface-dim)"
          />
        </ReactFlow>
      </div>
  );
}
