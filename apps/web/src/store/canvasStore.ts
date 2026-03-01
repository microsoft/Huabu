import { createId, type KnowledgeStorageConfig } from '@sediment/shared';
import {
  addEdge,
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

import { getCanvas, putCanvas, upsertNode, deleteNode } from '../api';
import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  frameNodes,
  frameNodesInRect,
  toggleFrameLock,
  unframe,
  moveNodeIntoFrame,
  moveNodeOutOfFrame,
  normalizeTreeOrder,
  type NestableNode,
} from '../utils/frameHelper';
import {
  ingestNodeIfNeeded,
  needsIngestion,
  shouldIngestOnUpdate,
  type NodeIngestionInfo,
} from '../utils/ingestHelper';
import { generateNextLabel } from '../utils/nodeLabels';

const CANVAS_ID = 'default-canvas';
const AUTOSAVE_DEBOUNCE_MS = 1000;
const INGESTION_DEBOUNCE_MS = 1000;
const DEFAULT_WORKSPACE_NAME = 'Sediment Workspace Name';
const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Undo / Redo history
// ---------------------------------------------------------------------------

/** Snapshot of the canvas for undo / redo.
 *  Contains nodes and edges with ReactFlow internals
 *  (`selected`, `dragging`, `measured`, `internals`) stripped out. */
type CanvasSnapshot = {
  nodes: Node[];
  edges: Edge[];
};

// Module-level stacks – kept outside zustand state so that pushing/popping
// doesn't trigger subscriber notifications or autosave by itself.
const undoStack: CanvasSnapshot[] = [];
const redoStack: CanvasSnapshot[] = [];

/** Snapshot nodes/edges for undo, stripping only ReactFlow transient internals
 *  (selected, dragging, measured, internals) while preserving all other props
 *  (draggable, zIndex, extent, etc.) that are actively managed by the app.
 *  No deep-clone needed – all store updates follow immutable patterns. */
function createSnapshot(nodes: Node[], edges: Edge[]): CanvasSnapshot {
  return {
    nodes: nodes.map(
      ({ selected: _, dragging: _d, measured: _m, internals: _i, ...rest }) =>
        rest,
    ),
    edges: edges.map(({ selected: _, ...rest }) => rest),
  };
}

/**
 * Shallow-compare two snapshots by JSON-stringifying each node/edge.
 * This is intentionally lightweight: the snapshots are already stripped of
 * transient internals, so we only compare the fields that matter for undo.
 */
function snapshotsEqual(a: CanvasSnapshot, b: CanvasSnapshot): boolean {
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length)
    return false;
  for (let i = 0; i < a.nodes.length; i++) {
    if (JSON.stringify(a.nodes[i]) !== JSON.stringify(b.nodes[i])) return false;
  }
  for (let i = 0; i < a.edges.length; i++) {
    if (JSON.stringify(a.edges[i]) !== JSON.stringify(b.edges[i])) return false;
  }
  return true;
}

/** Record the current canvas state to the undo stack.
 *  Skipped when the stripped snapshot content is identical to the last pushed
 *  snapshot.  This prevents selection-only changes (which replace the nodes
 *  array reference but leave positions/data untouched) from filling the undo
 *  stack with duplicate entries. */
function takeSnapshot(): void {
  const { nodes, edges } = useCanvasStore.getState();
  const candidate = createSnapshot(nodes, edges);

  // Compare against the top of the undo stack after stripping internals,
  // rather than relying on array reference equality which breaks on
  // selection / other UI-only updates.
  const top = undoStack[undoStack.length - 1];
  if (top && snapshotsEqual(top, candidate)) return;

  undoStack.push(candidate);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;

  useCanvasStore.setState({
    canUndo: undoStack.length > 0,
    canRedo: false,
  });
}

function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;

  useCanvasStore.setState({ canUndo: false, canRedo: false });
}

/**
 * After an undo/redo restores a snapshot, sync the server-side state:
 * - Nodes that reappear (present in restored but absent in previous) are
 *   re-ingested via triggerIngestion so the knowledge store is repopulated.
 * - Nodes that disappear (present in previous but absent in restored) are
 *   deleted from the server via deleteNode.
 */
