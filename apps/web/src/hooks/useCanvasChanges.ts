/**
 * useCanvasChanges.ts
 *
 * Canvas change tracking and preview hook.
 *
 * - `snapshotAndExtractChanges()` — pure function called before commands execute
 *   to capture revert data. Used by useAgentStream.
 * - `useCanvasChangePreview()` — React hook that manages the "View Before"
 *   preview state (temporarily swaps canvas to show pre-change snapshot).
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import useCanvasStore from '@/store/canvasStore';

import { cancelAgentAnimation } from './useAgentStream';

import type {
  CanvasCommand,
  CanvasEdgeId,
  CanvasNodeId,
  CanvasNodeType,
  CanvasNodeGeometryUpdate,
} from '@sediment/shared';
import type { Node, Edge } from '@xyflow/react';

// ==================== CanvasChange Type ====================

export interface CanvasChange {
  id: string;
  tool: string;
  label: string;
  nodeType?: string;
  nodeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  /** Snapshot labels captured at extraction time (stable across preview swaps). */
  nodeLabel?: string;
  sourceNodeLabel?: string;
  targetNodeLabel?: string;
  revertible: boolean;
  /** Single revert command (most cases) */
  revertCommand?: CanvasCommand;
  /** Multiple revert commands (e.g. DELETE needs recreate node + reconnect edges) */
  revertCommands?: CanvasCommand[];
}

// ==================== Helpers ====================

let changeCounter = 0;
function nextChangeId(): string {
  return `chg-${Date.now()}-${++changeCounter}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function nodeLabel(node: Node | undefined): string {
  if (!node) return 'unknown';
  const label = (node.data as Record<string, unknown>)?.label;
  return truncate((label as string) || node.id, 24);
}

function nodeType(node: Node | undefined): CanvasNodeType {
  return ((node?.type as CanvasNodeType) ?? 'note') as CanvasNodeType;
}

function buildNodeRecreateCommand(node: Node): CanvasCommand {
  const data = { ...(node.data as Record<string, unknown>) };
  const { type: _, ...rest } = data;
  return {
    type: 'CREATE_NODES',
    nodes: [
      {
        id: node.id as CanvasNodeId,
        nodeType: nodeType(node),
        data: rest as never,
        position: { ...node.position },
        ...(node.parentId ? { parentId: node.parentId as CanvasNodeId } : {}),
        ...(node.style?.width
          ? {
              size: {
                width: node.style.width as number,
                ...(node.style.height
                  ? { height: node.style.height as number }
                  : {}),
              },
            }
          : {}),
      },
    ],
  };
}

// ==================== Snapshot & Extract ====================

/**
 * Snapshot the current canvas state and extract per-item CanvasChange entries
 * for a batch of commands. Must be called BEFORE the commands are executed.
 */
export function snapshotAndExtractChanges(
  commands: CanvasCommand[],
): CanvasChange[] {
  const { nodes, edges } = useCanvasStore.getState();
  const changes: CanvasChange[] = [];

  const labelMap = new Map<string, string>();
  for (const node of nodes) {
    const lbl = (node.data as Record<string, unknown>)?.label;
    if (lbl) labelMap.set(node.id, lbl as string);
  }
  for (const cmd of commands) {
    if (cmd.type === 'CREATE_NODES') {
      for (const n of cmd.nodes) {
        const lbl = (n.data as Record<string, unknown> | undefined)?.label;
        if (n.id && lbl) labelMap.set(n.id as string, lbl as string);
      }
    }
  }

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'CREATE_NODES':
        changes.push(...extractCreateNodes(cmd, labelMap));
        break;
      case 'CREATE_QUESTION':
        changes.push({
          id: nextChangeId(),
          tool: 'canvas_commands',
          label: `Created question: ${truncate(cmd.content, 24)}`,
          revertible: false,
        });
        break;
      case 'DELETE_NODES':
        changes.push(...extractDeleteNodes(cmd, nodes, edges, labelMap));
        break;
      case 'MERGE_NODE_DATA':
        changes.push(...extractMergeNodeData(cmd, nodes, labelMap));
        break;
      case 'CONNECT_NODES':
        changes.push(...extractConnectNodes(cmd, labelMap));
        break;
      case 'DISCONNECT_EDGES':
        changes.push(...extractDisconnectEdges(cmd, nodes, edges, labelMap));
        break;
      case 'SET_NODE_PARENT':
        changes.push(...extractSetNodeParent(cmd, nodes, labelMap));
        break;
      case 'DISSOLVE_FRAME':
        changes.push(...extractDissolveFrame(cmd, nodes, labelMap));
        break;
      case 'SET_NODE_GEOMETRY':
        changes.push(...extractSetNodeGeometry(cmd, nodes, labelMap));
        break;
      case 'REORDER_NODES':
        changes.push(...extractReorderNodes(cmd, nodes, labelMap));
        break;
      case 'ALIGN_NODES':
        changes.push(...extractAlignNodes(cmd, nodes));
        break;
      case 'DISTRIBUTE_NODES':
        changes.push(...extractDistributeNodes(cmd, nodes));
        break;
      default:
        break;
    }
  }
  return changes;
}

// ==================== Per-Command Extractors ====================

function extractCreateNodes(
  cmd: Extract<CanvasCommand, { type: 'CREATE_NODES' }>,
  labelMap: Map<string, string>,
): CanvasChange[] {
  return cmd.nodes.map((node) => {
    const label = (node.data as Record<string, unknown> | undefined)?.label;
    const lbl = truncate((label as string) ?? 'untitled', 24);
    return {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Created: ${lbl}`,
      nodeType: node.nodeType,
      nodeId: node.id,
      nodeLabel: labelMap.get(node.id as string) ?? lbl,
      revertible: true,
      revertCommand: {
        type: 'DELETE_NODES',
        nodeIds: [node.id as CanvasNodeId],
      },
    };
  });
}

