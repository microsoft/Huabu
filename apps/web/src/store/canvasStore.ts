import {
  createId,
  type AgentBaseContext,
  type CanvasNodeType,
  type KnowledgeStorageConfig,
  type NodeSummary,
  type RecentAction,
} from '@sediment/shared';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type OnNodeDrag,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react';
import { create, type StateCreator } from 'zustand';

import { getCanvas, putCanvas, upsertNode } from '../api';
import {
  handleCommand,
  extractNodeRef,
  extractSnippet,
} from './canvasHandlers';
import { canvasHistoryManager } from './canvasHistoryManager';
import { type AlignDirection } from '../utils/autoLayoutHelper';
import {
  ingestNodeIfNeeded,
  needsIngestion,
  type NodeIngestionInfo,
} from '../utils/ingestHelper';

// ---------------------------------------------------------------------------
// Canvas Command Pattern
// ---------------------------------------------------------------------------

/**
 * All user-initiated canvas mutations expressed as typed commands.
 * `dispatch(cmd)` is the single entry point for:
 *  - undo history snapshots
 *  - action-history tracking (for agent context)
 *  - state mutations
 */
export type CanvasCommand =
  | { type: 'ADD_NODE'; node: Node }
  | { type: 'DELETE_NODES'; nodeIds: string[] }
  | { type: 'CONNECT'; connection: Connection }
  | { type: 'DISCONNECT_EDGES'; edgeIds: string[] }
  | { type: 'MOVE_INTO_FRAME'; nodeId: string; frameId: string }
  | { type: 'MOVE_OUT_OF_FRAME'; nodeId: string }
  | { type: 'GROUP_SELECTION_INTO_FRAME' }
  | {
      type: 'GROUP_RECT_INTO_FRAME';
      flowRect: { x: number; y: number; width: number; height: number };
    }
  | { type: 'UNFRAME'; frameId: string }
  | { type: 'OPEN_EXPANDED'; nodeId: string }
  | { type: 'SELECT_NODES'; ids: string[]; multiSelect?: boolean }
  | {
      type: 'RESIZE_NODE';
      nodeId: string;
      width: number;
      height: number;
    }
  | { type: 'TOGGLE_FRAME_LOCK'; frameId: string }
  | { type: 'REORDER_NODES'; activeId: string; overId: string }
  | { type: 'REORDER_NODES'; nodeIds: string[]; position: 'top' | 'bottom' }
  | { type: 'PASTE_NODES'; flowPosition?: { x: number; y: number } }
  | { type: 'ALIGN_NODES'; direction: AlignDirection }
  | { type: 'SPREAD_NODES' }
  | { type: 'NODE_DRAG_STOP'; draggedNodeIds: string[] }
  | {
      type: 'UPDATE_NODE_DATA';
      nodeId: string;
      patch: Record<string, unknown>;
    };

const CANVAS_ID = 'default-canvas';
const AUTOSAVE_DEBOUNCE_MS = 1000;
const INGESTION_DEBOUNCE_MS = 1000;
const DEFAULT_WORKSPACE_NAME = 'Sediment Workspace Name';

// Per-node debounce timers so rapid edits only fire one ingestion request
// after the user stops typing, rather than on every keystroke.
const ingestionTimers = new Map<string, ReturnType<typeof setTimeout>>();

const triggerIngestion = (node: Node) => {
  const nodeId = node.id;
  const existing = ingestionTimers.get(nodeId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    ingestionTimers.delete(nodeId);
    const state = useCanvasStore.getState();
    // Re-fetch the latest node so we send the most up-to-date content.
    const latestNode = state.nodes.find((n) => n.id === nodeId) ?? node;
    void ingestNodeIfNeeded({
      canvasId: state.canvasId,
      node: latestNode,
      setNodeIngestion: state.setNodeIngestion,
      clearNodeIngestion: state.clearNodeIngestion,
      getNodeById: (id) => state.nodes.find((n) => n.id === id),
      patchNodeSilent: state.patchNodeSilent,
    });
  }, INGESTION_DEBOUNCE_MS);

  ingestionTimers.set(nodeId, timer);
};

