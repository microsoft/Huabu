import {
  type AgentBaseContext,
  type CanvasCommand,
  type CanvasCommandType,
  type CanvasExecution,
  type CanvasExecutionSource,
  type CanvasNodeType,
  type NodeSummary,
  type RecentAction,
  type SelectedNodeDetail,
  buildSpatialSummary,
  type SpatialNode,
} from '@sediment/shared';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type EdgeRemoveChange,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type OnNodeDrag,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react';
import { create, type StateCreator } from 'zustand';

import { COMMAND_META } from '@/handler/canvasCommand/commands';
import { executeCanvasCommands } from '@/handler/canvasCommand/executor';
import { runPostEffects } from '@/handler/canvasCommand/postEffects';
import {
  preprocessNodeIfNeeded,
  needsPreprocessing,
  type NodeIngestionInfo,
} from '@/handler/canvasCommand/preprocess';
import {
  resolveUiIntent,
  type AddNodeInput,
  type CanvasUiIntent,
  type UiResolverState,
} from '@/handler/canvasCommand/uiIntent';
import {
  extractNodeRef,
  extractSnippet,
  pushAction,
} from '@/handler/canvasCommand/utils';
import { type AlignDirection } from '@/handler/canvasCommand/utils/alignment';
import {
  computeFrameFit,
  getAbsolutePosition as getFrameAbsolutePosition,
  wouldUnframe,
  wouldAutoFrame,
  type FrameFitResult,
  type NestableNode,
} from '@/handler/canvasCommand/utils/frame';

import { canvasHistoryManager } from './canvasHistoryManager';
import { getCanvas, preprocessNode, putCanvas } from '../api';
import { getNodeSize } from '../utils/node/size';

const AUTOSAVE_DEBOUNCE_MS = 1000;
const PREPROCESS_DEBOUNCE_MS = 1000;

/**
 * Flush pending autosave immediately (synchronous cancel + fire).
 * Used before switching canvases to avoid losing edits.
 */
const flushAutoSave = async (saveCanvas: () => Promise<void>) => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    await saveCanvas();
  }
};

// Per-node debounce timers so rapid edits only fire one preprocessing request
// after the user stops typing, rather than on every keystroke.
const preprocessTimers = new Map<string, ReturnType<typeof setTimeout>>();

const triggerPreprocessing = (node: Node) => {
  const nodeId = node.id;
  const existing = preprocessTimers.get(nodeId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    preprocessTimers.delete(nodeId);
    const state = useCanvasStore.getState();
    // Re-fetch the latest node so we send the most up-to-date content.
    const latestNode = state.nodes.find((n) => n.id === nodeId) ?? node;
    void preprocessNodeIfNeeded({
      canvasId: state.canvasId,
      node: latestNode,
      setNodeIngestion: state.setNodeIngestion,
      clearNodeIngestion: state.clearNodeIngestion,
      getChildNodes: (frameId) =>
        state.nodes.filter((n) => n.parentId === frameId),
      patchNodeSilent: state.patchNodeSilent,
    });
  }, PREPROCESS_DEBOUNCE_MS);

  preprocessTimers.set(nodeId, timer);
};

// ── Spatial cache ──────────────────────────────────────────────
// Module-level cache keyed by a lightweight fingerprint of
// node positions + edge endpoints.  Avoids re-running the O(n²)
// clustering in buildSpatialSummary on every getAgentContext call
// when the canvas hasn't changed.

interface SpatialCache {
  fingerprint: number;
  spatialNodes: SpatialNode[];
  summary: ReturnType<typeof buildSpatialSummary>;
}

let _spatialCache: SpatialCache | null = null;

/** FNV-1a 32-bit hash — fast, non-cryptographic, good distribution. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/** Build a fast fingerprint from positions + edges for cache invalidation. */
function spatialFingerprint(nodes: Node[], edges: Edge[]): number {
  const parts: string[] = [String(nodes.length)];
  for (const n of nodes) {
    const sz = getNodeSize(n);
    parts.push(
      `${n.id}:${n.position.x},${n.position.y},${sz.width},${sz.height}`,
    );
  }
  parts.push(String(edges.length));
  for (const e of edges) {
    parts.push(`${e.source}>${e.target}`);
  }
  return fnv1a(parts.join('|'));
}

