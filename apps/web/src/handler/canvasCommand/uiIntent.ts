/**
 * Web-only UI intent types and resolvers.
 *
 * A CanvasUiIntent represents a high-level user gesture that must be resolved
 * into explicit CanvasCommand(s) before execution. Resolution reads UI-only
 * state (selection, clipboard, drag context) and produces a CanvasExecution.
 *
 * Every user-facing action flows through an intent so that trace generation
 * happens uniformly at the intent level (not inside command handlers).
 */

import {
  resolveAddNodes,
  resolveDisconnectEdge,
  resolveGroupRectIntoFrame,
  resolveGroupSelectionIntoFrame,
  resolveNodeDragStop,
  resolvePasteClipboard,
  resolveSelectNodes,
} from './resolvers';
import {
  buildStructuredFrameRelayoutCommands,
  computeNodeEditDiff,
  extractNodeRef,
  extractSnippet,
  getSelectedNodeIds,
} from './utils';

import type {
  CanvasAlignDirection,
  CanvasCommand,
  CanvasNodeId,
  FrameLayoutMode,
  NodeSize,
  CanvasNodeType,
  Point,
  RecentAction,
} from '@sediment/shared';
import type { Edge, Node } from '@xyflow/react';

// ---------------------------------------------------------------------------
// Flow rect
// ---------------------------------------------------------------------------

export interface CanvasFlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasUiSelectionMode = 'replace' | 'toggle';

export interface AddNodeInput {
  id?: CanvasNodeId;
  nodeType: CanvasNodeType;
  data?: Record<string, unknown>;
  size?: NodeSize;
  naturalDimensions?: { width: number; height: number };
  parentId?: CanvasNodeId | null;
  /**
   * Top-left anchor of the new node and the point used for frame
   * hit-testing.
   *
   * Providing `placementPoint` is a contract that the caller has chosen
   * the node's position (drag-drop, paste, toolbar click, sketch overlay,
   * group-into-frame, etc.). Omit it for programmatic / AI creation where
   * the canvas should pick a slot via force-directed `placeNode`.
   */
  placementPoint?: Point;
}

// ---------------------------------------------------------------------------
// UiIntent union
// ---------------------------------------------------------------------------

export type CanvasUiIntent =
  // --- Composite gestures (need resolvers) ---
  | { type: 'GROUP_SELECTION_INTO_FRAME'; frameLabel?: string }
  | {
      type: 'GROUP_RECT_INTO_FRAME';
      flowRect: CanvasFlowRect;
      frameLabel?: string;
    }
  | {
      type: 'PASTE_CLIPBOARD';
      flowPosition?: Point;
      clipboardNodes: Node[];
      clipboardEdges?: Edge[];
    }
  | {
      type: 'NODE_DRAG_STOP';
      draggedNodeIds: string[];
      pointerFlowPosition?: Point;
    }
  | {
      type: 'SELECT_NODES';
      nodeIds: string[];
      mode?: CanvasUiSelectionMode;
    }
  | {
      type: 'ALIGN_SELECTED_NODES';
      direction: CanvasAlignDirection;
    }
  | {
      type: 'DISTRIBUTE_SELECTED_NODES';
    }
  | {
      type: 'REORDER_SELECTED_NODES';
      to: 'top' | 'bottom';
    }
  // --- Direct-mapping intents (operands are already explicit) ---
  | {
      type: 'ADD_NODES';
      inputs: AddNodeInput[];
    }
  | { type: 'DELETE_NODES'; nodeIds: string[] }
  | { type: 'UPDATE_NODE_DATA'; nodeId: string; patch: Record<string, unknown> }
  | { type: 'CONNECT_EDGE'; source: string; target: string }
  | { type: 'DISCONNECT_EDGE'; edgeIds: string[] }
  | {
      type: 'RESIZE_NODE';
      items: Array<{
        nodeId: string;
        // `height` is optional: omit (or pass undefined) to clear any
        // explicit height and let the node fall back to auto-sizing.
        size?: { width: number; height?: number };
        position?: { x: number; y: number };
      }>;
    }
  | {
      type: 'REORDER_NODE';
      activeId: string;
      overId: string;
      position?: 'before' | 'after';
    }
  | { type: 'DISSOLVE_FRAME'; frameId: string }
  | { type: 'TOGGLE_NODE_LOCK'; nodeId: string }
  | {
      /**
       * Change a frame's layout mode and (when switching into `column`
       * or `row`) the track count. The resolver folds the data patch
       * and the resulting re-flow into one batch so they share an
       * undo step.
       */
      type: 'SET_FRAME_LAYOUT_MODE';
      frameId: string;
      mode: FrameLayoutMode;
      gridCount?: number;
    }
  | {
      type: 'MOVE_NODE_INTO_FRAME';
      nodeId: string;
      frameId: string;
      reorderTarget?: { nodeId: string; position: 'before' | 'after' };
    }
  | {
      type: 'MOVE_NODE_OUT_OF_FRAME';
      nodeId: string;
      reorderTarget?: { nodeId: string; position: 'before' | 'after' };
    }
  | { type: 'EXPAND_NODE'; nodeId: string }
  | { type: 'CONVERT_NODE_TYPE'; nodeId: string; to: 'text' | 'note' };

