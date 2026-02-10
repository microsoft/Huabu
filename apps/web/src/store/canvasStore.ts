import { createId } from '@sediment/shared';
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
} from '@xyflow/react';
import { create } from 'zustand';

import { getCanvas, putCanvas, upsertNode, deleteNode } from '../api';
import {
  autoFrameNodeByOverlap,
  autoUnframeNodeByNonOverlap,
  frameNodes,
  toggleFrameLock,
  unframe,
  type NestableNode,
} from '../utils/frameHelper';

const CANVAS_ID = 'default-canvas';
const AUTOSAVE_DEBOUNCE_MS = 1000;

// Helper to check if a node type needs ingestion
function needsIngestion(nodeType: string): boolean {
  return ['note', 'text', 'web', 'pdf'].includes(nodeType);
}

// Helper to trigger node ingestion
async function ingestNodeIfNeeded(canvasId: string, node: Node): Promise<void> {
  if (!needsIngestion(node.type ?? '')) return;

  const nodeData = node.data as Record<string, unknown> | undefined;

  try {
    await upsertNode(canvasId, node.id, {
      type: node.type as 'note' | 'text' | 'web' | 'pdf',
      title: (nodeData?.label as string) ?? (nodeData?.title as string),
      content: nodeData?.content as string,
      src: nodeData?.src as string,
    });
  } catch (error) {
    console.error('Failed to ingest node:', node.id, error);
  }
}

type RFState = {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  version: number;
  isLoading: boolean;
  isSaving: boolean;
  pendingSave: boolean;

  expandedNodeId: string | null;
  openExpanded: (nodeId: string) => void;
  closeExpanded: () => void;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;

  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;

  getSelectedNodeIds: () => string[];

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

  expandedNodeId: null,
  openExpanded: (nodeId) => set({ expandedNodeId: nodeId }),
  closeExpanded: () => set({ expandedNodeId: null }),

  loadCanvas: async () => {
    set({ isLoading: true });
    try {
      const { canvasId } = get();
      const response = await getCanvas(canvasId);
      if (!response) {
        console.warn('Canvas not found, using empty state');
        set({ isLoading: false });
        return;
      }

      const state = response.state as { nodes?: Node[]; edges?: Edge[] };
      set({
        nodes: state.nodes ?? [],
        edges: state.edges ?? [],
        version: response.version,
        isLoading: false,
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
      const { nodes, edges, version, canvasId } = get();
      const response = await putCanvas(canvasId, {
        version,
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

    set({ nodes: result });

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

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  addNode: (node) => {
    set({ nodes: [...get().nodes, node] });

    // Ingest the node if needed
    const { canvasId } = get();
    void ingestNodeIfNeeded(canvasId, node);

    scheduleAutoSave(get().saveCanvas);
  },

  updateNodeData: (nodeId, patch) => {
    if (!nodeId) return;

    let updatedNode: Node | undefined;

    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== nodeId) return n;
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
    if (updatedNode) {
      const { canvasId } = get();
      void ingestNodeIfNeeded(canvasId, updatedNode);
    }

    scheduleAutoSave(get().saveCanvas);
  },

  getSelectedNodeIds: () => {
    return get()
      .nodes.filter((n) => n.selected)
      .map((n) => n.id);
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