type RFState = {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  version: number;
  isLoading: boolean;
  isSaving: boolean;
  pendingSave: boolean;

  workspaceName: string;
  setWorkspaceName: (name: string) => void;

  storageConfig: KnowledgeStorageConfig;
  setStorageConfig: (config: KnowledgeStorageConfig) => void;

  ingestionByNodeId: Record<string, NodeIngestionInfo>;
  setNodeIngestion: (nodeId: string, info: NodeIngestionInfo) => void;
  clearNodeIngestion: (nodeId: string) => void;

  expandedNodeId: string | null;
  expandMode: 'replace' | 'split';
  openExpanded: (nodeId: string) => void;
  closeExpanded: () => void;
  setExpandMode: (mode: 'replace' | 'split') => void;

  collapsedFrameIds: Set<string>;
  toggleFrameCollapse: (frameId: string) => void;
  isFrameCollapsed: (frameId: string) => boolean;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onNodeDragStart: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;
  addNode: (node: Node) => void;
  rfInstance: ReactFlowInstance | null;
  setRfInstance: (instance: ReactFlowInstance | null) => void;

  /**
   * Commit a user-initiated data edit. Always records an undo snapshot.
   * For silent background writes (server callbacks, resize metadata),
   * use `patchNodeSilent` instead.
   */
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /**
   * Apply a node data patch without recording undo history.
   * Use only for programmatic / background writes (e.g. ingest server
   * responses, resize dimension metadata) that should not pollute undo.
   */
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;

  selectNodes: (ids: string[], multiSelect?: boolean) => void;

  reorderNodes: (activeId: string, overId: string) => void;
  sendSelectedToOrder: (direction: 'top' | 'bottom') => void;
  getSelectedSourceIds: () => string[];

  frameSelectedNodes: () => void;
  frameNodesInRect: (flowRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  unframe: (frameId: string) => void;
  toggleFrameLock: (frameId: string) => void;

  /**
   * Take an undo snapshot of the current canvas state.
   * Call once before a drag gesture begins so the entire gesture collapses
   * into a single undo entry (e.g. at onResizeStart / onNodeDragStart).
   */
  takeSnapshot: () => void;

  /** Align selected nodes along an axis. */
  alignSelectedNodes: (direction: AlignDirection) => void;
  /** Spread apart overlapping selected nodes (frame children stay in their frame). */
  spreadSelectedNodes: () => void;

  moveNodeIntoFrame: (nodeId: string, frameId: string) => void;
  moveNodeOutOfFrame: (nodeId: string) => void;

  /** The node type awaiting placement on canvas via click. */
  pendingNodeType: 'note' | 'text' | 'frame' | null;
  setPendingNodeType: (type: 'note' | 'text' | 'frame' | null) => void;

  /** Clipboard for node copy-paste. */
  clipboard: Node[];
  copySelectedNodes: () => void;
  pasteNodes: (flowPosition?: { x: number; y: number }) => void;

  /** Undo / Redo */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  loadCanvas: () => Promise<void>;
  saveCanvas: () => Promise<void>;

  actionHistory: RecentAction[];
  dispatch: (cmd: CanvasCommand) => void;
  getAgentContext: () => AgentBaseContext;
};

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

const scheduleAutoSave = (saveCanvas: () => Promise<void>) => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveCanvas();
  }, AUTOSAVE_DEBOUNCE_MS);
};

const PERSISTED_KEYS = [
  'nodes',
  'edges',
  'workspaceName',
  'storageConfig',
] as const;
type PersistedKey = (typeof PERSISTED_KEYS)[number];

/**
 * Middleware that:
 * 1. Automatically schedules a canvas save whenever a persisted field
 *    (nodes, edges, workspaceName, storageConfig) changes.
 *    Skipped while `isLoading` is true to avoid triggering a save during load.
 * 2. Automatically syncs `canUndo` / `canRedo` with the history manager
 *    after every state update, so individual actions never need to set them.
 */