function syncServerAfterRestore(
  canvasId: string,
  prevNodes: Node[],
  restoredNodes: Node[],
): void {
  const prevIds = new Set(prevNodes.map((n) => n.id));
  const restoredIds = new Set(restoredNodes.map((n) => n.id));

  // Nodes that reappear after undo/redo – abort any in-flight DELETE
  // first, then re-ingest them so the server-side knowledge store
  // is repopulated.
  for (const node of restoredNodes) {
    if (!prevIds.has(node.id)) {
      // Cancel stale DELETE that may still be in flight
      const controller = inflightDeletes.get(node.id);
      if (controller) {
        controller.abort();
        inflightDeletes.delete(node.id);
      }
      triggerIngestion(node);
    }
  }

  // Nodes that disappear after undo/redo – delete from server
  // (also tracked with AbortController so a subsequent redo can cancel)
  for (const node of prevNodes) {
    if (!restoredIds.has(node.id)) {
      inflightDeletes.get(node.id)?.abort();

      const controller = new AbortController();
      inflightDeletes.set(node.id, controller);

      void deleteNode(canvasId, node.id, { signal: controller.signal })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError')
            return;
          console.error(
            'Failed to delete node after undo/redo:',
            node.id,
            error,
          );
        })
        .finally(() => {
          if (inflightDeletes.get(node.id) === controller) {
            inflightDeletes.delete(node.id);
          }
        });
    }
  }
}

// Per-node debounce timers for resize – NodeResizer fires onResize continuously;
// we only want to snapshot once per resize gesture per node.
const resizeSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Track in-flight DELETE requests per node so they can be aborted on undo.
const inflightDeletes = new Map<string, AbortController>();

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
      updateNodeDataLocal: state.updateNodeDataLocal,
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

  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  updateNodeDataLocal: (nodeId: string, patch: Record<string, unknown>) => void;

  setSelectedNodes: (ids: string[], multiSelect?: boolean) => void;

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

  resizeNode: (nodeId: string, width: number, height: number) => void;

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
 * Middleware that automatically schedules a canvas save whenever a persisted
 * field (nodes, edges, workspaceName, storageConfig) changes.
 * Skipped while `isLoading` is true to avoid triggering a save during a load.
 */
const autoSaveMiddleware =
  (config: StateCreator<RFState>): StateCreator<RFState> =>
  (set, get, api) => {
    // Shared logic: diff persisted keys after a state update and schedule
    // an autosave when any of them changed.
    const diffAndSchedule = (prev: RFState) => {
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
      diffAndSchedule(prev);
    };

    // Also wrap `api.setState` so that external callers
    // (e.g. useCanvasStore.setState()) trigger autosave as well.
    const originalSetState = api.setState;
    api.setState = (...args) => {
      const prev = get();
      (originalSetState as (...a: typeof args) => void)(...args);
      diffAndSchedule(prev);
    };

    return config(wrappedSet, get, api);
  };

/**
 * Return a new nodes array where only the nodes whose id is in `selectedIds`
 * are marked selected; all other nodes are deselected.
 */