function resolveAbsolutePosition(
  node: Node,
  byId: Map<string, Node>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  while (cur) {
    x += cur.position.x;
    y += cur.position.y;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return { x, y };
}

function toSpatialNodes(nodes: Node[]): SpatialNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((n) => {
    const sz = getNodeSize(n);
    const abs = resolveAbsolutePosition(n, byId);
    return {
      id: n.id,
      rect: {
        x: abs.x,
        y: abs.y,
        width: sz.width || 200,
        height: sz.height || 100,
      },
      type: n.type,
      parentId: n.parentId ?? null,
      label: (n.data as Record<string, unknown>)?.label as string | undefined,
    };
  });
}

/**
 * Get (or compute) cached spatial nodes + summary for the current canvas.
 * Safe to call from anywhere (components, handlers).
 */
export function getCachedSpatialData(): {
  spatialNodes: SpatialNode[];
  summary: ReturnType<typeof buildSpatialSummary>;
} {
  const { nodes, edges } = useCanvasStore.getState();
  const fp = spatialFingerprint(nodes, edges);
  if (_spatialCache && _spatialCache.fingerprint === fp) {
    return {
      spatialNodes: _spatialCache.spatialNodes,
      summary: _spatialCache.summary,
    };
  }
  const spatialNodes = toSpatialNodes(nodes);
  const edgeList = edges.map((e) => ({ source: e.source, target: e.target }));
  const summary = buildSpatialSummary(spatialNodes, edgeList);
  _spatialCache = { fingerprint: fp, spatialNodes, summary };
  return { spatialNodes, summary };
}

type RFState = {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  version: number;
  isLoading: boolean;
  canvasNotFound: boolean;
  isSaving: boolean;
  pendingSave: boolean;

  canvasTitle: string;
  setCanvasTitle: (title: string) => void;

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
  onNodeDrag: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;

  /**
   * Previews of how frames would resize based on the current drag/resize.
   * One entry per affected frame — allows showing both the source frame
   * shrinking and the target frame expanding simultaneously.
   * Computed in `onNodeDrag`, rendered as dashed overlays,
   * and cleared in `onNodeDragStop`.
   */
  frameFitPreviews: FrameFitResult[];
  /**
   * Update the frame fit preview while a child node is being resized.
   * Called on every resize tick from NodeWrapper so the dashed overlay
   * stays in sync with the handle. Respects `autoLayoutEnabled`.
   */
  updateResizePreview: (nodeId: string) => void;
  /** Clear the frame fit previews (e.g. when resize ends). */
  clearFrameFitPreview: () => void;

  addNodes: (inputs: AddNodeInput[]) => void;
  addNode: (input: AddNodeInput) => void;
  deleteNodes: (nodeIds: string[]) => void;
  disconnectEdges: (edgeIds: string[]) => void;
  setNodeGeometry: (
    items: Array<{
      nodeId: string;
      size?: { width: number; height: number };
      position?: { x: number; y: number };
    }>,
  ) => void;
  /** Take a pre-resize snapshot so the final SET_NODE_GEOMETRY can be undone. */
  onNodeResizeStart: () => void;
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

  reorderNodes: (
    activeId: string,
    overId: string,
    position?: 'before' | 'after',
  ) => void;
  sendSelectedToOrder: (direction: 'top' | 'bottom') => void;

  frameSelectedNodes: () => void;
  frameNodesInRect: (flowRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  unframe: (frameId: string) => void;
  toggleNodeLock: (nodeId: string) => void;

  /**
   * @internal Signal the start of a continuous gesture (drag, resize) that will
   * end with a command of the given type. If `COMMAND_META[commandType]`
   * has `snapshot: 'caller'`, an undo snapshot is taken now so the
   * entire gesture collapses into a single undo entry.
   * Use `onNodeDragStart` / `onNodeResizeStart` instead of calling directly.
   */
  beginGesture: (commandType: CanvasCommandType) => void;

  /** Align selected nodes along an axis. */
  alignSelectedNodes: (direction: AlignDirection) => void;
  /** Spread apart overlapping selected nodes (frame children stay in their frame). */
  spreadSelectedNodes: () => void;

  /** Auto-layout: whether new nodes are automatically placed. */
  autoLayoutEnabled: boolean;
  toggleAutoLayout: () => void;
  /** Full re-layout of all nodes (user-triggered). */
  layoutAll: () => void;
  /** Re-layout children of a specific frame. */
  layoutGroup: (frameId: string) => void;

  moveNodeIntoFrame: (
    nodeId: string,
    frameId: string,
    reorderTarget?: { nodeId: string; position: 'before' | 'after' },
  ) => void;
  moveNodeOutOfFrame: (
    nodeId: string,
    reorderTarget?: { nodeId: string; position: 'before' | 'after' },
  ) => void;

  /** The node type awaiting placement on canvas via click. */
  pendingNodeType: 'note' | 'text' | 'frame' | 'prompt' | null;
  setPendingNodeType: (
    type: 'note' | 'text' | 'frame' | 'prompt' | null,
  ) => void;

  copySelectedNodes: () => void;
  pasteNodes: (
    flowPosition: { x: number; y: number },
    clipboardNodes: Node[],
  ) => void;

  /** Undo / Redo */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  loadCanvas: (canvasId?: string) => Promise<void>;
  switchCanvas: (canvasId: string) => Promise<void>;
  saveCanvas: () => Promise<void>;

  actionHistory: RecentAction[];
  /** @internal Execute a batch of shared CanvasCommands. Do not call from outside the store. */
  executeCommands: (
    commands: CanvasCommand[],
    source?: CanvasExecutionSource,
  ) => void;
  /** @internal Resolve a web-only UiIntent and execute the resulting commands. */
  dispatchUiIntent: (intent: CanvasUiIntent) => void;
  getAgentContext: () => AgentBaseContext;
};

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

const scheduleAutoSave = (saveCanvas: () => Promise<void>) => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveCanvas();
  }, AUTOSAVE_DEBOUNCE_MS);
};

