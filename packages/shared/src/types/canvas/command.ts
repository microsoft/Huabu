/**
 * Shared canvas command schema executed by both the web client and agent flows.
 */

import type { EdgeStyle } from './edge.js';
import type { LayoutStrategy, Point } from './layout.js';
import type { CanvasNodeType, NodeData } from './node.js';
import type { PrefixedId } from '../../utils/id.js';

/**
 * Canvas node ids follow the standard `node-<uuid>` convention.
 */
export type CanvasNodeId = PrefixedId<'node'>;

/**
 * Canvas edge ids follow the standard `edge-<uuid>` convention.
 */
export type CanvasEdgeId = PrefixedId<'edge'>;

/**
 * Explicit edge target used for disconnect commands.
 */
export type CanvasEdgeRef =
  | CanvasEdgeId
  | { source: CanvasNodeId; target: CanvasNodeId };

export interface NodeSize {
  width: number;
  height?: number;
}

/** Single source of truth for `CanvasAlignDirection`. */
export const CANVAS_ALIGN_DIRECTIONS = [
  'left',
  'center-h',
  'right',
  'top',
  'center-v',
  'bottom',
] as const;
export type CanvasAlignDirection = (typeof CANVAS_ALIGN_DIRECTIONS)[number];

export type CanvasAutoLayoutScope =
  | { type: 'canvas' }
  | { type: 'frame'; frameId: CanvasNodeId };

export interface CanvasAutoLayoutOptions {
  strategy?: LayoutStrategy;
  spacing?: Partial<NodeSize>;
  animate?: boolean;
}

type CanvasNodeCreateInputByType<T extends CanvasNodeType> = {
  /**
   * Optional explicit id for deterministic callers.
   * If later commands in the same batch need to reference this node,
   * the caller should provide a standard `node-<uuid>` id here.
   */
  id?: CanvasNodeId;
  nodeType: T;
  data?: Partial<Omit<Extract<NodeData, { type: T }>, 'type'>>;
  /**
   * Top-left position of the new node.
   *
   * Providing `position` is a contract that the caller has chosen where
   * the node belongs (drag-drop, paste, toolbar placement, group-into-frame,
   * etc.) — the create handler honours it verbatim. Omit `position` for
   * programmatic / AI creation paths where the canvas should pick a slot
   * via force-directed `placeNode`.
   */
  position?: Point;
  size?: NodeSize;
  parentId?: CanvasNodeId | null;
};

export type CanvasNodeCreateInput = {
  [T in CanvasNodeType]: CanvasNodeCreateInputByType<T>;
}[CanvasNodeType];

export type CanvasNodeDataMergePatch = {
  nodeId: CanvasNodeId;
  patch: Record<string, unknown>;
};

export interface CanvasNodeParentUpdate {
  nodeIds: CanvasNodeId[];
  parentId: CanvasNodeId | null;
}

export interface CanvasNodeGeometryUpdate {
  nodeId: CanvasNodeId;
  position?: Point;
  size?: NodeSize;
}

export interface CanvasNodeLockUpdate {
  nodeId: CanvasNodeId;
  locked: boolean;
}

export interface CanvasEdgeCreateInput {
  id?: CanvasEdgeId;
  source: CanvasNodeId;
  target: CanvasNodeId;
  style?: EdgeStyle;
}

export interface CanvasEdgeStylePatch {
  edge: CanvasEdgeRef;
  style: Partial<EdgeStyle>;
}

/**
 * Shared executable canvas command schema.
 *
 * Commands are explicit, JSON-serializable, and free of web-only gesture state.
 */