// ---------------------------------------------------------------------------
// Resolver result — commands + trace
// ---------------------------------------------------------------------------

export interface UiIntentResolution {
  commands: CanvasCommand[];
  /** Trace entries to record for this intent. */
  trace: RecentAction[];
  /**
   * UI-only state mutation that bypasses the command pipeline.
   *
   * Used for view-state toggles (currently only the expand-overlay) that
   * are not part of the canvas graph but still flow through the intent
   * system for trace-uniformity. The store's `dispatchUiIntent` applies
   * this directly via `set({ expandedNodeId })`.
   */
  expandedNodeId?: string | null;
}

// ---------------------------------------------------------------------------
// UI state slice needed by resolvers
// ---------------------------------------------------------------------------

export interface UiResolverState {
  nodes: Node[];
  edges: Edge[];
  autoLayoutEnabled: boolean;
  /**
   * Flow-space coordinate of the current viewport centre. Filled in by
   * `dispatchUiIntent` from the live React Flow instance + canvas wrapper
   * rect. Resolvers use it as the anchor when a new node has no explicit
   * `placementPoint` (e.g. "Add as note" from a chat panel), so the node
   * lands in the visible area instead of being placed by the force-directed
   * fallback in the shared engine. Undefined when the canvas DOM is not
   * yet mounted (initial boot) or when the React Flow instance has not
   * registered yet.
   */
  viewportCenter?: Point;
}

// ---------------------------------------------------------------------------
// Resolver entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a web-only UI intent into commands + trace.
 *
 * The returned resolution contains one or more explicit CanvasCommands
 * and the trace entries that describe the user action for the LLM.
 */