const autoSaveMiddleware =
  (config: StateCreator<RFState>): StateCreator<RFState> =>
  (set, get, api) => {
    // Shared post-set logic: autosave diff + history availability sync.
    const afterSet = (prev: RFState) => {
      // --- Auto-sync undo/redo availability ---
      const cur = get();
      const nextCanUndo = canvasHistoryManager.canUndo;
      const nextCanRedo = canvasHistoryManager.canRedo;
      if (cur.canUndo !== nextCanUndo || cur.canRedo !== nextCanRedo) {
        // Use raw `set` to avoid infinite recursion.
        (set as (partial: Partial<RFState>) => void)({
          canUndo: nextCanUndo,
          canRedo: nextCanRedo,
        });
      }

      // --- Autosave diff ---
      if (!prev.isLoading) {
        const next = get();
        const changed = (PERSISTED_KEYS as readonly PersistedKey[]).some(
          (k) => prev[k] !== next[k],
        );
        if (changed) {
          scheduleAutoSave(next.saveCanvas);
        }
      }
    };

    // Wrap the internal `set` used by store actions.
    const wrappedSet: typeof set = (...args) => {
      const prev = get();
      (set as (...a: typeof args) => void)(...args);
      afterSet(prev);
    };

    // Also wrap `api.setState` so that external callers
    // (e.g. useCanvasStore.setState()) trigger autosave as well.
    const originalSetState = api.setState;
    api.setState = (...args) => {
      const prev = get();
      (originalSetState as (...a: typeof args) => void)(...args);
      afterSet(prev);
    };

    return config(wrappedSet, get, api);
  };

