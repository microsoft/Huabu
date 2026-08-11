// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared canvas command schema executed by both the web client and agent flows.
 */

import type { EdgeStyle } from './edge.js';
import type { Point } from './layout.js';
import type {
  CanvasNodeType,
  FrameLayoutMode,
  FrameSizing,
  NodeData,
} from './node.js';
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

/**
 * Size accepted by `SET_NODE_GEOMETRY`.
 *
 * Widens {@link NodeSize} with `'auto'`, the explicit spelling of "hand
 * the height back to the renderer". It is not "unset": the engine records
 * `data.heightMode = 'auto'` and immediately materializes a concrete
 * number from the node's stored measurement hint, so `style.height` stays
 * usable for a node that has never rendered. Omitting `height` means the
 * same thing and is kept as a synonym for existing callers.
 *
 * Deliberately separate from {@link NodeSize}, which also describes stored
 * and default geometry where a non-numeric height would be meaningless.
 */
export interface NodeGeometrySize {
  width: number;
  height?: number | 'auto';
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
   * Top-left position of the new node, in **parent-local** coordinates:
   * relative to `parentId`'s frame, or absolute canvas coordinates when
   * there is no `parentId` (root-local == world). Always pass it
   * explicitly: the engine has no auto-placement, so an omitted position
   * silently falls back to `(0, 0)` (usually off-screen), it is not
   * rejected. UI callers (drag-drop, paste, toolbar placement,
   * group-into-frame, etc.) chose the slot themselves and already convert
   * to parent-local; agents must always emit an explicit position via the
   * `space_commands` schema.
   */
  position: Point;
  size?: NodeSize;
  parentId?: CanvasNodeId | null;
  /**
   * UI-only creation hint controlling create-time selection (honoured
   * only for a `source === 'ui'` gesture; a no-op for agent/system
   * creates, which never auto-select). Tri-state:
   *   - `false`   — never select (e.g. sketch freehand draw, so strokes
   *                 never pop a selection box mid-draw).
   *   - `true`    — always select, overriding the default `question`
   *                 exclusion (e.g. paste / duplicate).
   *   - omitted   — default: non-`question` nodes select, `question`
   *                 nodes do not.
   * Never persisted — a one-shot command input, not node data.
   */
  selectOnCreate?: boolean;
};

export type CanvasNodeCreateInput = {
  [T in CanvasNodeType]: CanvasNodeCreateInputByType<T>;
}[CanvasNodeType];

export type CanvasNodeDataMergePatch = {
  nodeId: CanvasNodeId;
  patch: Record<string, unknown>;
  /**
   * Optimistic-concurrency token: the node's authored-content revision
   * ({@link nodeRevision}) the writer last saw. Sibling of `patch` (never
   * merged into node data). The server compares it against the node's
   * current rev before applying a content rewrite and rejects on mismatch
   * (a human / another turn edited it since). Auto-injected server-side for
   * agent writes from the run's read-set; absent for ui / system writes,
   * which are unconditional.
   */
  expectRev?: string;
  /**
   * Optimistic-concurrency token for `interactiveView` replacement. Derived
   * from the complete persisted View Definition and never stored separately.
   */
  expectViewRev?: string;
};

export interface CanvasNodeParentUpdate {
  nodeIds: CanvasNodeId[];
  parentId: CanvasNodeId | null;
}

export interface CanvasNodeGeometryUpdate {
  nodeId: CanvasNodeId;
  /**
   * New top-left in **parent-local** coordinates (relative to the node's
   * current parent frame, or absolute for a root node). Matches the
   * coordinate space of `CanvasNodeCreateInput.position`.
   */
  position?: Point;
  size?: NodeGeometrySize;
}

export interface CanvasNodeLockUpdate {
  nodeId: CanvasNodeId;
  locked: boolean;
}

/**
 * A completed content measurement for one auto-height node.
 *
 * Derived data, not authored intent: it reports what the renderer found,
 * so it never enters undo history and never bumps `canvas.version`.
 */