export type CanvasCommand =
  | {
      type: 'CREATE_NODES';
      nodes: CanvasNodeCreateInput[];
    }
  | { type: 'DELETE_NODES'; nodeIds: CanvasNodeId[] }
  | { type: 'MERGE_NODE_DATA'; patches: CanvasNodeDataMergePatch[] }
  | {
      type: 'SET_NODE_PARENT';
      nodeIds: CanvasNodeId[];
      parentId: CanvasNodeId | null;
    }
  | { type: 'DISSOLVE_FRAME'; frameId: CanvasNodeId }
  | { type: 'SET_NODE_GEOMETRY'; items: CanvasNodeGeometryUpdate[] }
  | {
      type: 'REORDER_NODES';
      nodeIds: CanvasNodeId[];
      to: 'top' | 'bottom' | { before: CanvasNodeId } | { after: CanvasNodeId };
    }
  | { type: 'CONNECT_NODES'; edges: CanvasEdgeCreateInput[] }
  | { type: 'DISCONNECT_EDGES'; edges: CanvasEdgeRef[] }
  | { type: 'SET_EDGE_STYLE'; edges: CanvasEdgeStylePatch[] }
  | {
      type: 'ALIGN_NODES';
      nodeIds: CanvasNodeId[];
      direction: CanvasAlignDirection;
    }
  | {
      type: 'DISTRIBUTE_NODES';
      nodeIds: CanvasNodeId[];
    }
  | {
      type: 'CREATE_QUESTION';
      id?: CanvasNodeId;
      /** The question text content. */
      content: string;
      /**
       * Top-left position. Honoured verbatim when provided; when omitted
       * the canvas picks a slot via force-directed `placeNode`.
       */
      position?: Point;
      size?: NodeSize;
      parentId?: CanvasNodeId | null;
    }
  | { type: 'SET_NODE_SELECTION'; nodeIds: CanvasNodeId[] }
  | { type: 'SET_EXPANDED_NODE'; nodeId: CanvasNodeId | null }
  | { type: 'SET_NODE_LOCKED'; items: CanvasNodeLockUpdate[] }
  | {
      /**
       * Convert a node between `text` and `note` types. UI-only — used by the
       * one-click toggle in the node toolbar after a paste lands in the
       * "wrong" container. Both types share a `content` string field, so the
       * conversion is loss-aware: switching `note` → `text` drops the
       * `provenance` field which is acceptable because users can undo if
       * the result is unwanted.
       */
      type: 'CHANGE_NODE_TYPE';
      nodeId: CanvasNodeId;
      to: 'text' | 'note';
    }
  | {
      /**
       * @deprecated No UI button, keyboard shortcut, or agent tool surface
       * emits this command anymore. The branch and its handler are retained
       * only so historical chat threads and any persisted commands keep
       * replaying. See `DEPRECATED_CANVAS_COMMAND_TYPES` below.
       */
      type: 'AUTO_LAYOUT';
      scope: CanvasAutoLayoutScope;
      options?: CanvasAutoLayoutOptions;
    };

export type CanvasCommandType = CanvasCommand['type'];

/**
 * Command types that are UI-only and excluded from the agent-facing schema.
 * These depend on ephemeral view state or user-controlled protection.
 */
export const UI_ONLY_CANVAS_COMMAND_TYPES = [
  'SET_NODE_LOCKED',
  'SET_NODE_SELECTION',
  'SET_EXPANDED_NODE',
  'CHANGE_NODE_TYPE',
] as const;
export type UiOnlyCanvasCommandType =
  (typeof UI_ONLY_CANVAS_COMMAND_TYPES)[number];

/**
 * Command types that remain executable for backwards compatibility but are
 * no longer surfaced to either the agent or the UI. New code must not emit
 * them; the handler implementations are retained only so historical chat
 * threads and any persisted commands keep rendering / replaying.
 */
export const DEPRECATED_CANVAS_COMMAND_TYPES = ['AUTO_LAYOUT'] as const;
export type DeprecatedCanvasCommandType =
  (typeof DEPRECATED_CANVAS_COMMAND_TYPES)[number];

/**
 * Subset of CanvasCommand available to the agent.
 * Excludes UI-only commands that depend on ephemeral frontend state, plus
 * any deprecated commands that are no longer exposed to callers.
 */
export type AgentCanvasCommand = Exclude<
  CanvasCommand,
  { type: UiOnlyCanvasCommandType | DeprecatedCanvasCommandType }
>;

export type AgentCanvasCommandType = AgentCanvasCommand['type'];

/**
 * Single source of truth for the set of command types the agent may issue.
 * The TypeBox schema in `apps/server/src/modules/agent/tools/definitions.ts`
 * derives its top-level `type` literals from this array, and the assertion
 * below guarantees the array stays in sync with the `AgentCanvasCommand`
 * union — if you add a new non-UI command to `CanvasCommand`, this will fail
 * to compile until you list it here (forcing an explicit decision about
 * whether to expose it to the agent).
 */
export const AGENT_CANVAS_COMMAND_TYPES = [
  'CREATE_NODES',
  'DELETE_NODES',
  'MERGE_NODE_DATA',
  'SET_NODE_PARENT',
  'DISSOLVE_FRAME',
  'SET_NODE_GEOMETRY',
  'REORDER_NODES',
  'CONNECT_NODES',
  'DISCONNECT_EDGES',
  'SET_EDGE_STYLE',
  'ALIGN_NODES',
  'DISTRIBUTE_NODES',
  'CREATE_QUESTION',
] as const satisfies readonly AgentCanvasCommandType[];

// Compile-time guard: `AGENT_CANVAS_COMMAND_TYPES` must list every
// `AgentCanvasCommandType`. The `satisfies` above catches extras; this
// assertion catches omissions.
type _AgentTypesEqualUnion =
  AgentCanvasCommandType extends (typeof AGENT_CANVAS_COMMAND_TYPES)[number]
    ? true
    : never;
const _agentTypesCheck: _AgentTypesEqualUnion = true;
void _agentTypesCheck;