const useCanvasStore = create<RFState>()(
  autoSaveMiddleware((set, get) => ({
    nodes: [],
    edges: [],
    canvasId: CANVAS_ID,
    version: 0,
    isLoading: false,
    isSaving: false,
    pendingSave: false,

    workspaceName: DEFAULT_WORKSPACE_NAME,
    setWorkspaceName: (name) => {
      set({ workspaceName: name });
    },

    storageConfig: { backend: 'sqlite' },
    setStorageConfig: (config) => {
      set({ storageConfig: config });
    },

    ingestionByNodeId: {},
    setNodeIngestion: (nodeId, info) => {
      if (!nodeId) return;
      set({
        ingestionByNodeId: {
          ...get().ingestionByNodeId,
          [nodeId]: info,
        },
      });
    },
    clearNodeIngestion: (nodeId) => {
      if (!nodeId) return;
      const next = { ...get().ingestionByNodeId };
      delete next[nodeId];
      set({ ingestionByNodeId: next });
    },

    expandedNodeId: null,
    expandMode: 'replace',
    openExpanded: (nodeId) => get().dispatch({ type: 'OPEN_EXPANDED', nodeId }),
    closeExpanded: () => set({ expandedNodeId: null }),
    setExpandMode: (mode) => set({ expandMode: mode }),

    pendingNodeType: null,
    setPendingNodeType: (type) => set({ pendingNodeType: type }),

    collapsedFrameIds: new Set<string>(),
    toggleFrameCollapse: (frameId) => {
      const { collapsedFrameIds } = get();
      const next = new Set(collapsedFrameIds);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      set({ collapsedFrameIds: next });
    },
    isFrameCollapsed: (frameId) => {
      return get().collapsedFrameIds.has(frameId);
    },

    // -----------------------------------------------------------------------
    // Action history & agent context
    // -----------------------------------------------------------------------

    actionHistory: [],

    dispatch: (cmd) => {
      const { nodes, edges, canvasId, actionHistory, clipboard } = get();
      handleCommand(cmd, {
        nodes,
        edges,
        canvasId,
        actionHistory,
        clipboard,
        set,
        triggerIngestion,
      });
    },

    getAgentContext: (): AgentBaseContext => {
      const { nodes, edges, actionHistory } = get();
      // Build a lookup map once to avoid O(n²) scans inside edges.map.
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      return {
        nodes: nodes.map(
          (n): NodeSummary => ({
            id: n.id,
            type: (n.type ?? 'note') as CanvasNodeType,
            label: n.data?.label as string | undefined,
            snippet: extractSnippet(n),
            selected: n.selected ?? false,
            frameLabel: n.parentId
              ? (nodeMap.get(n.parentId)?.data?.label as string | undefined)
              : undefined,
            sourceId: n.data?.sourceId as string | undefined,
          }),
        ),
        edges: edges.map((e) => {
          const sourceNode = nodeMap.get(e.source);
          const targetNode = nodeMap.get(e.target);
          return {
            source: sourceNode
              ? extractNodeRef(sourceNode)
              : { id: e.source, nodeType: 'note' as CanvasNodeType },
            target: targetNode
              ? extractNodeRef(targetNode)
              : { id: e.target, nodeType: 'note' as CanvasNodeType },
          };
        }),
        recentActions: actionHistory,
      };
    },

    loadCanvas: async () => {
      set({ isLoading: true });
      try {
        const { canvasId } = get();
        const response = await getCanvas(canvasId);
        if (!response) {
          console.warn('Canvas not found, using empty state');
          canvasHistoryManager.clear();
          set({ isLoading: false, ingestionByNodeId: {} });
          return;
        }

        const state = response.state as {
          nodes?: Node[];
          edges?: Edge[];
          workspaceName?: string;
          storageConfig?: KnowledgeStorageConfig;
        };
        canvasHistoryManager.clear();
        set({
          nodes: state.nodes ?? [],
          edges: state.edges ?? [],
          workspaceName: state.workspaceName ?? get().workspaceName,
          storageConfig: state.storageConfig ?? get().storageConfig,
          version: response.version,
          isLoading: false,
          ingestionByNodeId: {},
        });
      } catch (error) {
        console.error('Failed to load canvas:', error);
        set({ isLoading: false });
      }
    },

    saveCanvas: async () => {
      const { isSaving } = get();
      if (isSaving) {
        set({ pendingSave: true });
        return;
      }

      set({ isSaving: true });
      try {
        const {
          nodes,
          edges,
          version,
          canvasId,
          workspaceName,
          storageConfig,
        } = get();
        const response = await putCanvas(canvasId, {
          version,
          state: { nodes, edges, workspaceName, storageConfig },
        });
        set({ version: response.version });
      } catch (error) {
        console.error('Failed to save canvas:', error);
        // TODO: Handle version conflict (409) - reload and prompt user
      } finally {
        set({ isSaving: false });

        const { pendingSave } = get();
        if (pendingSave) {
          set({ pendingSave: false });
          // Fire-and-forget: re-save the latest state after the in-flight save completes.
          void get().saveCanvas();
        }
      }
    },

    onNodeDragStart: () => {
      // Snapshot the true pre-drag positions before any intermediate
      // position updates are applied by ReactFlow.
      const { nodes, edges } = get();
      canvasHistoryManager.takeSnapshot(nodes, edges);
    },

    onNodeDragStop: (_event, _node, draggedNodes) => {
      get().dispatch({
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: draggedNodes.map((n) => n.id),
      });
    },

    onNodesChange: (changes) => {
      // Only process RF-internal change types (position, selection, dimensions).
      // Deletions must go through dispatch({ type: 'DELETE_NODES' }).
      // Additions must go through dispatch({ type: 'ADD_NODE' }).
      const internalChanges = changes.filter(
        (c) => c.type !== 'remove' && c.type !== 'add',
      );
      if (internalChanges.length === 0) return;
      set({ nodes: applyNodeChanges(internalChanges, get().nodes) });
    },

    onEdgesChange: (changes) => {
      const removes = changes.filter((c) => c.type === 'remove');
      if (removes.length > 0) {
        get().dispatch({
          type: 'DISCONNECT_EDGES',
          edgeIds: removes.map((c) => c.id),
        });
      }
      const internalChanges = changes.filter((c) => c.type !== 'remove');
      if (internalChanges.length > 0) {
        set({ edges: applyEdgeChanges(internalChanges, get().edges) });
      }
    },

    onConnect: (connection: Connection) => {
      get().dispatch({ type: 'CONNECT', connection });
    },

    rfInstance: null,
    setRfInstance: (instance) => set({ rfInstance: instance }),

    addNode: (node) => {
      get().dispatch({ type: 'ADD_NODE', node });
    },

    updateNodeData: (nodeId, patch) => {
      if (!nodeId) return;
      get().dispatch({
        type: 'UPDATE_NODE_DATA',
        nodeId,
        patch,
      });
    },

    patchNodeSilent: (nodeId, patch) => {
      if (!nodeId) return;
      set({
        nodes: get().nodes.map((n) => {
          if (n.id !== nodeId) return n;
          return {
            ...n,
            data: {
              ...(n.data ?? {}),
              ...patch,
            },
          };
        }),
      });
    },

    getSelectedSourceIds: () => {
      return get()
        .nodes.filter((n) => n.selected && n.data?.sourceId)
        .map((n) => n.data.sourceId as string);
    },

    selectNodes: (ids, multiSelect = false) => {
      get().dispatch({ type: 'SELECT_NODES', ids, multiSelect });
    },

    reorderNodes: (activeId: string, overId: string) => {
      get().dispatch({ type: 'REORDER_NODES', activeId, overId });
    },

    sendSelectedToOrder: (direction) => {
      const nodeIds = get()
        .nodes.filter((n) => n.selected)
        .map((n) => n.id);
      get().dispatch({ type: 'REORDER_NODES', nodeIds, position: direction });
    },

    frameSelectedNodes: () => {
      get().dispatch({ type: 'GROUP_SELECTION_INTO_FRAME' });
    },

    frameNodesInRect: (flowRect) => {
      get().dispatch({ type: 'GROUP_RECT_INTO_FRAME', flowRect });
    },

    unframe: (frameId) => {
      get().dispatch({ type: 'UNFRAME', frameId });
    },

    toggleFrameLock: (frameId) => {
      get().dispatch({ type: 'TOGGLE_FRAME_LOCK', frameId });
    },

    takeSnapshot: () => {
      const { nodes, edges } = get();
      canvasHistoryManager.takeSnapshot(nodes, edges);
    },

    alignSelectedNodes: (direction) => {
      get().dispatch({ type: 'ALIGN_NODES', direction });
    },

    spreadSelectedNodes: () => {
      get().dispatch({ type: 'SPREAD_NODES' });
    },

    moveNodeIntoFrame: (nodeId, frameId) => {
      get().dispatch({ type: 'MOVE_INTO_FRAME', nodeId, frameId });
    },

    moveNodeOutOfFrame: (nodeId) => {
      get().dispatch({ type: 'MOVE_OUT_OF_FRAME', nodeId });
    },

    clipboard: [],

    copySelectedNodes: () => {
      const { nodes } = get();
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;

      // Extract only serialisable properties to avoid structuredClone failures
      // on ReactFlow internal properties (measured, internals, etc.)
      const cloned: Node[] = selected.map((n) => ({
        id: createId('node'),
        type: n.type,
        position: { x: n.position.x, y: n.position.y },
        data: JSON.parse(JSON.stringify(n.data ?? {})),
        ...(n.style ? { style: JSON.parse(JSON.stringify(n.style)) } : {}),
        ...(n.parentId ? { parentId: n.parentId } : {}),
      }));

      set({ clipboard: cloned });
    },

    pasteNodes: (flowPosition) => {
      get().dispatch({ type: 'PASTE_NODES', flowPosition });
    },

    canUndo: false,
    canRedo: false,

    undo: () => {
      const { nodes, edges, canvasId } = get();
      const snapshot = canvasHistoryManager.undo(nodes, edges);
      if (!snapshot) return;

      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      });

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        triggerIngestion,
      );
    },

    redo: () => {
      const { nodes, edges, canvasId } = get();
      const snapshot = canvasHistoryManager.redo(nodes, edges);
      if (!snapshot) return;

      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      });

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        triggerIngestion,
      );
    },
  })),
);

