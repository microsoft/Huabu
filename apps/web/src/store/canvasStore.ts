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

type RFState = {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
};

// === 1. Mock Nodes ===
export const initialNodes: Node[] = [
  // --- 1. Text Node  ---
  {
    id: 'node-text-1',
    type: 'text',
    position: { x: 500, y: -400 },
    data: {
      label: 'Sensemaking Research',
      content:
        'This board contains the preliminary research for the HCI project.\nFocus on the relationship between data foraging and schematizing.', // 正文
    },
    style: { width: 300, height: 160 },
  },

  // --- 2. Note Node  ---
  {
    id: 'node-note-1',
    type: 'note',
    position: { x: 1000, y: -200 },
    data: {
      content:
        '⚠️ TODO:\n1. Verify the PDF citations.\n2. Update the video link.\n3. Send draft to supervisor.',
    },
    style: { width: 220, height: 220 },
  },

  // --- 3. Image Node  ---
  {
    id: 'node-image-1',
    type: 'image',
    position: { x: 1000, y: 0 },
    data: {
      src: 'https://placehold.co/600x400/png',
      label: 'Fig 1. The Data/Frame Theory of Sensemaking',
    },
  },

  // --- 4. Group Node  ---
  {
    id: 'group-1',
    type: 'group',
    position: { x: 500, y: 400 },
    data: {
      label: 'Reference Materials',
    },
    style: { width: 460, height: 240 },
    zIndex: -1,
  },

  // --- 5. Web Node  ---
  {
    id: 'node-web-1',
    type: 'web',
    // parentId: 'group-1',
    position: { x: 0, y: 60 },
    data: {
      src: 'https://en.wikipedia.org/wiki/Sensemaking',
      label: 'Wikipedia: Sensemaking',
    },
    style: { width: 460, height: 300 },
  },

  // --- 6. PDF Node ---
  {
    id: 'node-pdf-1',
    type: 'pdf',
    // parentId: 'group-1',
    position: { x: 500, y: -140 },
    // extent: 'parent',
    data: {
      src: 'https://pdfobject.com/pdf/sample.pdf',
      label: 'Klein_1998_Data_Frame_Theory.pdf',
    },
    style: { width: 460, height: 500 },
  },

  // --- 7. Video Node  ---
  {
    id: 'node-video-1',
    type: 'video',
    position: { x: 0, y: 400 },
    data: {
      src: 'https://www.w3schools.com/html/mov_bbb.mp4',
      source: 'External Resource',
    },
    style: { width: 400, height: 240 },
  },
];

// === 2. Mock Edges  ===
export const initialEdges: Edge[] = [
  {
    id: 'e1-2',
    source: 'node-text-1',
    target: 'node-image-1',
    label: 'illustrates',
  },
  {
    id: 'e1-group',
    source: 'node-text-1',
    target: 'group-1',
    animated: true,
    label: 'references',
  },
  {
    id: 'e-note-img',
    source: 'node-note-1',
    target: 'node-image-1',
    style: { stroke: '#f59e0b' },
  },
];

const useStore = create<RFState>((set, get) => ({
  nodes: initialNodes,
  edges: initialEdges,

  onNodesChange: (changes) => {
    set({
      nodes: applyNodeChanges(changes, get().nodes),
    });
  },

  onEdgesChange: (changes) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },

  onConnect: (connection: Connection) => {
    set({
      edges: addEdge(connection, get().edges),
    });
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
}));

export default useStore;
