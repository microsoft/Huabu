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
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react';
import { create } from 'zustand';

import { getCanvas, putCanvas, upsertNode, deleteNode } from '../api';
import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  frameNodes,
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
  unframe: (frameId: string) => void;
  toggleFrameLock: (frameId: string) => void;

  moveNodeIntoFrame: (nodeId: string, frameId: string) => void;
  moveNodeOutOfFrame: (nodeId: string) => void;

  /** The node type awaiting placement on canvas via click. */
  pendingNodeType: 'note' | 'text' | 'frame' | null;
  setPendingNodeType: (type: 'note' | 'text' | 'frame' | null) => void;

  /** Clipboard for node copy-paste. */
  clipboard: Node[];
  copySelectedNodes: () => void;
  pasteNodes: (flowPosition?: { x: number; y: number }) => void;

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

const useCanvasStore = create<RFState>((set, get) => ({
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
    scheduleAutoSave(get().saveCanvas);
  },

  storageConfig: { backend: 'sqlite' },
  setStorageConfig: (config) => {
    set({ storageConfig: config });
    scheduleAutoSave(get().saveCanvas);
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
      const { nodes, edges, version, canvasId, workspaceName, storageConfig } =
        get();
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

  onNodesChange: (changes) => {
    const prevNodes = get().nodes as NestableNode[];
    const nextNodes = applyNodeChanges(changes, prevNodes) as NestableNode[];

    const dragStopIds = changes
      .filter((c) => c.type === 'position')
      .filter((c) => {
        const maybe = c as unknown as { dragging?: boolean };
        return maybe.dragging === false;
      })
      .map((c) => c.id);

    let result = nextNodes;
    for (const nodeId of dragStopIds) {
      result = autoUnframeNodeByNonOverlap(result, nodeId, { epsilon: 0 });
      result = autoFrameNodeByOverlap(result, nodeId, { threshold: 0.75 });
    }

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
      // Fire-and-forget deletions
      for (const nodeId of removedIds) {
        void deleteNode(canvasId, nodeId).catch((error) => {
          console.error('Failed to delete node:', nodeId, error);
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

    scheduleAutoSave(get().saveCanvas);
  },

  onEdgesChange: (changes) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });

    scheduleAutoSave(get().saveCanvas);
  },

  onConnect: (connection: Connection) => {
    set({
      edges: addEdge(connection, get().edges),
    });

    scheduleAutoSave(get().saveCanvas);
  },

  rfInstance: null,
  setRfInstance: (instance) => set({ rfInstance: instance }),

  addNode: (node) => {
    // Ensure node has a label
    if (
      !node.data ||
      !node.data.label ||
      String(node.data.label).trim() === ''
    ) {
      const existingNodes = get().nodes;
      const nodeType = node.type || 'node';
      const existingLabels = existingNodes.map(
        (n) => n.data?.label as string | undefined,
      );

      const generatedLabel = generateNextLabel(nodeType, existingLabels);

      // Set the label
      node = {
        ...node,
        data: {
          ...node.data,
          label: generatedLabel,
        },
      };
    }

    set({ nodes: [...get().nodes, node] });

    // Ingest the node if needed
    triggerIngestion(node);

    scheduleAutoSave(get().saveCanvas);
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
        scheduleAutoSave(get().saveCanvas);
        return;
      }
      triggerIngestion(updatedNode);
    }

    scheduleAutoSave(get().saveCanvas);
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

    scheduleAutoSave(get().saveCanvas);
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
      const newNodes = [...nodes];
      const [movedItem] = newNodes.splice(oldIndex, 1);
      newNodes.splice(newIndex, 0, movedItem);

      // Ensure parent nodes are always before their children
      // This prevents "parent node not found" errors in React Flow
      const normalizedNodes = normalizeTreeOrder(newNodes as NestableNode[]);
      set({ nodes: normalizedNodes });
      scheduleAutoSave(get().saveCanvas);
    }
  },

  sendSelectedToOrder: (direction) => {
    const { nodes } = get();
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;

    const selectedIds = new Set(selected.map((n) => n.id));
    const rest = nodes.filter((n) => !selectedIds.has(n.id));

    // 'top' = render on top (end of array), 'bottom' = render behind (start of array)
    const reordered =
      direction === 'top' ? [...rest, ...selected] : [...selected, ...rest];

    const normalizedNodes = normalizeTreeOrder(reordered as NestableNode[]);
    set({ nodes: normalizedNodes });
    scheduleAutoSave(get().saveCanvas);
  },

  frameSelectedNodes: () => {
    const { nodes } = get();
    const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
    if (selectedIds.length < 2) return;

    const frameId = createId('node');
    const result = frameNodes(nodes as NestableNode[], selectedIds, {
      frameId,
      label: 'Frame',
    });

    set({ nodes: result.nodes });

    scheduleAutoSave(get().saveCanvas);
  },

  unframe: (frameId) => {
    const { nodes, edges } = get();
    const result = unframe(nodes as NestableNode[], edges, frameId);
    set({ nodes: result.nodes, edges: result.edges });

    scheduleAutoSave(get().saveCanvas);
  },

  toggleFrameLock: (frameId) => {
    const { nodes } = get();

    set({ nodes: toggleFrameLock(nodes as NestableNode[], frameId) });

    scheduleAutoSave(get().saveCanvas);
  },

  moveNodeIntoFrame: (nodeId, frameId) => {
    const { nodes } = get();
    const result = moveNodeIntoFrame(nodes as NestableNode[], nodeId, frameId);
    set({ nodes: result });
    scheduleAutoSave(get().saveCanvas);
  },

  moveNodeOutOfFrame: (nodeId) => {
    const { nodes } = get();
    const result = moveNodeOutOfFrame(nodes as NestableNode[], nodeId);
    set({ nodes: result });
    scheduleAutoSave(get().saveCanvas);
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
        selected: true,
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

    // Deselect all existing nodes, then add pasted ones
    const deselected = nodes.map((n) => ({ ...n, selected: false }));
    set({ nodes: [...deselected, ...newNodes] });

    // Trigger ingestion for each pasted node
    for (const node of newNodes) {
      triggerIngestion(node);
    }

    scheduleAutoSave(get().saveCanvas);
  },
}));

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