const PERSISTED_KEYS = ['nodes', 'edges', 'canvasTitle'] as const;
type PersistedKey = (typeof PERSISTED_KEYS)[number];

/**
 * Middleware that:
 * 1. Automatically schedules a canvas save whenever a persisted field
 *    (nodes, edges, canvasTitle) changes.
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

// rAF handle for throttling the heavy preview computation inside onNodeDrag.
// Keeping it outside the store avoids stale-closure issues and lets
// onNodeDragStop cancel any pending frame reliably.
let _dragPreviewRafId: number | null = null;

const useCanvasStore = create<RFState>()(
  autoSaveMiddleware((set, get) => ({
    nodes: [],
    edges: [],
    canvasId: '',
    version: 0,
    isLoading: false,
    canvasNotFound: false,
    isSaving: false,
    pendingSave: false,

    canvasTitle: '',
    setCanvasTitle: (title) => {
      set({ canvasTitle: title });
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
    expandMode: 'split',
    openExpanded: (nodeId) =>
      get().dispatchUiIntent({ type: 'EXPAND_NODE', nodeId }),
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

    // --- Internal: not exposed in the public CanvasStore interface ---

    /** Execute a batch of shared CanvasCommands. Source defaults to 'ui'. */
    executeCommands: (commands, source) => {
      const execution: CanvasExecution = {
        source: source ?? 'ui',
        commands,
      };
      const state = {
        nodes: get().nodes,
        edges: get().edges,
        canvasId: get().canvasId,
        autoLayoutEnabled: get().autoLayoutEnabled,
      };

      const { writeResult, commandResults, pendingEffects } =
        executeCanvasCommands(execution, state);

      // Only commit if at least one command was applied.
      if (!commandResults.some((r) => r.applied)) return;

      // Guard: verify that 'caller' snapshot commands were preceded by beginGesture.
      // Skip for agent-originated commands (no UI gesture involved).
      const hasCallerSnapshot = commands.some(
        (c) => COMMAND_META[c.type].snapshot === 'caller',
      );
      if (hasCallerSnapshot && (source ?? 'ui') !== 'agent') {
        if (!canvasHistoryManager.gestureSnapshotTaken) {
          console.warn(
            '[canvasStore] snapshot:"caller" command executed without beginGesture():',
            commands.map((c) => c.type).join(', '),
          );
        }
        canvasHistoryManager.consumeGestureSnapshot();
      }

      // Take undo snapshot if needed (before committing new state).
      if (writeResult.snapshotNeeded) {
        canvasHistoryManager.takeSnapshot(state.nodes, state.edges);
      }

      // Commit new state.
      const updates: Partial<RFState> = {
        nodes: writeResult.nodes,
        edges: writeResult.edges,
      };

      if (writeResult.expandedNodeId !== undefined) {
        updates.expandedNodeId = writeResult.expandedNodeId;
      }

      set(updates);

      // Run post-commit side effects (edge reroute, ingestion, label resolve, delete tracking).
      runPostEffects(
        pendingEffects,
        { triggerPreprocessing },
        writeResult.requiresEdgeReroute,
        state.canvasId,
        () => ({ nodes: get().nodes, edges: get().edges }),
        (partial) => set(partial),
      );
    },

    /** Resolve a web-only UiIntent and execute the resulting commands. */
    dispatchUiIntent: (intent) => {
      const uiState: UiResolverState = {
        nodes: get().nodes,
        edges: get().edges,
        autoLayoutEnabled: get().autoLayoutEnabled,
      };
      const execution = resolveUiIntent(intent, uiState);
      if (execution.commands.length > 0) {
        get().executeCommands(execution.commands);
      }
      // Push trace from intent resolution to action history.
      if (execution.trace.length > 0) {
        let history = get().actionHistory;
        for (const action of execution.trace) {
          history = pushAction(history, action);
        }
        set({ actionHistory: history });
      }
    },

    getAgentContext: (): AgentBaseContext => {
      const { nodes, edges, actionHistory } = get();
      // Build a lookup map once to avoid O(n²) scans inside edges.map.
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      /**
       * Build a SelectedNodeDetail for a single node.
       * Only sends lightweight metadata — the agent uses get_node_detail
       * or read_source to fetch full content on demand, saving tokens.
       * Image nodes keep `src` so the server can build vision attachments.
       * For frame nodes, recursively include direct children as `children` details
       */
      const buildSelectedDetail = (n: Node): SelectedNodeDetail => {
        const data = n.data as Record<string, unknown> | undefined;
        const nodeType = (n.type ?? 'note') as CanvasNodeType;

        // Only keep src for image nodes (needed for vision analysis)
        const src =
          n.type === 'image' ? (data?.src as string | undefined) : undefined;

        const size = getNodeSize(n);
        const detail: SelectedNodeDetail = {
          id: n.id,
          type: nodeType,
          label: data?.label as string | undefined,
          origin: data?.origin as SelectedNodeDetail['origin'],
          sourceId: data?.sourceId as string | undefined,
          position: { x: n.position.x, y: n.position.y },
          ...(size.width > 0 || size.height > 0
            ? { size: { width: size.width, height: size.height } }
            : {}),
          ...(src !== undefined ? { src } : {}),
        };

        if (n.type === 'frame') {
          const children = nodes
            .filter((child) => child.parentId === n.id)
            .map(buildSelectedDetail);
          if (children.length > 0) detail.children = children;
        }

        return detail;
      };

      return {
        nodes: nodes.map((n): NodeSummary => {
          const size = getNodeSize(n);
          return {
            id: n.id,
            type: (n.type ?? 'note') as CanvasNodeType,
            label: n.data?.label as string | undefined,
            snippet: extractSnippet(n),
            frameLabel: n.parentId
              ? (nodeMap.get(n.parentId)?.data?.label as string | undefined)
              : undefined,
            position: { x: n.position.x, y: n.position.y },
            size:
              size.width > 0 || size.height > 0
                ? { width: size.width, height: size.height }
                : undefined,
          };
        }),
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
        selectedNodes: nodes.filter((n) => n.selected).map(buildSelectedDetail),
        spatialSummary: getCachedSpatialData().summary,
      };
    },

    loadCanvas: async (canvasId?: string) => {
      set({ isLoading: true, canvasNotFound: false });
      try {
        const targetId = canvasId ?? get().canvasId;
        if (canvasId) {
          set({ canvasId: targetId });
        }
        const response = await getCanvas(targetId);
        if (!response) {
          console.warn('Canvas not found:', targetId);
          canvasHistoryManager.clear();
          set({
            isLoading: false,
            canvasNotFound: true,
            ingestionByNodeId: {},
          });
          return;
        }

        const state = response.state as {
          nodes?: Node[];
          edges?: Edge[];
        };
        canvasHistoryManager.clear();

        set({
          nodes: state.nodes ?? [],
          edges: state.edges ?? [],
          canvasTitle: response.title || 'Untitled',
          version: response.version,
          isLoading: false,
          ingestionByNodeId: {},
        });
      } catch (error) {
        console.error('Failed to load canvas:', error);
        set({ isLoading: false });
      }
    },

    switchCanvas: async (canvasId: string) => {
      const currentId = get().canvasId;
      if (canvasId === currentId) return;

      // Flush any pending save for the current canvas before switching
      await flushAutoSave(get().saveCanvas);

      // Cancel all pending preprocessing timers
      for (const timer of preprocessTimers.values()) {
        clearTimeout(timer);
      }
      preprocessTimers.clear();

      // Reset state for clean slate
      set({
        expandedNodeId: null,
        pendingNodeType: null,
        actionHistory: [],
        frameFitPreviews: [],
        collapsedFrameIds: new Set(),
        canvasNotFound: false,
      });
      canvasHistoryManager.clear();

      // Load the new canvas
      await get().loadCanvas(canvasId);
    },

    saveCanvas: async () => {
      const { isSaving } = get();
      if (isSaving) {
        set({ pendingSave: true });
        return;
      }

      set({ isSaving: true });
      try {
        const { nodes, edges, version, canvasId, canvasTitle } = get();
        const response = await putCanvas(canvasId, {
          version,
          title: canvasTitle || 'Untitled',
          state: { nodes, edges },
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
      get().beginGesture('SET_NODE_GEOMETRY');
    },

    onNodeResizeStart: () => {
      get().beginGesture('SET_NODE_GEOMETRY');
    },

    frameFitPreviews: [],

    onNodeDrag: (_event, draggedNode, draggedNodes) => {
      const { autoLayoutEnabled } = get();

      // Frame auto-resize preview only applies when auto-layout is enabled.
      if (!autoLayoutEnabled) {
        set({ frameFitPreviews: [] });
        return;
      }

      // Throttle the heavy preview computation to once per animation frame.
      // Mouse events can fire at 120 Hz+ on high-refresh displays; capping at
      // ~60 fps via rAF avoids redundant work while keeping previews smooth.
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
      }

      _dragPreviewRafId = requestAnimationFrame(() => {
        _dragPreviewRafId = null;

        // Re-read store inside the rAF callback so we always use the
        // latest node positions (ReactFlow may have applied intermediate
        // updates between the event and the rAF tick).
        const { nodes } = get();

        const liveNodes = nodes.map((n) => {
          if (n.id === draggedNode.id)
            return { ...n, position: draggedNode.position };
          const live = draggedNodes.find((d) => d.id === n.id);
          if (live) return { ...n, position: live.position };
          return n;
        }) as NestableNode[];

        // Collect frame IDs that need a preview, and which dragged children
        // would leave each frame (so we exclude them from the fit preview).
        const leavingByFrame = new Map<string, Set<string>>();
        const enteringByFrame = new Map<
          string,
          { x: number; y: number; width: number; height: number }[]
        >();
        const previewFrameIds = new Set<string>();

        for (const dn of draggedNodes) {
          const originalNode = nodes.find((n) => n.id === dn.id);
          if (!originalNode) continue;
          // If the node is currently in a frame, check whether it would unframe.
          if (originalNode.parentId) {
            const parentId = originalNode.parentId;
            previewFrameIds.add(parentId);

            if (wouldUnframe(liveNodes, dn.id, { epsilon: 0, margin: 10 })) {
              let leaving = leavingByFrame.get(parentId);
              if (!leaving) {
                leaving = new Set();
                leavingByFrame.set(parentId, leaving);
              }
              leaving.add(dn.id);
            }
          }

          // Check if the node would enter a different frame (both root and cross-frame).
          // Only show a preview when the 50% overlap threshold is already met so the
          // preview is always consistent with the actual drop behaviour.
          const targetFrameId = wouldAutoFrame(liveNodes, dn.id, {
            threshold: 0.5,
          });
          if (targetFrameId) {
            previewFrameIds.add(targetFrameId);
            // Track the dragged node's absolute rect so the fit preview can
            // include the incoming node in the frame's bounding-box calculation.
            const nodeAbsPos = getFrameAbsolutePosition(liveNodes, dn.id);
            const liveNode = liveNodes.find((n) => n.id === dn.id);
            if (nodeAbsPos && liveNode) {
              const size = getNodeSize(liveNode);
              if (size.width > 0 && size.height > 0) {
                let entering = enteringByFrame.get(targetFrameId);
                if (!entering) {
                  entering = [];
                  enteringByFrame.set(targetFrameId, entering);
                }
                entering.push({
                  x: nodeAbsPos.x,
                  y: nodeAbsPos.y,
                  width: size.width,
                  height: size.height,
                });
              }
            }
          }
        }

        // Compute fit previews for all affected frames and show them all
        // simultaneously — e.g. source frame shrinking + target frame expanding.
        const previews: FrameFitResult[] = [];

        for (const frameId of previewFrameIds) {
          const leaving = leavingByFrame.get(frameId);
          const entering = enteringByFrame.get(frameId);
          const fit = computeFrameFit(liveNodes, frameId, {
            excludeNodeIds: leaving,
            includeAbsoluteRects: entering,
          });
          if (!fit) continue;

          // Convert to absolute coordinates for overlay rendering.
          const frame = liveNodes.find((n) => n.id === frameId);
          if (!frame) continue;

          let absX = fit.position.x;
          let absY = fit.position.y;
          if (frame.parentId) {
            const parentAbsPos = getFrameAbsolutePosition(
              liveNodes,
              frame.parentId,
            );
            if (parentAbsPos) {
              absX += parentAbsPos.x;
              absY += parentAbsPos.y;
            }
          }

          previews.push({
            frameId,
            position: { x: absX, y: absY },
            width: fit.width,
            height: fit.height,
          });
        }

        set({ frameFitPreviews: previews });
      });
    },

    onNodeDragStop: (_event, _node, draggedNodes) => {
      // Cancel any pending preview computation — the drag is over.
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
        _dragPreviewRafId = null;
      }
      set({ frameFitPreviews: [] });
      get().dispatchUiIntent({
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: draggedNodes.map((n) => n.id),
      });
    },

    updateResizePreview: (nodeId: string) => {
      const { nodes, autoLayoutEnabled } = get();
      if (!autoLayoutEnabled) return;
      const node = (nodes as NestableNode[]).find((n) => n.id === nodeId);
      if (!node?.parentId) return;
      const frame = (nodes as NestableNode[]).find(
        (n) => n.id === node.parentId,
      );
      if (!frame || frame.type !== 'frame') return;

      const fit = computeFrameFit(nodes as NestableNode[], node.parentId);
      if (!fit) return;

      let absX = fit.position.x;
      let absY = fit.position.y;
      if (frame.parentId) {
        const parentAbsPos = getFrameAbsolutePosition(
          nodes as NestableNode[],
          frame.parentId,
        );
        if (parentAbsPos) {
          absX += parentAbsPos.x;
          absY += parentAbsPos.y;
        }
      }

      set({
        frameFitPreviews: [
          {
            frameId: node.parentId,
            position: { x: absX, y: absY },
            width: fit.width,
            height: fit.height,
          },
        ],
      });
    },

    clearFrameFitPreview: () => {
      set({ frameFitPreviews: [] });
    },

    onNodesChange: (changes) => {
      // Only process RF-internal change types (position, selection, dimensions).
      // Deletions must go through dispatch({ type: 'DELETE_NODES' }).
      // Additions must go through dispatch({ type: 'ADD_NODES' }).
      const internalChanges = changes.filter(
        (c) => c.type !== 'remove' && c.type !== 'add',
      );
      if (internalChanges.length === 0) return;

      // Strip `setAttributes` from dimension changes so that
      // `node.width`/`node.height` (the top-level properties) are never
      // written by React Flow internals. We use `node.style.width/height`
      // as the single source of truth for explicit sizing; allowing
      // `setAttributes` would cause `node.width` to shadow `style.width`
      // after a resize, making subsequent style-based size updates
      // silently ignored.
      const sanitized = internalChanges.map((c) => {
        if (c.type === 'dimensions' && 'setAttributes' in c) {
          const { setAttributes, ...rest } = c;
          return rest;
        }
        return c;
      });

      set({ nodes: applyNodeChanges(sanitized, get().nodes) });
    },

    onEdgesChange: (changes) => {
      const removes = changes.filter(
        (c): c is EdgeRemoveChange => c.type === 'remove',
      );
      if (removes.length > 0) {
        get().dispatchUiIntent({
          type: 'DISCONNECT_EDGE',
          edgeIds: removes.map((c) => c.id),
        });
      }
      const internalChanges = changes.filter((c) => c.type !== 'remove');
      if (internalChanges.length > 0) {
        set({ edges: applyEdgeChanges(internalChanges, get().edges) });
      }
    },

    onConnect: (connection: Connection) => {
      get().dispatchUiIntent({
        type: 'CONNECT_EDGE',
        source: connection.source,
        target: connection.target,
      });
    },

    rfInstance: null,
    setRfInstance: (instance) => set({ rfInstance: instance }),

    addNodes: (inputs) => {
      get().dispatchUiIntent({
        type: 'ADD_NODES',
        inputs,
      });
    },

    addNode: (input) => {
      get().addNodes([input]);
    },

    deleteNodes: (nodeIds) => {
      get().dispatchUiIntent({ type: 'DELETE_NODES', nodeIds });
    },

    disconnectEdges: (edgeIds) => {
      get().dispatchUiIntent({ type: 'DISCONNECT_EDGE', edgeIds });
    },

    setNodeGeometry: (items) => {
      get().dispatchUiIntent({ type: 'RESIZE_NODE', items });
    },

    updateNodeData: (nodeId, patch) => {
      get().dispatchUiIntent({ type: 'UPDATE_NODE_DATA', nodeId, patch });
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

    selectNodes: (ids, multiSelect = false) => {
      get().dispatchUiIntent({
        type: 'SELECT_NODES',
        nodeIds: ids,
        mode: multiSelect ? 'toggle' : 'replace',
      });
    },

    reorderNodes: (
      activeId: string,
      overId: string,
      position?: 'before' | 'after',
    ) => {
      get().dispatchUiIntent({
        type: 'REORDER_NODE',
        activeId,
        overId,
        position,
      });
    },

    sendSelectedToOrder: (direction) => {
      get().dispatchUiIntent({
        type: 'REORDER_SELECTED_NODES',
        to: direction,
      });
    },

    frameSelectedNodes: () => {
      get().dispatchUiIntent({ type: 'GROUP_SELECTION_INTO_FRAME' });
    },

    frameNodesInRect: (flowRect) => {
      get().dispatchUiIntent({ type: 'GROUP_RECT_INTO_FRAME', flowRect });
    },

    unframe: (frameId) => {
      get().dispatchUiIntent({ type: 'DISSOLVE_FRAME', frameId });
    },

    toggleNodeLock: (nodeId) => {
      get().dispatchUiIntent({ type: 'TOGGLE_NODE_LOCK', nodeId });
    },

    beginGesture: (commandType) => {
      if (COMMAND_META[commandType].snapshot === 'caller') {
        const { nodes, edges } = get();
        canvasHistoryManager.takeSnapshot(nodes, edges);
        canvasHistoryManager.markGestureSnapshot();
      }
    },

    alignSelectedNodes: (direction) => {
      get().dispatchUiIntent({
        type: 'ALIGN_SELECTED_NODES',
        direction,
      });
    },

    spreadSelectedNodes: () => {
      get().dispatchUiIntent({
        type: 'DISTRIBUTE_SELECTED_NODES',
      });
    },

    autoLayoutEnabled: true,
    toggleAutoLayout: () => {
      set({ autoLayoutEnabled: !get().autoLayoutEnabled });
    },
    layoutAll: () => {
      get().dispatchUiIntent({ type: 'LAYOUT_ALL' });
      // Fit view slightly after layout so the animation is already in motion.
      setTimeout(() => {
        get().rfInstance?.fitView({ duration: 300, padding: 0.15 });
      }, 50);
    },
    layoutGroup: (frameId) => {
      get().dispatchUiIntent({ type: 'LAYOUT_GROUP', frameId });
    },

    moveNodeIntoFrame: (nodeId, frameId, reorderTarget) => {
      get().dispatchUiIntent({
        type: 'MOVE_NODE_INTO_FRAME',
        nodeId,
        frameId,
        reorderTarget,
      });
    },

    moveNodeOutOfFrame: (nodeId, reorderTarget) => {
      get().dispatchUiIntent({
        type: 'MOVE_NODE_OUT_OF_FRAME',
        nodeId,
        reorderTarget,
      });
    },

    copySelectedNodes: () => {
      const { nodes } = get();
      const selected = nodes.filter((n) => n.selected);
      if (selected.length === 0) return;

      // When a frame is selected, also include all its descendant nodes
      // so that copying a frame copies the entire group.
      const selectedIds = new Set(selected.map((n) => n.id));
      const collectDescendants = (parentId: string) => {
        for (const n of nodes) {
          if (n.parentId === parentId && !selectedIds.has(n.id)) {
            selectedIds.add(n.id);
            if (n.type === 'frame') collectDescendants(n.id);
          }
        }
      };
      for (const n of selected) {
        if (n.type === 'frame') collectDescendants(n.id);
      }

      const toCopy = nodes.filter((n) => selectedIds.has(n.id));

      // Keep original IDs in the clipboard so the paste helper can remap
      // parent-child relationships onto freshly created node IDs.
      const cloned: Node[] = toCopy.map((n) => {
        const hasCopiedParent = !!(n.parentId && selectedIds.has(n.parentId));
        const absolutePosition = hasCopiedParent
          ? n.position
          : (getFrameAbsolutePosition(nodes as NestableNode[], n.id) ??
            n.position);

        return {
          id: n.id,
          type: n.type,
          position: { x: absolutePosition.x, y: absolutePosition.y },
          data: JSON.parse(JSON.stringify(n.data ?? {})),
          ...(n.style ? { style: JSON.parse(JSON.stringify(n.style)) } : {}),
          ...(hasCopiedParent ? { parentId: n.parentId } : {}),
        };
      });

      // Write serialized node data to system clipboard
      const payload = JSON.stringify({ __sediment_nodes__: cloned });
      void navigator.clipboard.writeText(payload).catch(() => {
        // Clipboard API unavailable
      });
    },

    pasteNodes: (flowPosition, clipboardNodes) => {
      get().dispatchUiIntent({
        type: 'PASTE_CLIPBOARD',
        flowPosition,
        clipboardNodes,
      });
    },

    canUndo: false,
    canRedo: false,

    undo: () => {
      const { nodes, edges, canvasId, actionHistory } = get();
      const snapshot = canvasHistoryManager.undo(nodes, edges);
      if (!snapshot) return;

      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        actionHistory: pushAction(actionHistory, { action: 'canvas_undone' }),
      });

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        triggerPreprocessing,
      );
    },

    redo: () => {
      const { nodes, edges, canvasId, actionHistory } = get();
      const snapshot = canvasHistoryManager.redo(nodes, edges);
      if (!snapshot) return;

      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        actionHistory: pushAction(actionHistory, { action: 'canvas_redone' }),
      });

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        triggerPreprocessing,
      );
    },
  })),
);