/**
 * Flush all pending changes when the page is about to be unloaded.
 * Uses keepalive:true so requests survive page close/refresh.
 *
 * 1. Cancel all pending ingestion debounce timers.
 * 2. Fire upsertNode (keepalive) for every node that was still queued.
 * 3. Fire putCanvas (keepalive) with the latest canvas state.
 */
function flushOnUnload(): void {
  const state = useCanvasStore.getState();

  // Collect node IDs that had a pending debounce timer before clearing them.
  const pendingNodeIds = Array.from(ingestionTimers.keys());
  for (const timer of ingestionTimers.values()) {
    clearTimeout(timer);
  }
  ingestionTimers.clear();

  const { canvasId, nodes, edges, version, workspaceName, storageConfig } =
    state;

  // Fire upsertNode with keepalive for every queued node.
  for (const nodeId of pendingNodeIds) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || !needsIngestion(node.type ?? '')) continue;

    const nodeData = node.data as Record<string, unknown> | undefined;
    const nodeType = node.type as 'note' | 'text' | 'web' | 'pdf';

    void upsertNode(
      canvasId,
      nodeId,
      {
        type: nodeType,
        title: (nodeData?.label as string) || undefined,
        content: (nodeData?.content as string) || undefined,
        src: (nodeData?.src as string) || undefined,
        sourceId: (nodeData?.sourceId as string) || undefined,
      },
      { keepalive: true },
    ).catch(() => {
      // Best-effort on unload – ignore errors.
    });
  }

  // Flush canvas save.
  void putCanvas(
    canvasId,
    { version, state: { nodes, edges, workspaceName, storageConfig } },
    { keepalive: true },
  ).catch(() => {
    // Best-effort on unload – ignore errors.
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushOnUnload);
}

export default useCanvasStore;