export function resolveUiIntent(
  intent: CanvasUiIntent,
  ui: UiResolverState,
): UiIntentResolution {
  switch (intent.type) {
    case 'GROUP_SELECTION_INTO_FRAME':
      return resolveGroupSelectionIntoFrame(intent, ui);
    case 'GROUP_RECT_INTO_FRAME':
      return resolveGroupRectIntoFrame(intent, ui);
    case 'PASTE_CLIPBOARD':
      return resolvePasteClipboard(intent, ui);
    case 'NODE_DRAG_STOP':
      return resolveNodeDragStop(intent, ui);
    case 'SELECT_NODES':
      return resolveSelectNodes(intent, ui);
    case 'ALIGN_SELECTED_NODES': {
      const selectedIds = getSelectedNodeIds(ui.nodes);
      return {
        commands: [
          {
            type: 'ALIGN_NODES',
            nodeIds: selectedIds as CanvasNodeId[],
            direction: intent.direction,
          },
        ],
        trace: [],
      };
    }
    case 'DISTRIBUTE_SELECTED_NODES': {
      const selectedIds = getSelectedNodeIds(ui.nodes);
      return {
        commands: [
          { type: 'DISTRIBUTE_NODES', nodeIds: selectedIds as CanvasNodeId[] },
        ],
        trace: [],
      };
    }
    case 'REORDER_SELECTED_NODES':
      return resolveReorderSelected(intent, ui);
    case 'ADD_NODES':
      return resolveAddNodes(intent, ui);
    case 'DELETE_NODES':
      return resolveDeleteNodes(intent, ui);
    case 'UPDATE_NODE_DATA':
      return resolveUpdateNodeData(intent, ui);
    case 'CONNECT_EDGE':
      return resolveConnectEdge(intent, ui);
    case 'DISCONNECT_EDGE':
      return resolveDisconnectEdge(intent, ui);
    case 'RESIZE_NODE':
      return resolveResizeNode(intent, ui);
    case 'REORDER_NODE':
      return resolveReorderNode(intent, ui);
    case 'DISSOLVE_FRAME':
      return resolveDissolveFrame(intent, ui);
    case 'TOGGLE_NODE_LOCK':
      return resolveToggleNodeLock(intent, ui);
    case 'SET_FRAME_LAYOUT_MODE':
      return resolveSetFrameLayoutMode(intent, ui);
    case 'MOVE_NODE_INTO_FRAME':
      return resolveMoveNodeIntoFrame(intent, ui);
    case 'MOVE_NODE_OUT_OF_FRAME':
      return resolveMoveNodeOutOfFrame(intent, ui);
    case 'EXPAND_NODE': {
      const node = ui.nodes.find((n) => n.id === intent.nodeId);
      return {
        commands: [],
        expandedNodeId: intent.nodeId,
        trace: node
          ? [{ action: 'node_expanded', node: extractNodeRef(node) }]
          : [],
      };
    }
    case 'CONVERT_NODE_TYPE': {
      const node = ui.nodes.find((n) => n.id === intent.nodeId);
      if (!node) return { commands: [], trace: [] };
      return {
        commands: [
          {
            type: 'CHANGE_NODE_TYPE',
            nodeId: intent.nodeId as CanvasNodeId,
            to: intent.to,
          },
        ],
        trace: [{ action: 'node_edited', node: extractNodeRef(node) }],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Local resolvers (medium complexity — not worth separate files)
// ---------------------------------------------------------------------------

function resolveReorderSelected(
  intent: Extract<CanvasUiIntent, { type: 'REORDER_SELECTED_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const selectedIds = getSelectedNodeIds(ui.nodes);
  const selectedNodes = ui.nodes.filter((n) => selectedIds.includes(n.id));

  return {
    commands:
      selectedIds.length === 0
        ? []
        : [
            {
              type: 'REORDER_NODES',
              nodeIds: selectedIds as CanvasNodeId[],
              to: intent.to,
            },
          ],
    trace:
      selectedNodes.length > 0
        ? [
            {
              action: 'nodes_reordered',
              nodes: selectedNodes.map(extractNodeRef),
            },
          ]
        : [],
  };
}

function resolveDeleteNodes(
  intent: Extract<CanvasUiIntent, { type: 'DELETE_NODES' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const toDelete = ui.nodes.filter((n) => intent.nodeIds.includes(n.id));
  return {
    commands: [
      {
        type: 'DELETE_NODES',
        nodeIds: intent.nodeIds as CanvasNodeId[],
      },
    ],
    trace:
      toDelete.length > 0
        ? [
            {
              action: 'nodes_deleted',
              nodes: toDelete.map((n) => ({
                ...extractNodeRef(n),
                snippet: extractSnippet(n),
              })),
            },
          ]
        : [],
  };
}

function resolveUpdateNodeData(
  intent: Extract<CanvasUiIntent, { type: 'UPDATE_NODE_DATA' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  // Compute a structural diff when the patch touches the `content`
  // string field — gives the agent a sense of what kind of edit
  // happened (append vs rewrite vs trim) without leaking node body
  // text into the action log.
  const beforeContent = (node?.data as Record<string, unknown> | undefined)
    ?.content;
  const editDiff =
    intent.patch.content !== undefined
      ? computeNodeEditDiff(beforeContent, intent.patch.content)
      : undefined;
  return {
    commands: [
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          { nodeId: intent.nodeId as CanvasNodeId, patch: intent.patch },
        ],
      },
    ],
    trace: node
      ? [
          {
            action: 'node_edited',
            node: extractNodeRef(node),
            ...(editDiff ? { edit: editDiff } : {}),
          },
        ]
      : [],
  };
}

function resolveConnectEdge(
  intent: Extract<CanvasUiIntent, { type: 'CONNECT_EDGE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const sourceNode = ui.nodes.find((n) => n.id === intent.source);
  const targetNode = ui.nodes.find((n) => n.id === intent.target);
  return {
    commands: [
      {
        type: 'CONNECT_NODES',
        edges: [
          {
            source: intent.source as CanvasNodeId,
            target: intent.target as CanvasNodeId,
          },
        ],
      },
    ],
    trace:
      sourceNode && targetNode
        ? [
            {
              action: 'node_connected',
              source: extractNodeRef(sourceNode),
              target: extractNodeRef(targetNode),
            },
          ]
        : [],
  };
}

function resolveResizeNode(
  intent: Extract<CanvasUiIntent, { type: 'RESIZE_NODE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const trace: RecentAction[] = [];
  // Pick the first item that has a fully-specified size for the trace entry;
  // height-less updates (used to clear an explicit height) are not recorded.
  const primary = intent.items.find(
    (i) => i.size && typeof i.size.height === 'number',
  );
  if (primary?.size && typeof primary.size.height === 'number') {
    const node = ui.nodes.find((n) => n.id === primary.nodeId);
    if (node) {
      trace.push({
        action: 'node_resized',
        node: extractNodeRef(node),
        width: primary.size.width,
        height: primary.size.height,
      });
    }
  }
  return {
    commands: [
      {
        type: 'SET_NODE_GEOMETRY',
        items: intent.items.map((item) => ({
          nodeId: item.nodeId as CanvasNodeId,
          ...(item.size && { size: item.size }),
          ...(item.position && { position: item.position }),
        })),
      },
    ],
    trace,
  };
}

function resolveReorderNode(
  intent: Extract<CanvasUiIntent, { type: 'REORDER_NODE' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.activeId);
  const pos = intent.position ?? 'before';
  return {
    commands: [
      {
        type: 'REORDER_NODES',
        nodeIds: [intent.activeId as CanvasNodeId],
        to:
          pos === 'after'
            ? { after: intent.overId as CanvasNodeId }
            : { before: intent.overId as CanvasNodeId },
      },
    ],
    trace: node
      ? [{ action: 'nodes_reordered', nodes: [extractNodeRef(node)] }]
      : [],
  };
}

function resolveDissolveFrame(
  intent: Extract<CanvasUiIntent, { type: 'DISSOLVE_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const frame = ui.nodes.find((n) => n.id === intent.frameId);
  const children = ui.nodes.filter((n) => n.parentId === intent.frameId);
  return {
    commands: [
      {
        type: 'DISSOLVE_FRAME',
        frameId: intent.frameId as CanvasNodeId,
      },
    ],
    trace: frame
      ? [
          {
            action: 'frame_unframed',
            frame: extractNodeRef(frame),
            nodes: children.map(extractNodeRef),
          },
        ]
      : [],
  };
}

function resolveToggleNodeLock(
  intent: Extract<CanvasUiIntent, { type: 'TOGGLE_NODE_LOCK' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  if (!node) {
    return { commands: [], trace: [] };
  }
  return {
    commands: [
      {
        type: 'SET_NODE_LOCKED',
        items: [
          { nodeId: intent.nodeId as CanvasNodeId, locked: !node.data?.locked },
        ],
      },
    ],
    trace: [],
  };
}

function resolveMoveNodeIntoFrame(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_NODE_INTO_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  const frame = ui.nodes.find((n) => n.id === intent.frameId);
  const commands: CanvasCommand[] = [
    {
      type: 'SET_NODE_PARENT',
      nodeIds: [intent.nodeId as CanvasNodeId],
      parentId: intent.frameId as CanvasNodeId,
    },
  ];
  if (intent.reorderTarget) {
    commands.push({
      type: 'REORDER_NODES',
      nodeIds: [intent.nodeId as CanvasNodeId],
      to:
        intent.reorderTarget.position === 'after'
          ? { after: intent.reorderTarget.nodeId as CanvasNodeId }
          : { before: intent.reorderTarget.nodeId as CanvasNodeId },
    });
  }
  // Re-flow the destination frame when it opted into a structured
  // layout. Also re-flow the source frame (if any) since it just lost
  // a child.
  const affectedFrameIds = [intent.frameId];
  if (node?.parentId && node.parentId !== intent.frameId) {
    affectedFrameIds.push(node.parentId);
  }
  commands.push(
    ...buildStructuredFrameRelayoutCommands(affectedFrameIds, ui.nodes, {
      // SET_NODE_PARENT was just emitted above — mirror it so the
      // layout pass sees the moved child as a member of the new frame.
      parentChanges: new Map([[intent.nodeId, intent.frameId]]),
    }),
  );
  return {
    commands,
    trace:
      node && frame
        ? [
            {
              action: 'node_framed',
              node: extractNodeRef(node),
              frame: extractNodeRef(frame),
            },
          ]
        : [],
  };
}

function resolveMoveNodeOutOfFrame(
  intent: Extract<CanvasUiIntent, { type: 'MOVE_NODE_OUT_OF_FRAME' }>,
  ui: UiResolverState,
): UiIntentResolution {
  const node = ui.nodes.find((n) => n.id === intent.nodeId);
  const frame = node?.parentId
    ? ui.nodes.find((n) => n.id === node.parentId)
    : undefined;
  const commands: CanvasCommand[] = [
    {
      type: 'SET_NODE_PARENT',
      nodeIds: [intent.nodeId as CanvasNodeId],
      parentId: null,
    },
  ];
  if (intent.reorderTarget) {
    commands.push({
      type: 'REORDER_NODES',
      nodeIds: [intent.nodeId as CanvasNodeId],
      to:
        intent.reorderTarget.position === 'after'
          ? { after: intent.reorderTarget.nodeId as CanvasNodeId }
          : { before: intent.reorderTarget.nodeId as CanvasNodeId },
    });
  }
  // Re-flow the source frame when it opted into a structured layout —
  // it just lost a child and the remaining slots should reflow.
  if (node?.parentId) {
    commands.push(
      ...buildStructuredFrameRelayoutCommands([node.parentId], ui.nodes, {
        // SET_NODE_PARENT was just emitted above — mirror the detach
        // so the layout pass no longer counts this child.
        parentChanges: new Map([[intent.nodeId, null]]),
      }),
    );
  }
  return {
    commands,
    trace:
      node && frame
        ? [
            {
              action: 'node_unframed',
              node: extractNodeRef(node),
              frame: extractNodeRef(frame),
            },
          ]
        : [],
  };
}

function resolveSetFrameLayoutMode(
  intent: Extract<CanvasUiIntent, { type: 'SET_FRAME_LAYOUT_MODE' }>,
  _ui: UiResolverState,
): UiIntentResolution {
  // The executor's end-of-batch structured-relayout pass picks the
  // frame up via `affectedFrameIds` and does the reflow + fit in one
  // pass — no follow-up commands needed.
  return {
    commands: [
      {
        type: 'SET_FRAME_LAYOUT',
        frameId: intent.frameId as CanvasNodeId,
        mode: intent.mode,
        ...(typeof intent.gridCount === 'number' && {
          gridCount: intent.gridCount,
        }),
      },
    ],
    trace: [],
  };
}