function selectOnly(nodes: Node[], selectedIds: Iterable<string>): Node[] {
  const ids = new Set(selectedIds);
  return nodes.map((n) => ({ ...n, selected: ids.has(n.id) }));
}

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
    openExpanded: (nodeId) => set({ expandedNodeId: nodeId }),
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

    loadCanvas: async () => {
      set({ isLoading: true });
      try {
        const { canvasId } = get();
        const response = await getCanvas(canvasId);
        if (!response) {
          console.warn('Canvas not found, using empty state');
          set({ isLoading: false, ingestionByNodeId: {} });
          clearHistory();
          return;
        }

        const state = response.state as {
          nodes?: Node[];
          edges?: Edge[];
          workspaceName?: string;
          storageConfig?: KnowledgeStorageConfig;
        };
        set({
          nodes: state.nodes ?? [],
          edges: state.edges ?? [],
          workspaceName: state.workspaceName ?? get().workspaceName,
          storageConfig: state.storageConfig ?? get().storageConfig,
          version: response.version,
          isLoading: false,
          ingestionByNodeId: {},
        });
        clearHistory();
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
      takeSnapshot();
    },

    onNodeDragStop: (_event, _node, draggedNodes) => {
      // After drag ends, auto-frame / unframe based on overlap.
      const { nodes } = get();
      let result = nodes as NestableNode[];
      for (const dragged of draggedNodes) {
        result = autoUnframeNodeByNonOverlap(result, dragged.id, {
          epsilon: 0,
        });
        result = autoFrameNodeByOverlap(result, dragged.id, {
          threshold: 0.75,
        });
      }
      if (result !== nodes) {
        set({ nodes: result });
      }
    },

    onNodesChange: (changes) => {
      const hasRemoves = changes.some((c) => c.type === 'remove');

      if (hasRemoves) {
        takeSnapshot();
      }

      const prevNodes = get().nodes as NestableNode[];
      let result = applyNodeChanges(changes, prevNodes) as NestableNode[];

      // Disallow adding nodes through ReactFlow change events.
      // Node additions must go through the store's addNode() API.
      const prevIds = new Set(prevNodes.map((n) => n.id));
      const addedNodes = result.filter((n) => !prevIds.has(n.id));
      if (addedNodes.length > 0) {
        console.error(
          '[canvasStore] Blocked node additions via onNodesChange. Use addNode() instead.',
          addedNodes.map((n) => ({ id: n.id, type: n.type })),
        );
        result = result.filter((n) => prevIds.has(n.id));
      }

      // Handle node deletion - call delete API
      const removedIds = changes
        .filter((c) => c.type === 'remove')
        .map((c) => c.id);

      if (removedIds.length > 0) {
        const { canvasId } = get();
        // Fire-and-forget deletions with AbortController so undo can cancel them
        for (const nodeId of removedIds) {
          // Abort any previous in-flight delete for this node
          inflightDeletes.get(nodeId)?.abort();

          const controller = new AbortController();
          inflightDeletes.set(nodeId, controller);

          void deleteNode(canvasId, nodeId, { signal: controller.signal })
            .catch((error) => {
              // Ignore AbortError – it means undo cancelled the request
              if (error instanceof DOMException && error.name === 'AbortError')
                return;
              console.error('Failed to delete node:', nodeId, error);
            })
            .finally(() => {
              // Clean up only if this is still the active controller
              if (inflightDeletes.get(nodeId) === controller) {
                inflightDeletes.delete(nodeId);
              }
            });
        }
      }

      set((state) => {
        if (removedIds.length === 0) return { nodes: result };
        const nextIngestionByNodeId = { ...state.ingestionByNodeId };
        for (const nodeId of removedIds) {
          delete nextIngestionByNodeId[nodeId];
        }
        return { nodes: result, ingestionByNodeId: nextIngestionByNodeId };
      });
    },

    onEdgesChange: (changes) => {
      const hasRemoves = changes.some((c) => c.type === 'remove');
      if (hasRemoves) {
        takeSnapshot();
      }
      set({
        edges: applyEdgeChanges(changes, get().edges),
      });
    },

    onConnect: (connection: Connection) => {
      takeSnapshot();
      set({
        edges: addEdge(connection, get().edges),
      });
    },

    rfInstance: null,
    setRfInstance: (instance) => set({ rfInstance: instance }),

    addNode: (node) => {
      takeSnapshot();
      // Ensure node has a label
      let finalLabel = node.data?.label;

      if (!finalLabel || String(finalLabel).trim() === '') {
        const existingNodes = get().nodes;
        const nodeType = node.type || 'node';
        const existingLabels = existingNodes.map(
          (n) => n.data?.label as string | undefined,
        );

        finalLabel = generateNextLabel(nodeType, existingLabels);
      }

      const newNode = {
        ...node,
        data: {
          ...node.data,
          label: finalLabel,
        },
      };

      set({ nodes: selectOnly([...get().nodes, newNode], [newNode.id]) });

      // Ingest the node if needed
      triggerIngestion(newNode);
    },

    updateNodeData: (nodeId, patch) => {
      if (!nodeId) return;

      let updatedNode: Node | undefined;
      let previousNode: Node | undefined;

      set({
        nodes: get().nodes.map((n) => {
          if (n.id !== nodeId) return n;
          previousNode = n;
          const updated = {
            ...n,
            data: {
              ...(n.data ?? {}),
              ...patch,
            },
          };
          updatedNode = updated;
          return updated;
        }),
      });

      // Ingest the updated node if needed
      if (updatedNode && previousNode) {
        if (!shouldIngestOnUpdate(previousNode, updatedNode)) {
          return;
        }
        triggerIngestion(updatedNode);
      }
    },

    updateNodeDataLocal: (nodeId, patch) => {
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

    setSelectedNodes: (ids, multiSelect = false) => {
      set((state) => ({
        nodes: state.nodes.map((node) => {
          if (multiSelect) {
            const isTarget = ids.includes(node.id);
            return isTarget ? { ...node, selected: !node.selected } : node;
          }
          return {
            ...node,
            selected: ids.includes(node.id),
          };
        }),
      }));
    },

    reorderNodes: (activeId: string, overId: string) => {
      const { nodes } = get();
      const oldIndex = nodes.findIndex((n) => n.id === activeId);
      const newIndex = nodes.findIndex((n) => n.id === overId);

      if (oldIndex !== -1 && newIndex !== -1) {
        takeSnapshot();
        const newNodes = [...nodes];
        const [movedItem] = newNodes.splice(oldIndex, 1);
        newNodes.splice(newIndex, 0, movedItem);

        // Ensure parent nodes are always before their children
        // This prevents "parent node not found" errors in React Flow
        const normalizedNodes = normalizeTreeOrder(newNodes as NestableNode[]);
        set({ nodes: normalizedNodes });
      }
    },

    sendSelectedToOrder: (direction) => {
      const { nodes } = get();
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;

      takeSnapshot();
      const selectedIds = new Set(selected.map((n) => n.id));
      const rest = nodes.filter((n) => !selectedIds.has(n.id));

      // 'top' = render on top (end of array), 'bottom' = render behind (start of array)
      const reordered =
        direction === 'top' ? [...rest, ...selected] : [...selected, ...rest];

      const normalizedNodes = normalizeTreeOrder(reordered as NestableNode[]);
      set({ nodes: normalizedNodes });
    },

    frameSelectedNodes: () => {
      const { nodes } = get();
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      if (selectedIds.length < 2) return;

      takeSnapshot();
      const frameId = createId('node');
      const result = frameNodes(nodes as NestableNode[], selectedIds, {
        frameId,
        label: 'Frame',
      });

      set({ nodes: selectOnly(result.nodes, [frameId]) });
    },

    frameNodesInRect: (flowRect) => {
      takeSnapshot();
      const { nodes } = get();
      const frameId = createId('node');
      const result = frameNodesInRect(
        nodes as NestableNode[],
        flowRect,
        frameId,
      );
      set({ nodes: selectOnly(result.nodes, [frameId]) });
    },

    unframe: (frameId) => {
      takeSnapshot();
      const { nodes, edges } = get();
      const result = unframe(nodes as NestableNode[], edges, frameId);
      set({ nodes: result.nodes, edges: result.edges });
    },

    toggleFrameLock: (frameId) => {
      takeSnapshot();
      const { nodes } = get();

      set({ nodes: toggleFrameLock(nodes as NestableNode[], frameId) });
    },

    resizeNode: (nodeId, width, height) => {
      // Snapshot once per resize gesture per node: the first event for a
      // given node captures the pre-resize state; subsequent events within
      // 500 ms extend the timer so no duplicate snapshots are created
      // during continuous dragging.
      const existingTimer = resizeSnapshotTimers.get(nodeId);
      if (!existingTimer) {
        takeSnapshot();
      } else {
        clearTimeout(existingTimer);
      }
      resizeSnapshotTimers.set(
        nodeId,
        setTimeout(() => {
          resizeSnapshotTimers.delete(nodeId);
        }, 500),
      );
      set({
        nodes: get().nodes.map((n) =>
          n.id === nodeId ? { ...n, style: { ...n.style, width, height } } : n,
        ),
      });
    },

    moveNodeIntoFrame: (nodeId, frameId) => {
      takeSnapshot();
      const { nodes } = get();
      const result = moveNodeIntoFrame(
        nodes as NestableNode[],
        nodeId,
        frameId,
      );
      set({ nodes: result });
    },

    moveNodeOutOfFrame: (nodeId) => {
      takeSnapshot();
      const { nodes } = get();
      const result = moveNodeOutOfFrame(nodes as NestableNode[], nodeId);
      set({ nodes: result });
    },

    clipboard: [],

    copySelectedNodes: () => {
      const { nodes } = get();
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;

      // Extract only serialisable properties to avoid structuredClone failures
      // on ReactFlow internal properties (measured, internals, etc.)
      const cloned: Node[] = selected.map((n) => ({
        id: n.id,
        type: n.type,
        position: { x: n.position.x, y: n.position.y },
        data: JSON.parse(JSON.stringify(n.data ?? {})),
        ...(n.style ? { style: JSON.parse(JSON.stringify(n.style)) } : {}),
        ...(n.parentId ? { parentId: n.parentId } : {}),
      }));

      console.log('Copied nodes to clipboard:', cloned);

      set({ clipboard: cloned });
    },

    pasteNodes: (flowPosition) => {
      const { clipboard, nodes } = get();
      if (clipboard.length === 0) return;

      takeSnapshot();

      // Compute the offset to apply to each pasted node.
      // If a flow-space position is provided, centre the pasted group there;
      // otherwise fall back to a small fixed offset from the originals.
      let offsetX: number;
      let offsetY: number;

      if (flowPosition) {
        // Calculate the bounding-box centre of the copied nodes
        const xs = clipboard.map((n) => n.position.x);
        const ys = clipboard.map((n) => n.position.y);
        const widths = clipboard.map(
          (n) => (n.style?.width as number) ?? n.measured?.width ?? 200,
        );
        const heights = clipboard.map(
          (n) => (n.style?.height as number) ?? n.measured?.height ?? 150,
        );

        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs.map((x, i) => x + widths[i]));
        const maxY = Math.max(...ys.map((y, i) => y + heights[i]));

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        offsetX = flowPosition.x - centerX;
        offsetY = flowPosition.y - centerY;
      } else {
        const OFFSET = 40;
        offsetX = OFFSET;
        offsetY = OFFSET;
      }

      // Build old-id → new-id map so we can remap parentId refs
      const idMap = new Map<string, string>();
      for (const node of clipboard) {
        idMap.set(node.id, createId('node'));
      }

      const existingLabels = nodes.map(
        (n) => n.data?.label as string | undefined,
      );

      const newNodes: Node[] = clipboard.map((node) => {
        const newId = idMap.get(node.id) ?? createId('node');
        const nodeType = node.type || 'node';
        const label = generateNextLabel(nodeType, existingLabels);
        // Track new label to avoid duplicates within the batch
        existingLabels.push(label);

        const cloned: Node = {
          id: newId,
          type: node.type,
          position: {
            x: node.position.x + offsetX,
            y: node.position.y + offsetY,
          },
          data: {
            ...JSON.parse(JSON.stringify(node.data ?? {})),
            label,
          },
          ...(node.style
            ? { style: JSON.parse(JSON.stringify(node.style)) }
            : {}),
        };

        // Remap parentId if the parent was also copied
        if (node.parentId && idMap.has(node.parentId)) {
          cloned.parentId = idMap.get(node.parentId);
        }

        return cloned;
      });

      // Deselect all existing nodes, then select only pasted ones
      set({
        nodes: selectOnly(
          [...nodes, ...newNodes],
          newNodes.map((n) => n.id),
        ),
      });

      // Trigger ingestion for each pasted node
      for (const node of newNodes) {
        triggerIngestion(node);
      }
    },

    canUndo: false,
    canRedo: false,

    undo: () => {
      const snapshot = undoStack.pop();
      if (!snapshot) return;
      const { nodes, edges, canvasId } = get();

      redoStack.push(createSnapshot(nodes, edges));

      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        canUndo: undoStack.length > 0,
        canRedo: true,
      });

      // Sync server-side state after restoring the snapshot.
      syncServerAfterRestore(canvasId, nodes, snapshot.nodes);
    },

    redo: () => {
      const snapshot = redoStack.pop();
      if (!snapshot) return;
      const { nodes, edges, canvasId } = get();

      undoStack.push(createSnapshot(nodes, edges));

      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        canUndo: true,
        canRedo: redoStack.length > 0,
      });

      // Sync server-side state after restoring the snapshot.
      syncServerAfterRestore(canvasId, nodes, snapshot.nodes);
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