/**
 * Flush all pending changes when the page is about to be unloaded.
 * Uses keepalive:true so requests survive page close/refresh.
 *
 * 1. Cancel all pending preprocessing debounce timers.
 * 2. Fire preprocessNode (keepalive) for every node that was still queued.
 * 3. Fire putCanvas (keepalive) with the latest canvas state.
 */
function flushOnUnload(): void {
  const state = useCanvasStore.getState();

  const { canvasId, nodes, edges, version, canvasTitle } = state;

  // Collect node IDs that had a pending debounce timer before clearing them.
  const pendingNodeIds = Array.from(preprocessTimers.keys());
  for (const timer of preprocessTimers.values()) {
    clearTimeout(timer);
  }
  preprocessTimers.clear();

  // Nothing else to flush if no canvas is loaded.
  if (!canvasId) return;

  // Fire preprocessNode with keepalive for every queued node.
  for (const nodeId of pendingNodeIds) {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node || !needsPreprocessing(node.type ?? '')) continue;

    const nodeData = node.data as Record<string, unknown> | undefined;
    const nodeType = node.type ?? '';

    // Build a minimal snapshot matching what preprocessNodeIfNeeded would send.
    const snapshot: Record<string, unknown> =
      nodeType === 'frame'
        ? {
            childLabels: nodes
              .filter((n) => n.parentId === nodeId)
              .map((c) => {
                const cData = c.data as Record<string, unknown> | undefined;
                const label =
                  typeof cData?.label === 'string' ? cData.label : '';
                return label.trim();
              })
              .filter((l) => l.length > 0),
            labelSource: (nodeData?.labelSource as string) || undefined,
          }
        : {
            title:
              (nodeData?.label as string) ||
              (nodeData?.title as string) ||
              undefined,
            labelSource: (nodeData?.labelSource as string) || undefined,
            content: (nodeData?.content as string) || undefined,
            src: (nodeData?.src as string) || undefined,
            sourceId: (nodeData?.sourceId as string) || undefined,
          };

    void preprocessNode(
      canvasId,
      nodeId,
      { nodeType, trigger: 'flush', snapshot },
      { keepalive: true },
    ).catch(() => {
      // Best-effort on unload – ignore errors.
    });
  }

  // Flush canvas save.
  void putCanvas(
    canvasId,
    { version, title: canvasTitle || 'Untitled', state: { nodes, edges } },
    { keepalive: true },
  ).catch(() => {
    // Best-effort on unload – ignore errors.
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushOnUnload);
}

export default useCanvasStore;