export interface CanvasNodeMeasuredHeightUpdate {
  nodeId: CanvasNodeId;
  /**
   * Content height in px at the node type's reference width, before
   * width scaling and before node chrome.
   */
  intrinsicHeight: number;
  /**
   * The `AutoHeightKey` this measurement was taken under (see
   * `canvas-engine/height/freshness.ts`). Stored with the hint so a later
   * reader can prove whether it still describes the node's content.
   */
  measuredFor: string;
  /**
   * The measurement settled before its inputs did (undecoded images, a
   * timeout). Still far better than no footprint, but always re-measured
   * on the next load rather than trusted.
   */
  provisional?: boolean;
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

export interface PortalNodePinUpdate {
  sourceCanvasId: PrefixedId<'canvas'>;
  sourceNodeIds: CanvasNodeId[];
  pinned: boolean;
}

export interface PreparedPortalSourcePosition {
  sourceCanvasId: PrefixedId<'canvas'>;
  sourceNodeId: CanvasNodeId;
  position: Point;
}

export interface PreparedPortalNodePin {
  sourceCanvasId: PrefixedId<'canvas'>;
  sourceNodeId: CanvasNodeId;
  portalId: CanvasNodeId;
  nodeRefId: CanvasNodeId;
  referenceType?: 'nodeRef' | 'frameRef';
  parentRefId?: CanvasNodeId;
  position?: Point;
  size?: NodeSize;
  pinned: boolean;
}

export interface PreparedPortalNodePins {
  pins: PreparedPortalNodePin[];
  sourcePositions: PreparedPortalSourcePosition[];
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
  | { type: 'SET_NODE_SELECTION'; nodeIds: CanvasNodeId[] }
  | { type: 'SET_NODE_LOCKED'; items: CanvasNodeLockUpdate[] }
  | {
      /**
       * Apply a completed content measurement to auto-height nodes.
       *
       * Split from `SET_NODE_GEOMETRY` by authorship, not by value: a
       * geometry write says *who owns* the height, this one says *what it
       * currently is*. Its dominant trigger is a content edit, not a
       * preceding geometry command. Non-undoable and excluded from the
       * agent schema, because only a renderer can produce the input.
       *
       * Items targeting a node whose resolved height mode is not `auto`
       * are ignored rather than rejected — a measurement that lands after
       * the user pinned the node is stale, not invalid.
       */
      type: 'APPLY_MEASURED_HEIGHT';
      items: CanvasNodeMeasuredHeightUpdate[];
    }
  | {
      /**
       * Set a frame's child-layout mode. When switching into `column`,
       * `row` or `grid`, the engine assigns each child to a track and
       * resizes the frame to fit its content; when switching to `free`
       * children keep their current positions but the engine still
       * runs a final fit-to-content pass.
       *
       * `gridCount` is the track count: columns for `column` and
       * `grid`, rows for `row`. Clamped to [`FRAME_GRID_MIN_COUNT`,
       * `FRAME_GRID_MAX_COUNT`]. Naming it is an instruction to re-flow
       * into that many tracks. **Omit it when only changing `mode`** —
       * a mode change drops the stored count so the engine can derive
       * the track structure from the children's current geometry, and
       * passing a number chosen for the previous axis re-flows an
       * arrangement the caller did not mean to change.
       *
       * `sizing` toggles the frame's size policy independently of
       * `mode`. When omitted the previously-stored `sizing` is kept
       * (defaulting to `'hug'`). Note: PR 1 forbids `'manual'` sizing
       * when `mode` is `'column'` or `'row'`; the engine clamps the
       * combination back to `'hug'`.
       */
      type: 'SET_FRAME_LAYOUT';
      frameId: CanvasNodeId;
      mode: FrameLayoutMode;
      gridCount?: number;
      /**
       * Minimum row bands for `grid`. A floor, not an exact count:
       * rows below what the children require cannot be honoured, so
       * this only ever adds blank rows. Ignored by other modes.
       */
      gridRowCount?: number;
      sizing?: FrameSizing;
      /**
       * Optional cell assignments applied to direct children in the same
       * command. Structured frames derive every child position from its
       * cell, so a caller that cares where things land has to say so —
       * and saying it here rather than in a preceding `MERGE_NODE_DATA`
       * removes an ordering trap: the layout pass that runs at the end
       * of this batch already sees the assignments.
       *
       * `column` addresses columns, `row` addresses rows, and `grid`
       * addresses both; an index for an axis the mode does not have is
       * ignored.
       */
      cells?: Array<{
        nodeId: CanvasNodeId;
        column?: number;
        row?: number;
      }>;
    }
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
      type: 'SET_PORTAL_NODE_PINS';
      updates: PortalNodePinUpdate[];
    };

export type CanvasCommandType = CanvasCommand['type'];

/**
 * Server-owned representation passed to the shared handler after host
 * routing. It is deliberately not a member of the public CanvasCommand union.
 */
export type PreparedPortalNodePinsCommand = Extract<
  CanvasCommand,
  { type: 'SET_PORTAL_NODE_PINS' }
> & {
  prepared: PreparedPortalNodePins;
};

/**
 * Command types that are UI-only and excluded from the agent-facing schema.
 * These depend on ephemeral view state, user-controlled protection, or a
 * browser measurement the agent has no way to produce.
 */
export const UI_ONLY_CANVAS_COMMAND_TYPES = [
  'SET_NODE_LOCKED',
  'SET_NODE_SELECTION',
  'CHANGE_NODE_TYPE',
  'APPLY_MEASURED_HEIGHT',
] as const;
export type UiOnlyCanvasCommandType =
  (typeof UI_ONLY_CANVAS_COMMAND_TYPES)[number];

/**
 * Subset of CanvasCommand available to the agent.
 * Excludes UI-only commands that depend on ephemeral frontend state.
 */
export type AgentCanvasCommand = Exclude<
  CanvasCommand,
  { type: UiOnlyCanvasCommandType }
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
  'SET_FRAME_LAYOUT',
  'SET_PORTAL_NODE_PINS',
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