function extractDeleteNodes(
  cmd: Extract<CanvasCommand, { type: 'DELETE_NODES' }>,
  nodes: Node[],
  edges: Edge[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  const changes: CanvasChange[] = [];
  const allDeleteIds = new Set(cmd.nodeIds as string[]);
  for (const id of cmd.nodeIds) {
    for (const n of nodes) {
      if (n.parentId === id) allDeleteIds.add(n.id);
    }
  }
  const affectedEdges = edges.filter(
    (e) => allDeleteIds.has(e.source) || allDeleteIds.has(e.target),
  );

  for (const nodeId of cmd.nodeIds) {
    const node = nodes.find((n) => n.id === nodeId);
    const revertCommands: CanvasCommand[] = [];
    if (node) {
      revertCommands.push(buildNodeRecreateCommand(node));
      const children = nodes.filter((n) => n.parentId === nodeId);
      for (const child of children) {
        revertCommands.push(buildNodeRecreateCommand(child));
      }
      const relatedIds = new Set([nodeId, ...children.map((c) => c.id)]);
      const nodeEdges = affectedEdges.filter(
        (e) => relatedIds.has(e.source) || relatedIds.has(e.target),
      );
      if (nodeEdges.length > 0) {
        revertCommands.push({
          type: 'CONNECT_NODES',
          edges: nodeEdges.map((e) => ({
            id: e.id as CanvasEdgeId,
            source: e.source as CanvasNodeId,
            target: e.target as CanvasNodeId,
          })),
        });
      }
    }
    changes.push({
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Deleted: ${nodeLabel(node)}`,
      nodeType: node ? nodeType(node) : 'note',
      nodeId: nodeId,
      nodeLabel: labelMap.get(nodeId as string) ?? nodeLabel(node),
      revertible: !!node,
      revertCommands: revertCommands.length > 0 ? revertCommands : undefined,
    });
  }
  return changes;
}

function extractMergeNodeData(
  cmd: Extract<CanvasCommand, { type: 'MERGE_NODE_DATA' }>,
  nodes: Node[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  return cmd.patches.map((patch) => {
    const node = nodes.find((n) => n.id === patch.nodeId);
    const data = (node?.data ?? {}) as Record<string, unknown>;
    const inversePatch: Record<string, unknown> = {};
    for (const key of Object.keys(patch.patch)) {
      inversePatch[key] = data[key];
    }
    return {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Updated: ${nodeLabel(node)}`,
      nodeType: node ? nodeType(node) : 'note',
      nodeId: patch.nodeId,
      nodeLabel: labelMap.get(patch.nodeId as string) ?? nodeLabel(node),
      revertible: !!node,
      revertCommand: node
        ? {
            type: 'MERGE_NODE_DATA' as const,
            patches: [{ nodeId: patch.nodeId, patch: inversePatch }],
          }
        : undefined,
    };
  });
}

function extractConnectNodes(
  cmd: Extract<CanvasCommand, { type: 'CONNECT_NODES' }>,
  labelMap: Map<string, string>,
): CanvasChange[] {
  return cmd.edges.map((edge) => ({
    id: nextChangeId(),
    tool: 'canvas_commands',
    label: 'Connected',
    sourceNodeId: edge.source,
    targetNodeId: edge.target,
    sourceNodeLabel: labelMap.get(edge.source as string),
    targetNodeLabel: labelMap.get(edge.target as string),
    revertible: true,
    revertCommand: {
      type: 'DISCONNECT_EDGES',
      edges: [{ source: edge.source, target: edge.target }],
    },
  }));
}

function extractDisconnectEdges(
  cmd: Extract<CanvasCommand, { type: 'DISCONNECT_EDGES' }>,
  nodes: Node[],
  edges: Edge[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  return cmd.edges.map((edgeRef) => {
    let source: string | undefined;
    let target: string | undefined;
    if (typeof edgeRef === 'string') {
      const edge = edges.find((e) => e.id === edgeRef);
      source = edge?.source;
      target = edge?.target;
    } else {
      source = edgeRef.source;
      target = edgeRef.target;
    }
    const sourceNode = nodes.find((n) => n.id === source);
    const targetNode = nodes.find((n) => n.id === target);
    return {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Disconnected: ${nodeLabel(sourceNode)} → ${nodeLabel(targetNode)}`,
      sourceNodeId: source,
      targetNodeId: target,
      sourceNodeLabel: source
        ? (labelMap.get(source) ?? nodeLabel(sourceNode))
        : undefined,
      targetNodeLabel: target
        ? (labelMap.get(target) ?? nodeLabel(targetNode))
        : undefined,
      revertible: !!source && !!target,
      revertCommand:
        source && target
          ? {
              type: 'CONNECT_NODES',
              edges: [
                {
                  source: source as CanvasNodeId,
                  target: target as CanvasNodeId,
                },
              ],
            }
          : undefined,
    };
  });
}

function extractSetNodeParent(
  cmd: Extract<CanvasCommand, { type: 'SET_NODE_PARENT' }>,
  nodes: Node[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  return cmd.nodeIds.map((nodeId) => {
    const node = nodes.find((n) => n.id === nodeId);
    const oldParentId = (node?.parentId as CanvasNodeId) ?? null;
    const targetLabel = cmd.parentId
      ? 'Moved into frame'
      : 'Moved out of frame';
    return {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `${targetLabel}: ${nodeLabel(node)}`,
      nodeType: node ? nodeType(node) : 'note',
      nodeId: nodeId,
      nodeLabel: labelMap.get(nodeId as string) ?? nodeLabel(node),
      revertible: !!node,
      revertCommand: node
        ? { type: 'SET_NODE_PARENT', nodeIds: [nodeId], parentId: oldParentId }
        : undefined,
    };
  });
}

function extractDissolveFrame(
  cmd: Extract<CanvasCommand, { type: 'DISSOLVE_FRAME' }>,
  nodes: Node[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  const node = nodes.find((n) => n.id === cmd.frameId);
  return [
    {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Dissolved frame: ${nodeLabel(node)}`,
      nodeType: 'frame',
      nodeId: cmd.frameId,
      nodeLabel: labelMap.get(cmd.frameId as string) ?? nodeLabel(node),
      revertible: false,
    },
  ];
}

function extractSetNodeGeometry(
  cmd: Extract<CanvasCommand, { type: 'SET_NODE_GEOMETRY' }>,
  nodes: Node[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  const revertItems: CanvasNodeGeometryUpdate[] = [];
  return cmd.items.map((item) => {
    const node = nodes.find((n) => n.id === item.nodeId);
    if (node) {
      const revertItem: CanvasNodeGeometryUpdate = { nodeId: item.nodeId };
      if (item.position) revertItem.position = { ...node.position };
      if (item.size && node.style) {
        revertItem.size = {
          width: (node.style.width as number) ?? 200,
          ...(node.style.height ? { height: node.style.height as number } : {}),
        };
      }
      revertItems.push(revertItem);
    }
    return {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Repositioned: ${nodeLabel(node)}`,
      nodeType: node ? nodeType(node) : 'note',
      nodeId: item.nodeId,
      nodeLabel: labelMap.get(item.nodeId as string) ?? nodeLabel(node),
      revertible: !!node,
      revertCommand: node
        ? ({
            type: 'SET_NODE_GEOMETRY',
            items: [
              revertItems[revertItems.length - 1] as CanvasNodeGeometryUpdate,
            ],
          } as CanvasCommand)
        : undefined,
    };
  });
}

function extractReorderNodes(
  cmd: Extract<CanvasCommand, { type: 'REORDER_NODES' }>,
  nodes: Node[],
  labelMap: Map<string, string>,
): CanvasChange[] {
  return cmd.nodeIds.map((nodeId) => {
    const node = nodes.find((n) => n.id === nodeId);
    return {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Reordered: ${nodeLabel(node)}`,
      nodeType: node ? nodeType(node) : 'note',
      nodeId: nodeId,
      nodeLabel: labelMap.get(nodeId as string) ?? nodeLabel(node),
      revertible: false,
    };
  });
}

function extractAlignNodes(
  cmd: Extract<CanvasCommand, { type: 'ALIGN_NODES' }>,
  nodes: Node[],
): CanvasChange[] {
  const revertItems: CanvasNodeGeometryUpdate[] = [];
  for (const nodeId of cmd.nodeIds) {
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      revertItems.push({ nodeId, position: { ...node.position } });
    }
  }
  return [
    {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Aligned ${cmd.nodeIds.length} node(s) (${cmd.direction})`,
      revertible: revertItems.length > 0,
      revertCommand:
        revertItems.length > 0
          ? { type: 'SET_NODE_GEOMETRY', items: revertItems }
          : undefined,
    },
  ];
}

function extractDistributeNodes(
  cmd: Extract<CanvasCommand, { type: 'DISTRIBUTE_NODES' }>,
  nodes: Node[],
): CanvasChange[] {
  const revertItems: CanvasNodeGeometryUpdate[] = [];
  for (const nodeId of cmd.nodeIds) {
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      revertItems.push({ nodeId, position: { ...node.position } });
    }
  }
  return [
    {
      id: nextChangeId(),
      tool: 'canvas_commands',
      label: `Distributed ${cmd.nodeIds.length} node(s)`,
      revertible: revertItems.length > 0,
      revertCommand:
        revertItems.length > 0
          ? { type: 'SET_NODE_GEOMETRY', items: revertItems }
          : undefined,
    },
  ];
}

// ==================== Pure State Transform ====================

function applyCommandsToState(
  commands: CanvasCommand[],
  nodes: Node[],
  edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  let currentNodes = [...nodes];
  let currentEdges = [...edges];

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'DELETE_NODES': {
        const ids = new Set(cmd.nodeIds as string[]);
        for (const n of currentNodes) {
          if (n.parentId && ids.has(n.parentId)) ids.add(n.id);
        }
        currentNodes = currentNodes.filter((n) => !ids.has(n.id));
        currentEdges = currentEdges.filter(
          (e) => !ids.has(e.source) && !ids.has(e.target),
        );
        break;
      }
      case 'CREATE_NODES': {
        for (const input of cmd.nodes) {
          const data = { type: input.nodeType, ...(input.data ?? {}) };
          currentNodes = [
            ...currentNodes,
            {
              id: (input.id ?? `preview-${nextChangeId()}`) as string,
              type: input.nodeType,
              position: input.position ?? { x: 0, y: 0 },
              data,
              ...(input.parentId ? { parentId: input.parentId } : {}),
              ...(input.size
                ? {
                    style: {
                      width: input.size.width,
                      ...(input.size.height
                        ? { height: input.size.height }
                        : {}),
                    },
                  }
                : {}),
            },
          ];
        }
        break;
      }
      case 'CONNECT_NODES': {
        for (const edge of cmd.edges) {
          currentEdges = [
            ...currentEdges,
            {
              id: (edge.id as string) ?? `preview-edge-${nextChangeId()}`,
              source: edge.source as string,
              target: edge.target as string,
            },
          ];
        }
        break;
      }
      case 'DISCONNECT_EDGES': {
        for (const ref of cmd.edges) {
          if (typeof ref === 'string') {
            currentEdges = currentEdges.filter((e) => e.id !== ref);
          } else {
            currentEdges = currentEdges.filter(
              (e) => !(e.source === ref.source && e.target === ref.target),
            );
          }
        }
        break;
      }
      case 'MERGE_NODE_DATA': {
        for (const patch of cmd.patches) {
          currentNodes = currentNodes.map((n) =>
            n.id === patch.nodeId
              ? { ...n, data: { ...(n.data as object), ...patch.patch } }
              : n,
          );
        }
        break;
      }
      case 'SET_NODE_GEOMETRY': {
        for (const item of cmd.items) {
          currentNodes = currentNodes.map((n) => {
            if (n.id !== item.nodeId) return n;
            const updated = { ...n };
            if (item.position) updated.position = { ...item.position };
            if (item.size) {
              updated.style = {
                ...(n.style ?? {}),
                width: item.size.width,
                ...(item.size.height ? { height: item.size.height } : {}),
              };
            }
            return updated;
          });
        }
        break;
      }
      case 'SET_NODE_PARENT': {
        const ids = new Set(cmd.nodeIds as string[]);
        currentNodes = currentNodes.map((n) =>
          ids.has(n.id)
            ? { ...n, parentId: (cmd.parentId as string) ?? undefined }
            : n,
        );
        break;
      }
      default:
        break;
    }
  }
  return { nodes: currentNodes, edges: currentEdges };
}

// ==================== Preview Hook ====================

/** Collect all node IDs referenced by a change. */
function collectChangeNodeIds(change: CanvasChange): string[] {
  const ids: string[] = [];
  if (change.nodeId) ids.push(change.nodeId);
  if (change.sourceNodeId) ids.push(change.sourceNodeId);
  if (change.targetNodeId) ids.push(change.targetNodeId);
  return ids;
}

/**
 * Hook that manages the "View Before" preview state.
 * Temporarily swaps canvas nodes/edges to show the pre-change snapshot
 * while the user holds down the preview button.
 */
export function useCanvasChangePreview(changes: CanvasChange[]) {
  const [previewActive, setPreviewActive] = useState(false);
  const snapshotRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const previewNodeIdsRef = useRef<Set<string>>(new Set());
  const nodes = useCanvasStore((s) => s.nodes);

  const existingNodeIds = useMemo(
    () => new Set(nodes.map((n) => n.id)),
    [nodes],
  );

  const previewingIds = useMemo(
    () => (previewActive ? previewNodeIdsRef.current : new Set<string>()),

    [previewActive],
  );

  const isNodeMissing = useCallback(
    (id: string | undefined) => !!id && !existingNodeIds.has(id),
    [existingNodeIds],
  );

  const isNodePreviewing = useCallback(
    (id: string | undefined) => !!id && previewingIds.has(id),
    [previewingIds],
  );

  const startPreview = useCallback((change: CanvasChange) => {
    if (snapshotRef.current) return;
    // Cancel any in-progress agent entrance animation so the snapshot
    // captures clean state (no opacity:0 or transition styles).
    cancelAgentAnimation();
    const { nodes, edges } = useCanvasStore.getState();
    snapshotRef.current = { nodes, edges };
    previewNodeIdsRef.current = new Set(collectChangeNodeIds(change));

    const cmds: CanvasCommand[] = [];
    if (change.revertCommands) cmds.push(...change.revertCommands);
    else if (change.revertCommand) cmds.push(change.revertCommand);
    if (cmds.length === 0) return;

    const preview = applyCommandsToState(cmds, nodes, edges);
    // Use the no-autosave setter: a preview is a transient visual hover
    // state; if the user holds it longer than the 1 s autosave debounce
    // we must NOT persist the reverted snapshot to the server.
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ nodes: preview.nodes, edges: preview.edges });
    setPreviewActive(true);
  }, []);

  const startPreviewAll = useCallback(() => {
    if (snapshotRef.current) return;
    cancelAgentAnimation();
    const { nodes, edges } = useCanvasStore.getState();
    snapshotRef.current = { nodes, edges };

    const allIds: string[] = [];
    const cmds: CanvasCommand[] = [];
    const revertible = changes.filter((c) => c.revertible);
    for (let i = revertible.length - 1; i >= 0; i--) {
      const c = revertible[i];
      if (!c) continue;
      allIds.push(...collectChangeNodeIds(c));
      if (c.revertCommands) cmds.push(...c.revertCommands);
      else if (c.revertCommand) cmds.push(c.revertCommand);
    }
    previewNodeIdsRef.current = new Set(allIds);
    if (cmds.length === 0) return;

    const preview = applyCommandsToState(cmds, nodes, edges);
    // See startPreview for why this bypasses autosave.
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ nodes: preview.nodes, edges: preview.edges });
    setPreviewActive(true);
  }, [changes]);

  const endPreview = useCallback(() => {
    if (!snapshotRef.current) return;
    // Restoring the snapshot is the symmetric counterpart of startPreview
    // and must also bypass autosave — otherwise tearing down a preview
    // would schedule an empty-diff structure PUT.
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: snapshotRef.current.nodes,
      edges: snapshotRef.current.edges,
    });
    snapshotRef.current = null;
    previewNodeIdsRef.current = new Set();
    setPreviewActive(false);
  }, []);

  const handlePreviewDown = useCallback(
    (change: CanvasChange) => {
      if (change.revertible) startPreview(change);
    },
    [startPreview],
  );

  const handlePreviewAllDown = useCallback(() => {
    startPreviewAll();
  }, [startPreviewAll]);

  const handlePreviewUp = useCallback(() => {
    if (snapshotRef.current) endPreview();
  }, [endPreview]);

  return {
    previewActive,
    isNodeMissing,
    isNodePreviewing,
    handlePreviewDown,
    handlePreviewAllDown,
    handlePreviewUp,
  };
}
