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

import { getCanvas, putCanvas, deleteNode } from '../api';
import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  frameNodes,
  toggleFrameLock,
  unframe,
  type NestableNode,
} from '../utils/frameHelper';
import {
  ingestNodeIfNeeded,
  shouldIngestOnUpdate,
  type NodeIngestionInfo,
} from '../utils/ingestHelper';

const CANVAS_ID = 'default-canvas';
const AUTOSAVE_DEBOUNCE_MS = 1000;
const DEFAULT_WORKSPACE_NAME = 'Sediment Workspace Name';

const triggerIngestion = (node: Node) => {
  const state = useCanvasStore.getState();
  void ingestNodeIfNeeded({
    canvasId: state.canvasId,
    node,
    setNodeIngestion: state.setNodeIngestion,
    clearNodeIngestion: state.clearNodeIngestion,
    getNodeById: (nodeId) => state.nodes.find((n) => n.id === nodeId),
    updateNodeDataLocal: state.updateNodeDataLocal,
  });
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

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  addNode: (node: Node) => void;
  rfInstance: ReactFlowInstance | null;
  setRfInstance: (instance: ReactFlowInstance | null) => void;

  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  updateNodeDataLocal: (nodeId: string, patch: Record<string, unknown>) => void;

  getSelectedNodeIds: () => string[];
  setSelectedNodes: (ids: string[], multiSelect?: boolean) => void;

  reorderNodes: (activeId: string, overId: string) => void;
  getSelectedSourceIds: () => string[];

  frameSelectedNodes: () => void;
  unframe: (frameId: string) => void;
  toggleFrameLock: (frameId: string) => void;

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

      set({ nodes: newNodes });
      scheduleAutoSave(get().saveCanvas);
    }
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
}));

export default useCanvasStore;
