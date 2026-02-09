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

import { getCanvas, putCanvas } from '../api';
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

    scheduleAutoSave(get().saveCanvas);
  },

  updateNodeData: (nodeId, patch) => {
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
