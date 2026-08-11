// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import {
  ARTIFACT_DATA_FIELDS,
  collectMarkdownArtifactRefs,
  createId,
  markdownArtifactFields,
  parseArtifactRef,
  rewriteMarkdownArtifactRefs,
} from '@huabu/shared';
import {
  COMMAND_META,
  applyDeltas,
  applySharedPostEffectsFromWriteResult,
  executeCanvasCommands,
  computeFrameFit,
  FRAME_POINTER_CAPTURE_MARGIN,
  getAbsolutePosition as getFrameAbsolutePosition,
  getFrameSizing,
  wouldUnframe,
  wouldStickToStructuredFrame,
  wouldAutoFrame,
  readFrameGridConfig,
  resolveFrameTrackCount,
  solveStructuredFrameLayout,
  describeStructuredDropZone,
  getNodeSize,
  normalizeTreeOrder,
  type AlignDirection,
  type Delta,
  type ExecutorOptions,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import {
  runWebPostEffects,
  scheduleDeferredFrameRelayout,
} from '@/handler/canvasCommand/postEffects.web';
import {
  resolveUiIntent,
  type AddNodeInput,
  type CanvasUiIntent,
  type UiResolverState,
} from '@/handler/canvasCommand/uiIntent';
import {
  applySnap,
  beginSnapSession,
  clearDragDecisions,
  consumeLastDragDecisions,
  consumeLastDragReparentBypass,
  endSnapSession,
  getResizeContext,
  getResizeSnappedRect,
  isReparentBypassed,
  isSnapSessionActive,
  isSnapSessionDragEndCommit,
  isSnapSessionResizeEndCommit,
  setSnapStructuredSuppressed,
  writeDragDecision,
} from '@/handler/snap/snapSession';
import { i18n } from '@/i18n';

import {
  ApiError,
  getCanvas,
  getNodeContent,
  getWorldReferences,
  postCanvasExecute,
  putCanvas,
} from '../api';
import { canvasSyncTabId, createCanvasCommitGate } from './canvasCommitSync';
import { canvasHistoryManager } from './canvasHistoryManager';
import { useWorkspaceStore } from './workspaceStore';
import { agentApi } from '../api/agent';
import { cloneArtifactToCanvas, resolveArtifactUrl } from '../api/artifact';
import { CanvasConflictError } from '../api/canvas';
import { measureMissingAutoHeights } from './canvasStore/height/measureMissingAutoHeights';
import { createIntentActionWindow } from './canvasStore/intentActionWindow';
import { toast, dismissToast } from '../components/Common/Toast';
import { copyCanvasClipboard } from '../utils/io/clipboard';
import { nodesToPlainText } from '../utils/io/nodeToPlainText';
import { normalizeNodeHeights } from './canvasStore/load/normalizeNodeHeights';
import { reconcileQuestionStatus } from './canvasStore/load/reconcileQuestionStatus';
import { shouldBackfillNodeLabel } from './canvasStore/load/shouldBackfillNodeLabel';
import { warmupNodeHeights } from './canvasStore/load/warmupNodeHeights';
import { createCanvasEventBuffer } from './canvasStore/save/eventBuffer';
import {
  createNodeContentQueue,
  type NodeBaselineRebaseTicket,
} from './canvasStore/save/nodeContentQueue';
import {
  createNodeInvalidationTracker,
  retryTrackedInvalidation,
} from './canvasStore/save/nodeInvalidationTracker';
import { createPreprocessQueue } from './canvasStore/save/preprocessQueue';
import { overlayLocalFieldsOnStructureDeltas } from './canvasStore/save/structureDeltaOverlay';
import { shouldScheduleStructureSave } from './canvasStore/save/structureDirtyDetector';
import { stripNodeContentForStructurePut } from './canvasStore/save/structureNodePayload';
import { createStructureScheduler } from './canvasStore/save/structureScheduler';
import { createUnloadFlush } from './canvasStore/save/unloadFlush';
import { createResizePreviewController } from './canvasStore/slices/resizePreview';
import { useChatStore } from './chatStore';
import { useGesturePreviewStore } from './gesturePreviewStore';
import { useToolStore } from './toolStore';
import { seedNoteFixedHeight } from '../components/Nodes/note/autoHeight';
import { getNoteFixedHeight } from '../components/Nodes/note/heightMemory';
import {
  resumeHeightCommits,
  suspendHeightCommits,
} from '../components/Nodes/shared/height/commitSuspension';

import type {
  FrameFitPreview,
  FrameFitPreviewRole,
} from './gesturePreviewStore';
import type { NodeIngestionInfo } from '@/handler/canvasCommand/preprocess';
import type {
  AgentChatContext,
  CanvasCommand,
  CanvasCommandType,
  CanvasExecution,
  CanvasExecutionSource,
  CanvasNodeId,
  CanvasNodeMeasuredHeightUpdate,
  CanvasNodeType,
  CanvasViewport,
  IntentContext,
  Point,
  PortalNodePinUpdate,
  RecentAction,
  WireCanvasNode,
  WireSelectionNode,
  ResolvedWorldReference,
  CanvasCommitEvent,
  MutationAck,
  NodeChange,
} from '@huabu/shared';
import type { StructuredReflowEntry } from '@huabu/shared/canvas-engine';

const AUTOSAVE_DEBOUNCE_MS = 1000;
const PREPROCESS_DEBOUNCE_MS = 1000;
const NODE_CONTENT_DEBOUNCE_MS = 500;
const nodeRefTopologySignatures = new Map<string, string>();
let worldReferenceRefreshGeneration = 0;

function nodeRefTopologySignature(nodes: readonly Node[]): string {
  return JSON.stringify(
    nodes
      .filter((node) => node.type === 'nodeRef' || node.type === 'frameRef')
      .map((node) => {
        const target = (
          node.data as
            | { target?: { canvasId?: unknown; nodeId?: unknown } }
            | undefined
        )?.target;
        return [
          node.id,
          node.type,
          node.parentId ?? null,
          typeof target?.canvasId === 'string' ? target.canvasId : null,
          typeof target?.nodeId === 'string' ? target.nodeId : null,
        ];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

function isWorldReferenceTopologyDelta(delta: Delta): boolean {
  if (delta.type === 'INSERT_NODE' || delta.type === 'DELETE_NODE') {
    return delta.node.type === 'nodeRef' || delta.node.type === 'frameRef';
  }
  if (delta.type !== 'REPLACE_NODE') return false;
  return (
    nodeRefTopologySignature([delta.prev]) !==
    nodeRefTopologySignature([delta.next])
  );
}

/**
 * Arm a single undo snapshot for a gesture: snapshot the current state and
 * mark it as the gesture's snapshot so subsequent same-gesture writes fold
 * into it rather than each pushing their own entry. Shared by `beginGesture`
 * (caller-snapshot geometry gestures) and `beginNodeDataGesture`
 * (self-snapshotting data-edit bursts like the stroke-size slider): the two
 * differ only in WHEN they arm and how they release, not in the arming
 * itself — so that stays a single source of truth here.
 */
function armGestureSnapshot(nodes: Node[], edges: Edge[]): void {
  const pushed = canvasHistoryManager.takeSnapshot(nodes, edges);
  canvasHistoryManager.markGestureSnapshot(pushed);
}

// ─── Viewport localStorage ────────────────────────────────────────────────
//
// Pan + zoom is local UI state, not canvas data: persisting it server-side
// forced every device onto one view and made viewport movement bump the canvas
// version. localStorage keeps one last view per canvas across browser and
// desktop restarts without touching the server.

const viewportStorageKey = (canvasId: string) => `huabu.viewport.${canvasId}`;

function parseStoredViewport(raw: string | null): CanvasViewport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasViewport> | null;
    if (
      parsed &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y) &&
      Number.isFinite(parsed.zoom) &&
      (parsed.zoom as number) > 0
    ) {
      return {
        x: parsed.x as number,
        y: parsed.y as number,
        zoom: parsed.zoom as number,
      };
    }
  } catch {
    // Corrupt entries are treated as missing viewport state.
  }
  return null;
}

function readViewportFromStorage(canvasId: string): CanvasViewport | null {
  if (!canvasId) return null;
  flushViewportWrite();
  const key = viewportStorageKey(canvasId);

  try {
    return parseStoredViewport(localStorage.getItem(key));
  } catch {
    // Private mode / disabled storage falls back to fitView.
    return null;
  }
}

/**
 * Canvas-space point the user will be looking at once the restored
 * viewport is applied. A canvas with no stored viewport does a one-shot
 * `fitView` instead, so the origin is as good a guess as any.
 */
function viewportCentreOf(viewport: CanvasViewport | null): {
  x: number;
  y: number;
} {
  if (!viewport || viewport.zoom <= 0) return { x: 0, y: 0 };
  return {
    x: (window.innerWidth / 2 - viewport.x) / viewport.zoom,
    y: (window.innerHeight / 2 - viewport.y) / viewport.zoom,
  };
}

// Layout-driven viewport corrections (panel open/close compensation) arrive
// once per animation frame, so the write is debounced and only the settled
// viewport reaches `localStorage`. Reads and canvas switches flush first, so
// a pending write is never observed as stale or dropped.
const VIEWPORT_WRITE_DEBOUNCE_MS = 200;

let pendingViewportWrite: {
  canvasId: string;
  viewport: CanvasViewport;
} | null = null;
let viewportWriteTimer: ReturnType<typeof setTimeout> | null = null;

function flushViewportWrite(): void {
  if (viewportWriteTimer !== null) {
    clearTimeout(viewportWriteTimer);
    viewportWriteTimer = null;
  }
  const pending = pendingViewportWrite;
  pendingViewportWrite = null;
  if (!pending) return;
  try {
    localStorage.setItem(
      viewportStorageKey(pending.canvasId),
      JSON.stringify(pending.viewport),
    );
  } catch {
    // Viewport persistence must never block interaction.
  }
}

function writeViewportToStorage(
  canvasId: string,
  viewport: CanvasViewport,
): void {
  if (!canvasId) return;
  if (pendingViewportWrite && pendingViewportWrite.canvasId !== canvasId) {
    flushViewportWrite();
  }
  pendingViewportWrite = { canvasId, viewport };
  if (viewportWriteTimer !== null) clearTimeout(viewportWriteTimer);
  viewportWriteTimer = setTimeout(
    flushViewportWrite,
    VIEWPORT_WRITE_DEBOUNCE_MS,
  );
}

// ─── MiniMap-visibility localStorage ──────────────────────────────────────
//
// Whether the canvas MiniMap overlay is shown is a global UI preference
// (not per-canvas), so it uses a single localStorage key. Defaults to off so
// first-time users get the cleaner canvas; once toggled in Settings the choice
// survives refreshes / restarts.

const MINIMAP_STORAGE_KEY = 'huabu.minimapEnabled';

function readMinimapEnabledFromStorage(): boolean {
  try {
    return localStorage.getItem(MINIMAP_STORAGE_KEY) === 'true';
  } catch {
    // Private mode / disabled storage — treat as off.
    return false;
  }
}

function writeMinimapEnabledToStorage(value: boolean): void {
  try {
    localStorage.setItem(MINIMAP_STORAGE_KEY, String(value));
  } catch {
    // Ignore quota / private-mode errors; in-memory state still toggles.
  }
}

// ─── Version-conflict toast singleton ─────────────────────────────────
//
// `CANVAS_VERSION_CONFLICT` puts the store into a sticky `versionConflict`
// state that blocks every subsequent autosave until the canvas reloads.
// The accompanying toast must be persistent (no auto-fade) so the user
// doesn't keep editing while their writes silently no-op, but it also
// needs to disappear once the conflict is gone (canvas reload / switch)
// or once the user navigates away from this canvas (back to canvas
// list, into settings, etc.) — otherwise it leaks into routes where the
// stale baseline isn't relevant. We track the toast id at module scope
// instead of in zustand state because it's pure UI ephemera that no
// component subscribes to.

let _versionConflictToastId: string | null = null;

function showVersionConflictToast(): void {
  // Guard against duplicate toasts if `saveCanvas` somehow re-enters
  // the 409 branch before `versionConflict` flips true.
  if (_versionConflictToastId) return;
  _versionConflictToastId = toast(
    "This Space was modified elsewhere. Your recent edits won't be saved.",
    {
      tone: 'danger',
      duration: 0,
      action: {
        label: 'Reload',
        onClick: () => window.location.reload(),
      },
    },
  );
}

/**
 * Dismiss the persistent "canvas modified elsewhere" toast if it's
 * currently visible. Idempotent; safe to call when no toast is shown.
 *
 * Called from:
 *  - `loadCanvas` / `switchCanvas` — fresh baseline clears the warning.
 *  - `CanvasPage` unmount cleanup — leaving the canvas (e.g. back to
 *    list) shouldn't keep nagging the user about a canvas they're no
 *    longer editing.
 */
export function dismissVersionConflictToast(): void {
  if (_versionConflictToastId) {
    dismissToast(_versionConflictToastId);
    _versionConflictToastId = null;
  }
}

// ─── Per-node content flush ────────────────────────────────────────────────
//
// Markdown sidecar persistence (debounced per-node PUT + serialized
// in-flight chain) lives in `./canvasStore/save/nodeContentQueue.ts`.
// The queue factory call and structure-payload builder live in the save
// modules below so the create/ACK race stays independently testable.

type CommitPendingEffects = {
  mutatedNodes: Node[];
  deletedNodeIds: string[];
  contentEditedNodeIds: string[];
  deferredFitFrameIds: string[];
};

export type ConsumeCanvasCommitRequest =
  | {
      kind: 'event';
      commit: CanvasCommitEvent;
      pendingEffects?: CommitPendingEffects;
      /** Local structure generation captured by an HTTP request. */
      acknowledgedStructureGeneration?: number;
    }
  | {
      kind: 'ack';
      ack: MutationAck;
      /** Local structure generation captured when the request started. */
      acknowledgedStructureGeneration?: number;
    };

export type ConsumeCanvasCommitResult = {
  status: 'accepted' | 'duplicate' | 'stale' | 'invalid' | 'gap';
  skippedNodeIds: string[];
  /** A gap reload is safe only when no local structure/content is dirty. */
  shouldReload: boolean;
};

// ── Spatial data ──────────────────────────────────────────────
//
// The frontend no longer normalises spatial data for the LLM.
// `/api/agent` resolves the anchor node's neighbourhood server-side
// from persisted topology (see `apps/server/src/modules/agent/
// node-neighbourhood.ts`); the web bundle only sends `anchorNodeId`.
//
// Existing UI-side proximity queries (sketch clustering, frame
// drop targets) call shared geometry helpers directly with their own
// React Flow nodes — no central cache is needed.

type RFState = {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  version: number;
  /** Server CAS token for slim title/topology, independent of `version`. */
  structureRevision: string | null;
  /** Incremented for every local structural edit. */
  structureDirtyGeneration: number;
  /** Highest local generation acknowledged as durably committed. */
  structureSyncedGeneration: number;
  isLoading: boolean;
  canvasNotFound: boolean;
  worldReferences: Record<string, ResolvedWorldReference>;
  worldReferenceError: string | null;
  /**
   * Source-Space projection of World pin state: the ids of *this* canvas'
   * nodes that currently have a `nodeRef` / `frameRef` in the World.
   *
   * Populated only while an ordinary Space is active and the World feature
   * is enabled — the World canvas itself uses `worldReferences` instead.
   * Refreshed on the same boundaries as `worldReferences` (canvas load,
   * window focus, Pin/Unpin completion) per the World Canvas proposal's
   * boundary-driven freshness rule.
   */
  pinnedSourceNodeIds: Record<string, true>;
  refreshWorldReferences: () => Promise<void>;
  isSaving: boolean;
  pendingSave: boolean;

  /**
   * True when the server has rejected a save with `CANVAS_VERSION_CONFLICT`
   * (another tab / device / agent advanced the canvas behind our back).
   * While set, `saveCanvas` short-circuits so we don't pile up failing
   * autosaves on top of stale state. Cleared by `loadCanvas` once the
   * client is re-synced to the latest server snapshot.
   */
  versionConflict: boolean;

  /**
   * Apply a partial state update without triggering autosave or the
   * canUndo/canRedo sync. Reserved for acknowledging server-driven
   * updates (e.g. labels the server auto-deduped on save) and for
   * purely transient visual writes (ReactFlow internal change ticks,
   * agent entrance animations) that must not feed back into another
   * save. Accepts both an object partial and Zustand's functional
   * updater form, mirroring the wrapped `set`.
   */
  _setStateNoAutosave: (
    partial: Partial<RFState> | ((state: RFState) => Partial<RFState>),
  ) => void;

  canvasTitle: string;

  ingestionByNodeId: Record<string, NodeIngestionInfo>;
  setNodeIngestion: (nodeId: string, info: NodeIngestionInfo) => void;
  clearNodeIngestion: (nodeId: string) => void;

  /**
   * Thread ids whose server-side history fork (kicked off by pasting a
   * question node that already owns a conversation) is still in flight.
   * While a thread id is present here the copied node must not be opened:
   * its history hasn't finished copying server-side yet, so the chat
   * panel would load an empty conversation. Runtime-only, never persisted.
   */
  pendingForkThreadIds: Record<string, true>;

  expandedNodeId: string | null;
  expandMode: 'replace' | 'split';
  /**
   * Monotonic counter bumped on every `openExpanded` call —
   * including when the user re-triggers expansion on the
   * currently-expanded node. Preview components subscribe to this
   * tick so they can re-focus their editable surface when the user
   * double-clicks the same node a second time (the
   * `expandedNodeId` itself doesn't change in that case, so a
   * value-based subscriber would never re-fire).
   */
  expandedNodeFocusTick: number;
  openExpanded: (nodeId: string) => void;
  closeExpanded: () => void;
  setExpandMode: (mode: 'replace' | 'split') => void;

  pendingInlineEditNodeId: string | null;
  consumeInlineEditRequest: (nodeId: string) => void;

  collapsedFrameIds: Set<string>;
  toggleFrameCollapse: (frameId: string) => void;
  isFrameCollapsed: (frameId: string) => boolean;
  /**
   * Bulk-collapse or bulk-expand every frame/group on the canvas.
   * Drives the "collapse all / expand all" toolbar action in the
   * layer panel — purely a UI-state mutation (no canvas command,
   * no undo entry), mirroring single-frame {@link toggleFrameCollapse}.
   */
  setAllFramesCollapsed: (collapsed: boolean) => void;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onNodeDragStart: OnNodeDrag;
  onNodeDrag: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;
  /**
   * Cancel the active node drag without running drop/reparent resolution.
   * Restores the pre-drag positions and discards the gesture snapshot.
   */
  cancelActiveNodeDrag: () => void;
  /**
   * Tear down any drag-time snap state and detach the window-level
   * Alt listeners attached during `onNodeDragStart`. Idempotent.
   * Called from Canvas unmount to cover the path where the component
   * is destroyed mid-drag (route change, canvas swap) before React
   * Flow has a chance to fire `onNodeDragStop`. Without this, a
   * stranded pair of window listeners would survive the unmount.
   */
  endActiveDragSession: () => void;

  /**
   * Recompute the frame-fit preview while a child node is being
   * resized. Called on every resize tick from `NodeWrapper` so the
   * dashed overlay stays in sync with the handle. The actual fit
   * computation is coalesced via rAF so multiple high-frequency
   * onResize ticks become at most one fit-pass per paint. The result
   * is pushed to `gesturePreviewStore`. No-op when auto-layout is
   * disabled.
   */
  updateResizePreview: (nodeId: string) => void;

  /**
   * Cancel any pending resize-preview rAF and clear the dashed
   * overlay. Called from `NodeWrapper.handleResizeEnd` and from
   * Canvas unmount to guarantee the rAF closure (which captures the
   * latest store snapshot) doesn't fire after the gesture is over
   * and clobber the now-committed geometry with a stale fit. Mirror
   * of `endActiveDragSession` but scoped to the resize lifecycle.
   * Idempotent.
   */
  endResizePreview: () => void;

  addNodes: (inputs: AddNodeInput[]) => void;
  addNode: (input: AddNodeInput) => void;
  /** Atomic drag-MOVE: create `newNote` + overwrite source content in one undo entry. */
  moveNoteExcerpt: (input: {
    sourceNodeId: string;
    sourceContentAfterMove: string;
    newNote: AddNodeInput;
  }) => void;
  /**
   * Atomic cross-note drop-MOVE: in one undo entry, the source note
   * loses its dragged block (its content becomes
   * `sourceContentAfterMove`) and the target note adopts
   * `targetContentAfterInsert` (caller has already spliced the dragged
   * Markdown into the right position). For COPY semantics use
   * `updateNodeData` on the target alone — the source must not be
   * touched.
   */
  moveNoteBlockIntoNote: (input: {
    sourceNodeId: string;
    sourceContentAfterMove: string;
    targetNodeId: string;
    targetContentAfterInsert: string;
  }) => void;
  /**
   * Stroke-level split / cross-region move (Stage 4B). Pulls the given
   * strokes out of their source region(s) and re-homes them either into an
   * existing region (`targetNodeId`) or a brand-new region
   * (`targetNodeId === null`). Wrapped in one `beginNodeDataGesture` /
   * `endNodeDataGesture` bracket so the whole reorganisation — survivor
   * reflow, source deletion, and the new/merged region — collapses into a
   * single undo entry regardless of which command mix the resolver emits.
   */
  moveSketchStrokesToRegion: (input: {
    sources: Array<{ nodeId: string; strokeIds: string[] }>;
    dropDelta: { dx: number; dy: number };
    targetNodeId: string | null;
    dropPoint: { x: number; y: number };
  }) => void;
  deleteNodes: (nodeIds: string[]) => void;
  setPortalNodePins: (updates: PortalNodePinUpdate[]) => Promise<boolean>;
  disconnectEdges: (edgeIds: string[]) => void;
  setNodeGeometry: (
    items: Array<{
      nodeId: string;
      // `height: 'auto'` hands ownership back to the renderer; the
      // engine materializes a concrete number from the node's stored
      // measurement hint. Omitting it means the same thing.
      size?: { width: number; height?: number | 'auto' };
      position?: { x: number; y: number };
    }>,
  ) => void;
  /**
   * Live-preview variant of {@link setNodeGeometry} used during an
   * active resize gesture. Dispatches the same `RESIZE_NODE` intent
   * but re-arms the gesture-snapshot flag so subsequent dispatches in
   * the same gesture (further preview ticks AND the final commit
   * fired by `NodeWrapper.handleResizeEnd`) don't trigger the
   * executor's `snapshot:'caller' without beginGesture()` warning.
   * The undo snapshot was taken once at `onNodeResizeStart`; every
   * preview tick collapses into that single entry.
   */
  previewResizeGeometry: (
    items: Array<{
      nodeId: string;
      size?: { width: number; height?: number };
      position?: { x: number; y: number };
    }>,
  ) => void;
  /**
   * Capture the current positions / sizes of a frame's direct
   * children so {@link applyFrameResizeScale} can scale them
   * proportionally during the resize gesture. No-op for non-frame
   * nodes; replaces any prior snapshot.
   */
  captureFrameResizeSnapshot: (frameId: string) => void;
  /**
   * Scale the children captured by
   * {@link captureFrameResizeSnapshot} to match the frame's new
   * dimensions. Dispatches a single `RESIZE_NODE` batch covering the
   * frame and all snapped children via {@link previewResizeGeometry}.
   * The frame's new local top-left (`x`, `y`) is part of the batch
   * so non-BR-corner handle drags pin the frame's origin in the
   * same dispatch as the children's scaled positions, rather than
   * depending on a separate `onNodesChange` snap-mirror to commit
   * it. For structured (column/row) frames the grid solver re-packs
   * the scaled children; for free frames the scaled positions stick.
   * No-op if no snapshot is active.
   */
  applyFrameResizeScale: (
    width: number,
    height: number,
    x: number,
    y: number,
  ) => void;
  /**
   * Synchronously commit any rAF-coalesced scale tick still pending
   * from {@link applyFrameResizeScale}. Called at gesture end before
   * {@link clearFrameResizeSnapshot} so the trailing child-scaling
   * frame isn't dropped by the per-paint throttle. No-op when nothing
   * is queued.
   */
  flushFrameResizeScale: () => void;
  /** Clear the resize snapshot at the end of the gesture. */
  clearFrameResizeSnapshot: () => void;
  /**
   * Flip note nodes between fixed (pinned) and auto-fit (content-driven)
   * height in a single shared code path.
   *
   * Single-source-of-truth for the toggle so the corner "show all content"
   * affordance on NoteNode, the single-select toolbar, and the multi-select
   * toolbar can never silently diverge (previous duplication had each
   * entry point reimplementing this with slightly different behaviour —
   * e.g. only some sites deferred a parent-frame refit).
   *
   * - `mode: 'auto'`  → clears the explicit height. Parent frames shrink
   *   to the new content height after the Milkdown editor reflows; the
   *   deferred refit is queued by the `SET_NODE_GEOMETRY` post-effect,
   *   so this action stays a single dispatch with no rAF dance of its
   *   own.
   * - `mode: 'fixed'` → pins height via `seedNoteFixedHeight`, reading
   *   the most recently observed pinned height from the shared
   *   `noteHeightMemory` module so a "collapse → expand → collapse"
   *   round-trip restores the previous fixed size instead of snapping
   *   to the current rendered measurement.
   *
   * Non-note ids and ids whose width can't be resolved are silently
   * skipped. The whole batch is wrapped in one `SET_NODE_GEOMETRY`
   * gesture so it collapses into a single undo entry.
   */
  setNoteHeightMode: (nodeIds: string[], mode: 'auto' | 'fixed') => void;
  /**
   * Apply completed content measurements to auto-height nodes.
   *
   * Derived geometry, not user intent: the batch takes no undo snapshot
   * and needs no `beginGesture`. Items targeting a node the user has
   * since pinned are dropped by the handler rather than rejected here.
   *
   * Callers pass an intrinsic height (measured at the node type's
   * reference width, excluding chrome) together with the
   * `AutoHeightKey` it was measured under, so a later reader can tell
   * whether it still describes the node's content.
   */
  applyMeasuredHeights: (items: CanvasNodeMeasuredHeightUpdate[]) => void;
  /** Take a pre-resize snapshot so the final SET_NODE_GEOMETRY can be undone. */
  onNodeResizeStart: () => void;
  rfInstance: ReactFlowInstance | null;
  setRfInstance: (instance: ReactFlowInstance | null) => void;

  /**
   * The outer `<div>` that wraps `<ReactFlow>`. Stored so non-component
   * code paths (UI intent resolvers, dispatcher helpers) can read the
   * canvas pane's bounding rect — currently used by `dispatchUiIntent`
   * to compute the flow-space viewport centre for nodes added without
   * an explicit `placementPoint` (e.g. "Add as note" buttons in chat
   * messages or the floating drag handle).
   *
   * Set by `<Canvas>` once the wrapper ref is attached; cleared on
   * unmount. `null` while the canvas DOM is not mounted.
   */
  canvasWrapper: HTMLDivElement | null;
  setCanvasWrapper: (el: HTMLDivElement | null) => void;

  /**
   * Current pan + zoom of the React Flow viewport.
   *
   * `null` means "no saved viewport yet" — on initial load that triggers a
   * one-shot `fitView`. After the user pans or zooms, `onMoveEnd` writes
   * the new viewport here through {@link setViewport}, which also
   * mirrors it into `localStorage` (per-canvas) so reopening the browser or
   * desktop app lands back at the same view without going through the server.
   */
  viewport: CanvasViewport | null;
  /**
   * Record a new viewport. Called from `<ReactFlow onMoveEnd>` after the
   * user finishes panning/zooming. Writes to `localStorage` directly;
   * does NOT participate in the structure autosave (`viewport` is not
   * one of the persisted fields tracked by
   * `./canvasStore/save/structureDirtyDetector.ts`).
   */
  setViewport: (viewport: CanvasViewport) => void;

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
  /** Convert a `text` node to a `note` node or vice-versa (preserves content; undoable). */
  convertNodeType: (nodeId: string, to: 'text' | 'note') => void;

  /**
   * @internal Signal the start of a continuous gesture (drag, resize) that will
   * end with a command of the given type. If `COMMAND_META[commandType]`
   * has `snapshot: 'caller'`, an undo snapshot is taken now so the
   * entire gesture collapses into a single undo entry.
   * Use `onNodeDragStart` / `onNodeResizeStart` instead of calling directly.
   */
  beginGesture: (commandType: CanvasCommandType) => void;

  /**
   * Bracket a burst of live `updateNodeData` edits (e.g. dragging the
   * stroke-size slider, whose `onChange` fires every tick) into a SINGLE
   * undo entry. `beginNodeDataGesture` snapshots the pre-edit state once
   * and arms the gesture flag; the per-tick `MERGE_NODE_DATA` writes then
   * fold into it instead of each self-snapshotting. `endNodeDataGesture`
   * releases the flag on pointer-up / cancel. Unlike `beginGesture` this
   * works for `snapshot: 'yes'` commands (which self-snapshot), so it is
   * the right bracket for data edits rather than geometry gestures.
   */
  beginNodeDataGesture: () => void;
  /** Release the {@link beginNodeDataGesture} bracket. */
  endNodeDataGesture: () => void;

  /** Align selected nodes along an axis. */
  alignSelectedNodes: (direction: AlignDirection) => void;
  /** Spread apart overlapping selected nodes (frame children stay in their frame). */
  spreadSelectedNodes: () => void;

  /** MiniMap: whether the React Flow MiniMap overlay is visible. */
  minimapEnabled: boolean;
  toggleMinimap: () => void;

  moveNodeIntoFrame: (
    nodeId: string,
    frameId: string,
    reorderTarget?: { nodeId: string; position: 'before' | 'after' },
  ) => void;
  moveNodeOutOfFrame: (
    nodeId: string,
    reorderTarget?: { nodeId: string; position: 'before' | 'after' },
  ) => void;

  copySelectedNodes: () => void;
  pasteNodes: (
    flowPosition: { x: number; y: number },
    clipboardNodes: Node[],
    clipboardEdges?: Edge[],
    srcCanvasId?: string,
  ) => void;

  /** Undo / Redo */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;

  loadCanvas: (
    canvasId?: string,
    options?: { resetHistory?: boolean; preserveLocalChanges?: boolean },
  ) => Promise<void>;
  switchCanvas: (canvasId: string) => Promise<void>;
  /**
   * Persist the canvas structure (geometry, parenthood, edges).
   * Pass `{ keepalive: true }` from the `beforeunload` flush so the
   * request survives the page close. Per-node content (markdown,
   * label, src, summary, …) is stripped before sending — it rides
   * the per-node content PUT, not this one. Viewport is intentionally
   * excluded: it lives in local UI storage.
   *
   * `force` bypasses the in-flight coalescing guard (which normally
   * defers a concurrent save into `pendingSave`). The `beforeunload`
   * flush sets it so the latest in-store geometry is pushed even when
   * a regular (non-keepalive) PUT is already mid-flight — that
   * in-flight request gets killed by the browser on unload, so we
   * can't rely on it landing.
   */
  saveCanvas: (options?: {
    keepalive?: boolean;
    force?: boolean;
  }) => Promise<void>;

  /**
   * Attempt to rename a canvas or node, with collision detection.
   *
   * - `kind: 'canvas'` commits the title to the server immediately;
   *   on a backend 409 (`CANVAS_TITLE_CONFLICT`) the previous title is
   *   restored and an alert is shown.
   * - `kind: 'node'` performs a local case-insensitive sibling check
   *   first; on conflict an alert is shown and the call returns false
   *   without dispatching any state change. Otherwise the node label
   *   is updated as a user-sourced rename.
   *
   * Returns `true` when the rename was accepted, `false` on conflict.
   */
  tryRename: (
    kind: 'canvas' | 'node',
    id: string,
    nextName: string,
  ) => Promise<boolean>;

  /** @internal Execute a batch of shared CanvasCommands. Do not call from outside the store. */
  executeCommands: (
    commands: CanvasCommand[],
    source?: CanvasExecutionSource,
    options?: Pick<ExecutorOptions, 'frozenStructuredGutters'>,
  ) => void;
  /**
   * @internal Apply a server-authored delta batch (M2 headless executor).
   *
   * Bypasses the local engine — the server has already executed the
   * commands, persisted topology and content, and given us the
   * structural diff to apply. We still snapshot for undo, drive the
   * web-only post-effects (preprocessing trigger, AI-edit flag, etc.),
   * and reconcile our local `version` to `toVersion` so the next
   * autosave PUTs against the right baseline.
   *
   * Skips autosave (uses `_setStateNoAutosave`) because the server is
   * already authoritative for this batch.
   *
   * Returns the ids of nodes whose incoming REPLACE/DELETE delta was
   * SKIPPED because the user is mid-editing them (un-persisted local
   * content edits). Callers surface these as a
   * conflict on the originating thread's change card.
   */
  applyDeltasFromAgent: (
    deltas: Delta[],
    toVersion: number,
    pendingEffects: {
      mutatedNodes: Node[];
      deletedNodeIds: string[];
      contentEditedNodeIds: string[];
      deferredFitFrameIds: string[];
    },
  ) => string[];
  /** Version-gated entry point shared by HTTP acks and SSE commits. */
  consumeCommit: (
    request: ConsumeCanvasCommitRequest,
  ) => ConsumeCanvasCommitResult;
  /**
   * Ids of nodes with un-persisted local content edits (pending debounced
   * save or in-flight PUT). Exposed so the sync store can avoid a blind
   * `loadCanvas` on a version gap that would clobber a mid-edit (C3).
   */
  pendingContentNodeIds: () => string[];
  /** @internal Resolve a web-only UiIntent and execute the resulting commands. */
  dispatchUiIntent: (intent: CanvasUiIntent) => void;
  /**
   * Build the slim context attached to every chat-agent request.
   *
   * Only carries `selectedNodes` — full canvas / spatial / recent
   * action data is fetched on demand by the agent through tools
   * (`get_canvas_outline`, `inspect_nodes`, `inspect_edges`, `read`).
   */
  getAgentChatContext: () => AgentChatContext;
  /**
   * Build the rich context consumed by the intent recogniser.
   *
   * Carries the full canvas snapshot (nodes + edges), the recent
   * action ring buffer, the user selection, and (when available) a
   * viewport screenshot — the recogniser is a one-shot LLM call and
   * cannot pull data through tools.
   */
  getIntentContext: () => IntentContext;

  /**
   * Force-flush any buffered behavioural events to the server.
   *
   * Call this immediately before kicking off an agent or intent
   * request so the server-side action log is current when it builds
   * the request context. Resolves once the in-flight POST settles
   * (success or fail); a failed flush is retried on the next trigger.
   */
  flushCanvasEvents: () => Promise<void>;
};

/**
 * Module-scoped structure-save scheduler. Owns the debounce timer
 * for `PUT /api/canvas/:id`; the actual save action lives on the
 * store slice (`saveCanvas`) because it touches OCC state.
 *
 * `getSaveCanvas` is a lazy getter so the scheduler always picks up
 * the freshest closure (matters for HMR and for tests that swap the
 * store).
 */
const structureScheduler = createStructureScheduler({
  getSaveCanvas: () => useCanvasStore.getState().saveCanvas,
  delayMs: AUTOSAVE_DEBOUNCE_MS,
});

/** Shared ordering/dedupe gate for both mutation responses and broadcasts. */
const canvasCommitGate = createCanvasCommitGate<ConsumeCanvasCommitRequest>();

/** Prevent an older invalidate GET from overwriting a later inline/delete. */
const nodeInvalidationTracker = createNodeInvalidationTracker();
/** Commit post-effects waiting for an authoritative inline/GET projection. */
const pendingCommitPreprocessVersions = new Map<string, number>();
/** Latest authoritative load owns every post-await store mutation. */
let canvasLoadGeneration = 0;
let safeReloadInFlight: { canvasId: string; promise: Promise<boolean> } | null =
  null;

function scheduleExplicitStructureSave(): void {
  const state = useCanvasStore.getState();
  state._setStateNoAutosave({
    structureDirtyGeneration: state.structureDirtyGeneration + 1,
  });
  structureScheduler.schedule();
}

function consumeMutationPublication(
  canvasId: string,
  response: { commit?: CanvasCommitEvent; ack?: MutationAck },
): void {
  const state = useCanvasStore.getState();
  // Node/preprocess requests can settle after navigation. Their publication
  // belongs to the captured Space, never the newly active store cursor.
  if (state.canvasId !== canvasId) return;
  let consumed: ConsumeCanvasCommitResult | undefined;
  if (response.commit) {
    consumed = state.consumeCommit({ kind: 'event', commit: response.commit });
  } else if (response.ack) {
    consumed = state.consumeCommit({ kind: 'ack', ack: response.ack });
  }
  if (consumed?.shouldReload) {
    void reloadCanvasWhenSafe(canvasId);
  }
}

function reorderByCanonicalIds<T extends { id: string }>(
  values: readonly T[],
  ids: readonly string[] | undefined,
): T[] {
  if (!ids) return values as T[];
  const byId = new Map(values.map((value) => [value.id, value]));
  const ordered: T[] = [];
  for (const id of ids) {
    const value = byId.get(id);
    if (!value) continue;
    ordered.push(value);
    byId.delete(id);
  }
  ordered.push(...byId.values());
  return ordered;
}

function projectionPatch(
  change: Extract<NodeChange, { kind: 'inline' }>,
): Record<string, unknown> {
  const projection = change.projection;
  return {
    label: projection.label,
    content: projection.content,
    labelSource: projection.labelSource,
    src: projection.src,
    summary: projection.summary,
    keywords: projection.keywords,
    provenance: projection.provenance,
    contentMissing: projection.contentMissing ?? false,
    artifactMissing: projection.artifactMissing ?? false,
    contentDuplicate: projection.contentDuplicate ?? false,
    duplicateFiles: projection.duplicateFiles ?? [],
  };
}

async function refreshInvalidatedNode(
  canvasId: string,
  nodeId: string,
  recordRevision: string,
  commitVersion: number,
  baselineRebaseTicket?: NodeBaselineRebaseTicket,
): Promise<void> {
  const invalidationTicket = nodeInvalidationTracker.begin(
    nodeId,
    recordRevision,
    commitVersion,
  );
  try {
    const response = await retryTrackedInvalidation({
      tracker: nodeInvalidationTracker,
      ticket: invalidationTicket,
      fetch: () => getNodeContent(canvasId, nodeId),
    });
    if (!nodeInvalidationTracker.consume(invalidationTicket)) return;
    if (!response || useCanvasStore.getState().canvasId !== canvasId) return;

    const responseMatchesCommit =
      response.recordRevision === undefined ||
      response.recordRevision === recordRevision;
    const preserveLocalBody =
      baselineRebaseTicket !== undefined ||
      nodeContentQueue.pendingNodeIds().includes(nodeId);
    if (preserveLocalBody) {
      // Local-first keeps the editor body, but the skipped remote write still
      // advanced the server CAS. Serialize behind any older local PUT, adopt
      // only the exact fetched rev, then retry the preserved body on top.
      const rebaseTicket =
        baselineRebaseTicket ?? nodeContentQueue.beginBaselineRebase(nodeId);
      pendingCommitPreprocessVersions.delete(nodeId);
      await nodeContentQueue.completeBaselineRebase(
        canvasId,
        rebaseTicket,
        response.rev,
      );
      return;
    }

    // A later commit may have landed while the fetch was in flight. When the
    // endpoint proves that happened, leave the newer local view untouched.
    if (!responseMatchesCommit) return;

    const current = useCanvasStore.getState();
    let refreshed: Node | undefined;
    const nodes = current.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      refreshed = {
        ...node,
        type: response.type,
        data: {
          ...(node.data ?? {}),
          label: response.label,
          content: response.content,
          labelSource: response.labelSource,
          src: response.src,
          summary: response.summary,
          keywords: response.keywords,
          contentMissing: response.contentMissing ?? false,
          artifactMissing: response.artifactMissing ?? false,
          contentDuplicate: response.contentDuplicate ?? false,
          duplicateFiles: response.duplicateFiles ?? [],
        },
      };
      return refreshed;
    });
    if (!refreshed) return;
    current._setStateNoAutosave({ nodes });
    nodeContentQueue.seedBaselines([refreshed]);
    releasePendingCommitPreprocess(nodeId, commitVersion);
  } finally {
    if (baselineRebaseTicket) {
      nodeContentQueue.cancelBaselineRebase(baselineRebaseTicket);
    }
  }
}

// ─── Outgoing event buffer ────────────────────────────────────────────────
//
// Every `RecentAction` produced by a UI intent / undo / redo is mirrored
// into this in-memory buffer (keyed by canvasId) and uploaded to the
// server via `POST /api/canvas/:id/events` on three triggers:
//
//   1. Autosave piggy-back — `saveCanvas` flushes after a successful save
//      so events ride the same 1s debounce as canvas state.
//   2. Pre-agent flush     — `flushCanvasEvents` is called immediately
//      before any agent / intent request so the server-side action log
//      is up to date before the request builds context from it.
//   3. Page unload         — a `beforeunload` listener fires a
//      `keepalive` POST so the trailing tail is not lost.
//
// The buffer drains on success and is *kept* on failure, so a transient
// network blip doesn't lose events — the next flush trigger retries.
//
// Per-batch caps mirror the server (200 events; the 64 KB body cap is
// enforced server-side via Fastify's `bodyLimit`).

/**
 * Module-scoped action-log event buffer. Accumulates `RecentAction`
 * events produced by UI intents / undo / redo and is drained by
 * external triggers (structure-save piggy-back, pre-agent flush,
 * `beforeunload` keepalive POST).
 */
const canvasEvents = createCanvasEventBuffer();

/**
 * Module-scoped per-node markdown sidecar save queue. Coalesces rapid
 * editor edits into one PUT per node and serializes in-flight writes
 * so the server never sees two PUTs for the same node concurrently.
 */
const nodeContentQueue = createNodeContentQueue({
  delayMs: NODE_CONTENT_DEBOUNCE_MS,
  getState: () => useCanvasStore.getState(),
  onMutationCommit: (canvasId, commit) =>
    consumeMutationPublication(canvasId, { commit }),
  onMutationAck: (canvasId, ack) =>
    consumeMutationPublication(canvasId, { ack }),
});

/**
 * Module-scoped per-node preprocessing queue. Each store mutation
 * that affects a markdown-backed node schedules a debounced
 * `preprocessNode` POST through this queue. New-node work is held until the
 * node-content queue observes the aggregate structure-create ACK.
 */
const preprocessQueue = createPreprocessQueue({
  delayMs: PREPROCESS_DEBOUNCE_MS,
  getState: () => useCanvasStore.getState(),
  shouldDeferNode: (nodeId) =>
    nodeContentQueue.isAggregateCreatePending(nodeId),
  originator: { source: 'ui', tabId: canvasSyncTabId },
  onMutationResponse: consumeMutationPublication,
});

function releasePendingCommitPreprocess(
  nodeId: string,
  throughVersion: number,
): void {
  const pendingVersion = pendingCommitPreprocessVersions.get(nodeId);
  if (pendingVersion === undefined || pendingVersion > throughVersion) return;
  pendingCommitPreprocessVersions.delete(nodeId);
  const node = useCanvasStore
    .getState()
    .nodes.find((candidate) => candidate.id === nodeId);
  if (node) preprocessQueue.schedule(node);
}

function forgetNodePersistence(nodeId: string): void {
  pendingCommitPreprocessVersions.delete(nodeId);
  nodeInvalidationTracker.cancelThrough(nodeId, Number.MAX_SAFE_INTEGER);
  nodeContentQueue.forgetNode(nodeId);
  preprocessQueue.forgetNode(nodeId);
}

/**
 * Promote every pending canvas-level structure save AND every pending
 * debounced per-node content save into an immediate flush, then
 * resolve once both have settled.
 *
 * Called from `CanvasPage` via `useBlocker` so that navigating away
 * from a canvas (back to list, into settings, into docs, into another
 * canvas) holds the navigation until every queued PUT has been sent
 * and its response received. Without this, trailing edits would fire
 * later under a stale captured `canvasId` — by which time the user
 * has moved on and there's nothing left in the store to revert if the
 * PUT fails. Failures inside the drain are surfaced through each
 * queue's own `handleSaveFailure` (toast + console.error) and do NOT
 * reject this promise — the navigation should always proceed even if
 * a save failed, because keeping the user trapped on the canvas
 * doesn't help.
 *
 * Order mirrors {@link switchCanvas}: structure first (canvas-level
 * version PUT), then per-node content. The two queues touch disjoint
 * server resources, so the order is purely for consistency with the
 * canvas-switch path.
 */
export async function drainPendingSaves(): Promise<void> {
  await structureScheduler.flushAsync();
  while (
    useCanvasStore.getState().isSaving ||
    useCanvasStore.getState().pendingSave
  ) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useCanvasStore.subscribe((state) => {
        if (!state.isSaving && !state.pendingSave) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  await nodeContentQueue.flushAll();
}

/**
 * Heal an unrecoverable publication gap without discarding local-first work.
 * All pending writes drain before the snapshot begins; a failed/conflicting
 * drain leaves the current canvas untouched for explicit user recovery.
 */
export function reloadCanvasWhenSafe(canvasId: string): Promise<boolean> {
  if (safeReloadInFlight?.canvasId === canvasId) {
    return safeReloadInFlight.promise;
  }
  const promise = (async (): Promise<boolean> => {
    await drainPendingSaves();
    const state = useCanvasStore.getState();
    if (state.canvasId !== canvasId || state.versionConflict) return false;
    if (
      state.structureDirtyGeneration !== state.structureSyncedGeneration ||
      state.pendingContentNodeIds().length > 0
    ) {
      return false;
    }
    await state.loadCanvas(canvasId, {
      resetHistory: true,
      preserveLocalChanges: true,
    });
    return true;
  })().finally(() => {
    if (safeReloadInFlight?.promise === promise) safeReloadInFlight = null;
  });
  safeReloadInFlight = { canvasId, promise };
  return promise;
}

/**
 * Reset the per-node duplicate-toast guard. Called when a node's
 * duplicate-sidecar collision was resolved on disk and confirmed via
 * the node's Refresh button (which does not go through a successful
 * save, so it can't clear the guard itself). Without this a later
 * duplicate on the same node would be silently swallowed.
 */
export function clearNodeDuplicateGuard(nodeId: string): void {
  nodeContentQueue.clearDuplicateGuard(nodeId);
}

/**
 * Trigger preprocessing for a single node once the user has finished
 * editing it (exit-edit "settle").
 *
 * Called for editor-authored nodes (`note` / `text`) from their exit-edit
 * boundaries — `closeExpanded` / `openExpanded` for `note` and `TextNode`'s
 * blur handler for `text` — whose auto-derived label (the on-disk `.md`
 * filename) must be committed only when the heading is settled, never on
 * every keystroke pause, which churned the filename through every partial
 * heading (`Note 1.md` → `H.md` → `He.md` → …). Their per-keystroke content
 * edits are excluded from the `triggerPreprocessing` fan-out in
 * `runWebPostEffects` (only one-time create / duplicate / import mutations
 * still fan out there), so this exit-edit call is their sole preprocessing
 * trigger for content edits. The body itself keeps saving on the fast
 * per-node content cadence (`nodeContentQueue`) independently. See
 * `docs/architecture/node-preprocessing.md` §4 (Triggers & state).
 */
export function settleNodePreprocess(nodeId: string): void {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  if (node) preprocessQueue.schedule(node);
}

// ─── Action-history ring ──────────────────────────────────────────────────
//
// The short, in-memory action trail (cap 10, no timestamps) that
// rides on agent / intent request bodies. Deliberately kept OUTSIDE
// the Zustand store: no React component subscribes to it, but a
// store-resident field would force `dispatchUiIntent` to fire a
// *second* `set({ actionHistory })` right after `executeCommands`
// already committed nodes/edges. That second commit makes every
// remaining store subscriber re-run its selector for a value none of
// them care about — wasted work on every UI click.
//
// The full server-bound action log still flows through `canvasEvents`
// (see above); this window is read exactly once per intent request
// via `getIntentContext`. See `intentActionWindow.ts` for the
// memory-pipeline cleanup path that will eventually delete it.
const intentActionWindow = createIntentActionWindow();

/**
 * Module-scoped resize-preview controller. Owns the rAF handle and
 * the free-frame child snapshot used during resize gestures; the
 * store exposes its methods as actions (`previewResizeGeometry`,
 * `updateResizePreview`, …) so consumers keep using the existing
 * `useCanvasStore(state => state.previewResizeGeometry)` API.
 */
const resizePreviewController = createResizePreviewController({
  getState: () => {
    const state = useCanvasStore.getState();
    return {
      nodes: state.nodes,
      edges: state.edges,
      dispatchUiIntent: state.dispatchUiIntent,
      patchNodeSilent: state.patchNodeSilent,
    };
  },
});

// Module-scoped singleton listener: intentionally registered once at module
// load time and never removed. Safe for this app's single-page lifecycle.
// All keepalive drains live in `./canvasStore/save/unloadFlush.ts`.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'beforeunload',
    createUnloadFlush({
      events: canvasEvents,
      nodeContent: nodeContentQueue,
      preprocess: preprocessQueue,
      structure: structureScheduler,
      getSaveCanvas: () => useCanvasStore.getState().saveCanvas,
      hasUnsavedStructure: () => {
        const s = useCanvasStore.getState();
        // A version conflict means the server already rejected us and
        // further PUTs are pointless (and would 409). Treat as "nothing
        // recoverable to flush".
        if (s.versionConflict) return false;
        return s.isSaving || s.pendingSave;
      },
    }),
  );
}

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
        // Gate the structure autosave on a real structural diff so pure
        // content edits do not schedule a redundant structure PUT — they
        // ride their own versioned node commit instead. See
        // `./canvasStore/save/structureDirtyDetector.ts`.
        if (shouldScheduleStructureSave(prev, next)) {
          // Raw `set` avoids recursively running this middleware. The two
          // generations let realtime commits distinguish a clean structure
          // from unsaved or in-flight local geometry/title edits.
          (set as (partial: Partial<RFState>) => void)({
            structureDirtyGeneration: next.structureDirtyGeneration + 1,
          });
          structureScheduler.schedule();
        }
        // --- Per-node content diff ---
        // Independent of the structure autosave so editor edits flush
        // on their own (faster) debounce and do not dirty structureRevision.
        if (prev.nodes !== next.nodes) {
          nodeContentQueue.scheduleChanges(
            next.canvasId,
            prev.nodes,
            next.nodes,
          );
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

    const baseState = config(wrappedSet, get, api);
    // Inject a raw setter that skips both autosave scheduling AND the
    // canUndo/canRedo sync. Use this when the store is acknowledging
    // server-driven updates that should not feed back into another save.
    return {
      ...baseState,
      _setStateNoAutosave: (partial) => {
        (set as (p: typeof partial) => void)(partial);
      },
    };
  };

// rAF handle for throttling the heavy preview computation inside onNodeDrag.
// Keeping it outside the store avoids stale-closure issues and lets
// onNodeDragStop cancel any pending frame reliably.
let _dragPreviewRafId: number | null = null;

// Pre-drag node positions captured on `onNodeDragStart`, keyed by id.
// Used by `onNodeDragStop` to decide whether a drag actually moved a
// node and therefore needs a structure save. This is required because
// live drag ticks commit positions through `_setStateNoAutosave` (to
// avoid running the dirty detector at 60 fps), and the drag-stop
// resolver only emits a `SET_NODE_GEOMETRY` command when a frame /
// parent change is involved — so a plain free-node move produces no
// command and would otherwise never schedule the autosave PUT.
let _dragStartPositions: Map<string, { x: number; y: number }> | null = null;

// Resize-preview state (per-paint rAF coalescing + free-frame child
// baseline snapshot) lives in `./canvasStore/slices/resizePreview.ts`.
// The store wires the controller's methods directly into the action
// surface below; `endActiveDragSession` calls `cancelPendingRaf` to
// tear down the rAF when the canvas unmounts mid-resize.

/**
 * Smart-snap drag-time state lives in a dedicated module
 * (`handler/snap/snapSession`) rather than on this store. Reasoning:
 *
 *   • No React component subscribes to the candidate index, bypass
 *     flag, etc. — they're consumed exclusively by the callbacks
 *     below (`onNodeDragStart`, `onNodesChange`, `onNodeDragStop`).
 *     Pushing them through Zustand `set/get` would only churn the
 *     autosave middleware many times per frame.
 *   • The visible part — alignment guides — already lives in
 *     `gesturePreviewStore`, which IS subscribed by the SVG overlay.
 *     That split is intentional: render state belongs in Zustand,
 *     transient engine working memory does not.
 *
 * The store interacts with the session via four entry points:
 *   `beginSnapSession`, `endSnapSession`, `applySnap`,
 *   `isSnapSessionDragEndCommit`.
 */

/**
 * Build a recursive `WireSelectionNode` factory bound to the current
 * node list (so `frame` nodes can resolve their direct children).
 *
 * Only sends lightweight metadata — the agent uses `read` to fetch
 * full content on demand, saving tokens. Image nodes keep `src` so
 * the server can build vision attachments.
 *
 * Layout (`position` / `size`) and provenance (`origin`) are
 * deliberately omitted: the server consumes neither. Spatial info is
 * fetched on demand via `get_canvas_outline()` / `inspect_nodes`.
 */
function makeBuildSelectedDetail(
  allNodes: Node[],
): (n: Node) => WireSelectionNode {
  const build = (n: Node): WireSelectionNode => {
    const data = n.data as Record<string, unknown> | undefined;
    const nodeType = (n.type ?? 'note') as CanvasNodeType;

    // Only keep src for image nodes (needed for vision analysis).
    const src =
      n.type === 'image' ? (data?.src as string | undefined) : undefined;

    const detail: WireSelectionNode = {
      id: n.id,
      type: nodeType,
      label: data?.label as string | undefined,
      ...(src !== undefined ? { src } : {}),
    };

    if (n.type === 'frame') {
      const children = allNodes
        .filter((child) => child.parentId === n.id)
        .map(build);
      if (children.length > 0) detail.children = children;
    }

    return detail;
  };
  return build;
}

const useCanvasStore = create<RFState>()(
  autoSaveMiddleware((set, get) => ({
    nodes: [],
    edges: [],
    canvasId: '',
    version: 0,
    structureRevision: null,
    structureDirtyGeneration: 0,
    structureSyncedGeneration: 0,
    isLoading: false,
    canvasNotFound: false,
    worldReferences: {},
    worldReferenceError: null,
    pinnedSourceNodeIds: {},
    isSaving: false,
    pendingSave: false,
    versionConflict: false,

    refreshWorldReferences: async () => {
      const generation = ++worldReferenceRefreshGeneration;
      const canvasId = get().canvasId;
      const { worldCanvasId, worldEnabled } = useWorkspaceStore.getState();
      const isWorld = canvasId !== '' && canvasId === worldCanvasId;
      // Source Spaces only need pin state while the World feature is on;
      // `worldCanvasId` is workspace metadata that exists either way.
      if (!canvasId || (!isWorld && (!worldEnabled || !worldCanvasId))) {
        get()._setStateNoAutosave({
          worldReferences: {},
          worldReferenceError: null,
          pinnedSourceNodeIds: {},
        });
        return;
      }
      try {
        const response = await getWorldReferences(
          isWorld ? canvasId : (worldCanvasId as string),
        );
        if (
          get().canvasId !== canvasId ||
          generation !== worldReferenceRefreshGeneration
        ) {
          return;
        }
        if (!isWorld) {
          // Derive which of this Space's nodes are pinned by filtering the
          // World's references down to the ones targeting this canvas.
          const pinnedSourceNodeIds: Record<string, true> = {};
          for (const reference of response.references) {
            if (reference.kind === 'canvasRef') continue;
            if (reference.target.canvasId !== canvasId) continue;
            pinnedSourceNodeIds[reference.target.nodeId] = true;
          }
          get()._setStateNoAutosave({
            worldReferences: {},
            worldReferenceError: null,
            pinnedSourceNodeIds,
          });
          return;
        }
        get()._setStateNoAutosave({
          worldReferences: Object.fromEntries(
            response.references.map((reference) => [
              reference.referenceNodeId,
              reference,
            ]),
          ),
          worldReferenceError: null,
          pinnedSourceNodeIds: {},
        });
      } catch (error) {
        if (
          get().canvasId !== canvasId ||
          generation !== worldReferenceRefreshGeneration
        ) {
          return;
        }
        if (!isWorld) {
          // A failed source-side probe only costs pin affordances; it is not
          // the World's broken-reference banner state.
          get()._setStateNoAutosave({ pinnedSourceNodeIds: {} });
          return;
        }
        get()._setStateNoAutosave({
          worldReferences: {},
          worldReferenceError:
            error instanceof Error ? error.message : String(error),
          pinnedSourceNodeIds: {},
        });
      }
    },

    // Placeholder — the autoSaveMiddleware injects the real raw setter
    // that bypasses autosave scheduling. Calling it before middleware has
    // wrapped the store would be a programmer error, so fall back to the
    // wrapped `set` (which still works, just without the suppression).
    _setStateNoAutosave: (partial) =>
      (set as (p: typeof partial) => void)(partial),

    canvasTitle: '',

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

    pendingForkThreadIds: {},

    expandedNodeId: null,
    expandMode: 'split',
    expandedNodeFocusTick: 0,
    openExpanded: (nodeId) => {
      // Switching straight from one expanded node to another does not fire
      // `closeExpanded`, so settle the outgoing authored node here to
      // commit its auto-derived label (the `.md` filename). See
      // `docs/architecture/node-preprocessing.md` §4 (Triggers & state).
      const prev = get().expandedNodeId;
      if (prev && prev !== nodeId) {
        const prevNode = get().nodes.find((n) => n.id === prev);
        if (prevNode?.type === 'note' || prevNode?.type === 'text') {
          settleNodePreprocess(prev);
        }
      }
      get().dispatchUiIntent({ type: 'EXPAND_NODE', nodeId });
      // Bump the focus tick AFTER the intent resolves so any
      // already-mounted preview re-focuses its editor on a
      // repeat double-click. On the first expansion the tick is
      // bumped before the preview mounts, but the preview's
      // first-render effect compares against a sentinel ref and
      // still triggers focus.
      set((s) => ({ expandedNodeFocusTick: s.expandedNodeFocusTick + 1 }));
    },
    closeExpanded: () => {
      // Exit-edit "settle" for editor-authored nodes: a `note` (and a
      // `text` edited in the panel) is authored in the expanded editor, so
      // closing it (X / Esc / back) is the real "done editing" boundary at
      // which the auto-derived label (the `.md` filename) should be
      // committed — never on every keystroke pause. See
      // `docs/architecture/node-preprocessing.md` §4 (Triggers & state).
      const { expandedNodeId, nodes } = get();
      if (expandedNodeId) {
        const node = nodes.find((n) => n.id === expandedNodeId);
        if (node?.type === 'note' || node?.type === 'text') {
          settleNodePreprocess(expandedNodeId);
        }
      }
      set({ expandedNodeId: null });
    },
    setExpandMode: (mode) => set({ expandMode: mode }),

    pendingInlineEditNodeId: null,
    consumeInlineEditRequest: (nodeId) => {
      if (get().pendingInlineEditNodeId !== nodeId) return;
      set({ pendingInlineEditNodeId: null });
    },

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
    setAllFramesCollapsed: (collapsed) => {
      if (!collapsed) {
        // Expand-all: drop every entry in a single write.
        if (get().collapsedFrameIds.size === 0) return;
        set({ collapsedFrameIds: new Set<string>() });
        return;
      }
      // Collapse-all: gather every frame/group id from the live nodes.
      const next = new Set<string>();
      for (const n of get().nodes) {
        if (n.type === 'frame' || n.type === 'group') next.add(n.id);
      }
      // Skip the set() if nothing would change (avoids a useless render).
      const current = get().collapsedFrameIds;
      if (next.size === current.size) {
        let identical = true;
        for (const id of next) {
          if (!current.has(id)) {
            identical = false;
            break;
          }
        }
        if (identical) return;
      }
      set({ collapsedFrameIds: next });
    },

    // -----------------------------------------------------------------------
    // Action history & agent context
    // -----------------------------------------------------------------------

    // --- Internal: not exposed in the public CanvasStore interface ---

    /** Execute a batch of shared CanvasCommands. Source defaults to 'ui'. */
    executeCommands: (commands, source, options) => {
      const resolvedSource = source ?? 'ui';
      const execution: CanvasExecution = {
        source: resolvedSource,
        commands,
      };
      const state = {
        nodes: get().nodes,
        edges: get().edges,
        canvasId: get().canvasId,
      };

      const { writeResult, commandResults, pendingEffects } =
        executeCanvasCommands(execution, state, {
          ...options,
          // Agent batches must always refit parent frames because the
          // LLM cannot accurately predict rendered dimensions.
          forceFitFrames: resolvedSource === 'agent',
        });

      // Only commit if at least one command was applied.
      if (!commandResults.some((r) => r.applied)) return;

      // Guard: verify that 'caller' snapshot commands were preceded by beginGesture.
      // Skip for agent-originated commands (no UI gesture involved).
      const hasCallerSnapshot = commands.some(
        (c) => COMMAND_META[c.type].snapshot === 'caller',
      );
      // Whether this gesture already took its pre-mutation undo snapshot
      // via `beginGesture` (captured BEFORE the consume below clears the
      // flag). A single user gesture must map to a single undo entry, so
      // once `beginGesture` has snapshotted we must NOT let this batch's
      // `auto`-snapshot commands push a second, redundant snapshot. A drag
      // stop, for example, may emit a mix of `SET_NODE_GEOMETRY` (caller)
      // plus `SET_NODE_PARENT` / grid-reorder / relayout (`auto`) commands
      // — all one gesture, one undo entry (the `beginGesture` snapshot).
      const gestureAlreadySnapshotted =
        resolvedSource !== 'agent' && canvasHistoryManager.gestureSnapshotTaken;
      if (hasCallerSnapshot && resolvedSource !== 'agent') {
        if (!canvasHistoryManager.gestureSnapshotTaken) {
          console.warn(
            '[canvasStore] snapshot:"caller" command executed without beginGesture():',
            commands.map((c) => c.type).join(', '),
          );
        }
        canvasHistoryManager.consumeGestureSnapshot();
      }

      // Take undo snapshot if needed (before committing new state), unless
      // the gesture already snapshotted itself via beginGesture (see above).
      if (writeResult.snapshotNeeded && !gestureAlreadySnapshotted) {
        canvasHistoryManager.takeSnapshot(state.nodes, state.edges);
      }

      // Apply pure host-agnostic post-commit cleanups (today: edge
      // handle reroute) BEFORE the state commit so they fold into a
      // single set() call instead of triggering a second render.
      const sharedOut = applySharedPostEffectsFromWriteResult(writeResult);

      // Commit new state in one shot.
      set({
        nodes: writeResult.nodes,
        edges: sharedOut.edges,
      });

      // Drain web-only effects (preprocessing trigger, delete
      // tracking, AI flag, transition cleanup, deferred frame fit).
      runWebPostEffects({
        effects: pendingEffects,
        canvasId: state.canvasId,
        getNodes: () => get().nodes,
        getEdges: () => get().edges,
        setNodes: (nodes) => set({ nodes }),
        triggerPreprocessing: preprocessQueue.schedule,
        forgetNodeContent: forgetNodePersistence,
        deleteMutationOptions: {
          originator: { source: 'ui', tabId: canvasSyncTabId },
          onResponse: consumeMutationPublication,
        },
      });
    },

    /**
     * Apply a server-authored delta batch (M2 headless executor).
     *
     * Differs from `executeCommands` in three ways:
     *   1. No engine execution — we replay `deltas` directly via the
     *      shared `applyDeltas` helper.
     *   2. No autosave — server is already authoritative for this
     *      batch; commit via `_setStateNoAutosave` and reconcile
     *      local `version` to `toVersion` so the NEXT user edit's
     *      autosave PUTs against the right baseline.
     *   3. Ordinary agent batches snapshot for undo. Portal Pin/Unpin clears
     *      history because protected reference topology cannot be restored by
     *      the legacy full-state snapshot boundary.
     */
    applyDeltasFromAgent: (deltas, toVersion, pendingEffects) => {
      // Never let an incoming agent write clobber a
      // node the user is mid-editing. Skip REPLACE/DELETE deltas that
      // target a node with un-persisted local content edits (INSERT is a
      // fresh id, never a collision). Report the skipped ids so the UI
      // can flag the conflict on the originating thread's change card.
      const dirty = new Set(nodeContentQueue.pendingNodeIds());
      const skippedNodeIds: string[] = [];
      const skippedRemoteNodes: Node[] = [];
      const skippedDeletedNodeIds: string[] = [];
      const safeDeltas =
        dirty.size === 0
          ? deltas
          : deltas.filter((d) => {
              if (d.type === 'REPLACE_NODE' && dirty.has(d.next.id)) {
                skippedNodeIds.push(d.next.id);
                skippedRemoteNodes.push(d.next as unknown as Node);
                return false;
              }
              if (d.type === 'DELETE_NODE' && dirty.has(d.node.id)) {
                skippedNodeIds.push(d.node.id);
                skippedDeletedNodeIds.push(d.node.id);
                return false;
              }
              return true;
            });

      // Local-first rebase for a node the user is mid-editing: we keep their
      // in-memory version (skipped above) but adopt the agent's just-written
      // revision as the save baseline. The user's next autosave then rebases
      // on top (expectRev = agent's rev) and cleanly overwrites the agent's
      // version, instead of tripping a false NODE_CONTENT_CONFLICT against a
      // change the local-first policy already decided the user wins. The
      // "your version was kept" notice tells the user what happened; the
      // change-review card lets them inspect the agent's dropped edit.
      if (skippedRemoteNodes.length > 0) {
        nodeContentQueue.seedBaselines(skippedRemoteNodes);
      }
      let armedAggregateRecreate = false;
      for (const nodeId of skippedDeletedNodeIds) {
        armedAggregateRecreate =
          nodeContentQueue.markAggregateRecreate(nodeId) ||
          armedAggregateRecreate;
      }
      if (armedAggregateRecreate) scheduleExplicitStructureSave();

      if (safeDeltas.length === 0) {
        // Nothing to apply locally (empty batch, or every row protected).
        // Still reconcile the version so the next local edit's autosave
        // doesn't 409 against our stale view of server state.
        if (get().version !== toVersion) {
          get()._setStateNoAutosave({ version: toVersion });
        }
        return skippedNodeIds;
      }

      const prevNodes = get().nodes;
      const prevEdges = get().edges;
      const canvasId = get().canvasId;

      // Pin/Unpin uses a dedicated cross-Canvas command and cannot be
      // faithfully restored by replaying a generic topology snapshot: a
      // resurrected nodeRef would be rejected by the server ownership guard.
      // Its product-level inverse is another Pin/Unpin operation.
      const isPortalPinMutation = safeDeltas.some(
        isWorldReferenceTopologyDelta,
      );
      if (isPortalPinMutation) {
        canvasHistoryManager.clear();
      } else {
        canvasHistoryManager.takeSnapshot(prevNodes, prevEdges);
      }

      // Replay the structural diff. The shared helper tolerates
      // missing targets (REPLACE/DELETE against an already-absent
      // node/edge) so out-of-order delivery in future broadcast
      // scenarios fails open.
      const applied = applyDeltas(
        { nodes: prevNodes as NestableNode[], edges: prevEdges },
        safeDeltas,
      );

      // No host-agnostic post-effects here — the server already ran
      // `applySharedPostEffectsFromWriteResult` before computing the
      // diff, so any reroute is folded into the delta payload.

      // Re-establish the parent-before-child + frame-child zIndex invariant.
      // `applyDeltas` replays coarse deltas through an insertion-ordered
      // `Map`, so a reparent (REPLACE_NODE keeps the child's old slot) or a
      // frame created in the same batch (INSERT_NODE appended last) can leave
      // a child ahead of its parent — React Flow then throws "Parent node not
      // found". This delta-replay path bypasses the server executor entirely,
      // so we normalize here at the client state-producer boundary.
      const orderedNodes = normalizeTreeOrder(applied.nodes as NestableNode[]);
      nodeRefTopologySignatures.set(
        canvasId,
        nodeRefTopologySignature(orderedNodes as Node[]),
      );

      get()._setStateNoAutosave({
        nodes: orderedNodes as Node[],
        edges: applied.edges as Edge[],
        version: toVersion,
        ...(isPortalPinMutation ? { canUndo: false, canRedo: false } : {}),
      });

      // Re-seed the content-CAS baseline for the nodes this agent write
      // actually applied. Skipped mid-edit nodes had their baseline adopted
      // to the agent's rev above (local-first rebase), so exclude them here
      // to avoid clobbering that with their own unchanged local content.
      {
        const skippedSet = new Set(skippedNodeIds);
        nodeContentQueue.seedBaselines(
          (applied.nodes as Node[]).filter((n) => !skippedSet.has(n.id)),
        );
      }

      // Post-effects must not run for nodes whose delta we skipped — they
      // were not actually mutated locally, so preprocessing / fit them is
      // wrong.
      const skipped = new Set(skippedNodeIds);
      runWebPostEffects({
        effects: {
          mutatedNodes:
            skipped.size === 0
              ? pendingEffects.mutatedNodes
              : pendingEffects.mutatedNodes.filter((n) => !skipped.has(n.id)),
          deletedNodeIds:
            skipped.size === 0
              ? pendingEffects.deletedNodeIds
              : pendingEffects.deletedNodeIds.filter((id) => !skipped.has(id)),
          contentEditedNodeIds:
            skipped.size === 0
              ? pendingEffects.contentEditedNodeIds
              : pendingEffects.contentEditedNodeIds.filter(
                  (id) => !skipped.has(id),
                ),
          deferredFitFrameIds: pendingEffects.deferredFitFrameIds,
        },
        canvasId,
        getNodes: () => get().nodes,
        getEdges: () => get().edges,
        setNodes: (nodes) => get()._setStateNoAutosave({ nodes }),
        triggerPreprocessing: preprocessQueue.schedule,
        forgetNodeContent: forgetNodePersistence,
        deleteMutationOptions: {
          originator: { source: 'ui', tabId: canvasSyncTabId },
          onResponse: consumeMutationPublication,
        },
      });

      return skippedNodeIds;
    },

    consumeCommit: (request) => {
      const before = get();
      const decision = canvasCommitGate.consume(
        request.kind === 'event'
          ? {
              kind: 'event',
              commit: request.commit,
              localTabId: canvasSyncTabId,
              context: request,
            }
          : { kind: 'ack', ack: request.ack, context: request },
        {
          version: before.version,
          structureRevision: before.structureRevision,
          structureDirtyGeneration: before.structureDirtyGeneration,
          structureSyncedGeneration: before.structureSyncedGeneration,
        },
      );

      const cancelSupersededInvalidations = (
        commit: CanvasCommitEvent,
      ): void => {
        for (const change of commit.nodeChanges) {
          if (change.kind !== 'invalidate') {
            nodeInvalidationTracker.cancelThrough(
              change.nodeId,
              commit.toVersion,
            );
          }
        }
      };
      if (request.kind === 'event' && decision.kind !== 'invalid') {
        // This also runs for a duplicate SSE event whose HTTP ack won first.
        // The full event is still newer than an invalidate GET it supersedes.
        cancelSupersededInvalidations(request.commit);
      }

      const acknowledgeStructureGeneration = (
        generation: number | undefined,
      ): void => {
        if (generation === undefined) return;
        const current = get();
        current._setStateNoAutosave({
          structureSyncedGeneration: Math.max(
            current.structureSyncedGeneration,
            generation,
          ),
        });
      };

      // Even when SSE won the race and deduped the later HTTP response, the
      // response still tells us exactly which local structure generation it
      // made durable. A gap does too: only its local application is deferred.
      if (
        request.acknowledgedStructureGeneration !== undefined &&
        decision.kind !== 'invalid'
      ) {
        acknowledgeStructureGeneration(request.acknowledgedStructureGeneration);
      }

      if (decision.kind !== 'accepted') {
        return {
          status: decision.kind,
          skippedNodeIds: [],
          // Ordinary Phase 4 gaps stay buffered until their predecessor
          // arrives. Capacity overflow is different: one ordered publication
          // was evicted, so only an authoritative snapshot can close the hole.
          shouldReload:
            decision.kind === 'gap' && decision.requiresReload === true,
        };
      }

      const skippedNodeIds = new Set<string>();

      const applyCommitNodeChanges = (
        commitVersion: number,
        nodeChanges: readonly NodeChange[],
      ): void => {
        if (nodeChanges.length === 0) return;
        const dirty = new Set(nodeContentQueue.pendingNodeIds());
        const state = get();
        let nodes = state.nodes;
        let changed = false;
        const baselines: Node[] = [];
        let armedAggregateRecreate = false;

        for (const change of nodeChanges) {
          if (dirty.has(change.nodeId)) {
            skippedNodeIds.add(change.nodeId);
            pendingCommitPreprocessVersions.delete(change.nodeId);
            if (change.kind === 'inline') {
              const rebaseTicket = nodeContentQueue.beginBaselineRebase(
                change.nodeId,
              );
              void nodeContentQueue
                .completeBaselineRebase(
                  state.canvasId,
                  rebaseTicket,
                  change.projection.rev,
                )
                .catch(() => undefined);
            } else if (change.kind === 'invalidate') {
              // Fetch the authoritative projection so we can advance only its
              // exact CAS rev while preserving the user's in-editor body.
              const rebaseTicket = nodeContentQueue.beginBaselineRebase(
                change.nodeId,
              );
              void refreshInvalidatedNode(
                state.canvasId,
                change.nodeId,
                change.recordRevision,
                commitVersion,
                rebaseTicket,
              ).catch(() => undefined);
            } else if (change.kind === 'delete') {
              // The user wins this conflict. Recreate topology + sidecar in one
              // aggregate commit; a standalone content PUT would be suppressed
              // by the server's durable delete tombstone.
              armedAggregateRecreate =
                nodeContentQueue.markAggregateRecreate(change.nodeId) ||
                armedAggregateRecreate;
            }
            continue;
          }
          if (change.kind === 'invalidate') {
            void refreshInvalidatedNode(
              state.canvasId,
              change.nodeId,
              change.recordRevision,
              commitVersion,
            ).catch(() => undefined);
            continue;
          }
          // Topology deletion is replayed through structureDeltas. Applying
          // it again here would bypass the existing dirty-node protection.
          if (change.kind === 'delete') {
            pendingCommitPreprocessVersions.delete(change.nodeId);
            continue;
          }

          nodes = nodes.map((node) => {
            if (node.id !== change.nodeId) return node;
            const next: Node = {
              ...node,
              type: change.projection.type,
              data: {
                ...(node.data ?? {}),
                ...projectionPatch(change),
              },
            };
            baselines.push(next);
            changed = true;
            return next;
          });
        }

        if (changed) {
          get()._setStateNoAutosave({ nodes });
          nodeContentQueue.seedBaselines(baselines);
        }
        if (armedAggregateRecreate) scheduleExplicitStructureSave();
      };

      for (const accepted of decision.accepted) {
        const acceptedRequest =
          accepted.input.context ??
          (accepted.input.kind === 'event'
            ? ({
                kind: 'event',
                commit: accepted.input.commit,
              } satisfies ConsumeCanvasCommitRequest)
            : ({
                kind: 'ack',
                ack: accepted.input.ack,
              } satisfies ConsumeCanvasCommitRequest));
        const commit =
          accepted.input.kind === 'event' ? accepted.input.commit : undefined;
        if (commit) cancelSupersededInvalidations(commit);

        // Only an HTTP request carries the exact local generation it made
        // durable. A delayed/buffered optimistic SSE echo cannot be matched
        // safely to whichever structure save happens to be in flight when it
        // is eventually drained (that may already be a newer generation).
        const acknowledgedStructureGeneration =
          acceptedRequest.acknowledgedStructureGeneration;
        acknowledgeStructureGeneration(acknowledgedStructureGeneration);

        const effects =
          acceptedRequest.kind === 'event'
            ? (acceptedRequest.pendingEffects ?? {
                mutatedNodes: [],
                deletedNodeIds: [],
                contentEditedNodeIds: [],
                deferredFitFrameIds: [],
              })
            : {
                mutatedNodes: [],
                deletedNodeIds: [],
                contentEditedNodeIds: [],
                deferredFitFrameIds: [],
              };
        const commitPreprocessNodeIds = new Set<string>();
        if (commit && accepted.apply !== 'none') {
          const contentEdited = new Set(effects.contentEditedNodeIds);
          for (const node of effects.mutatedNodes) {
            if (
              (node.type === 'note' || node.type === 'text') &&
              contentEdited.has(node.id)
            ) {
              continue;
            }
            commitPreprocessNodeIds.add(node.id);
            pendingCommitPreprocessVersions.set(
              node.id,
              Math.max(
                pendingCommitPreprocessVersions.get(node.id) ?? 0,
                commit.toVersion,
              ),
            );
          }
        }

        if (commit && accepted.apply === 'structure') {
          // Durable commit effects carry canonical slim nodes. Defer their
          // preprocess fan-out until nodeChanges (or invalidate GETs) have
          // supplied authoritative sidecar fields.
          const nonPreprocessEffects = { ...effects, mutatedNodes: [] };
          const structureDeltas = overlayLocalFieldsOnStructureDeltas(
            commit.structureDeltas as Delta[],
            get().nodes,
          );
          for (const nodeId of get().applyDeltasFromAgent(
            structureDeltas,
            commit.toVersion,
            nonPreprocessEffects,
          )) {
            skippedNodeIds.add(nodeId);
            pendingCommitPreprocessVersions.delete(nodeId);
          }
          applyCommitNodeChanges(commit.toVersion, commit.nodeChanges);
          const afterApply = get();
          afterApply._setStateNoAutosave({
            nodes: normalizeTreeOrder(
              reorderByCanonicalIds(
                afterApply.nodes,
                commit.nodeOrder,
              ) as NestableNode[],
            ) as Node[],
            edges: reorderByCanonicalIds(afterApply.edges, commit.edgeOrder),
            ...(commit.title !== undefined
              ? { canvasTitle: commit.title ?? 'Untitled' }
              : {}),
            version: accepted.cursor.version,
            structureRevision: accepted.cursor.structureRevision,
          });
        } else if (commit && accepted.apply === 'nodes') {
          applyCommitNodeChanges(commit.toVersion, commit.nodeChanges);
          get()._setStateNoAutosave({
            version: accepted.cursor.version,
            structureRevision: accepted.cursor.structureRevision,
          });
        } else {
          get()._setStateNoAutosave({
            version: accepted.cursor.version,
            structureRevision: accepted.cursor.structureRevision,
          });
        }

        if (commit) {
          const changesByNodeId = new Map(
            commit.nodeChanges.map((change) => [change.nodeId, change]),
          );
          for (const nodeId of commitPreprocessNodeIds) {
            if (skippedNodeIds.has(nodeId)) {
              pendingCommitPreprocessVersions.delete(nodeId);
              continue;
            }
            const change = changesByNodeId.get(nodeId);
            if (change?.kind === 'invalidate') continue;
            if (change?.kind === 'delete') {
              pendingCommitPreprocessVersions.delete(nodeId);
              continue;
            }
            releasePendingCommitPreprocess(nodeId, commit.toVersion);
          }
        }
      }

      return {
        status: 'accepted',
        skippedNodeIds: [...skippedNodeIds],
        shouldReload: false,
      };
    },

    pendingContentNodeIds: () => nodeContentQueue.pendingNodeIds(),

    /** Resolve a web-only UiIntent and execute the resulting commands. */
    dispatchUiIntent: (intent) => {
      const { rfInstance, canvasWrapper } = get();
      // Compute the viewport centre in flow coordinates so resolvers can
      // anchor "no placement point" additions to the visible area. The
      // shared engine no longer ships a layout fallback, so resolvers
      // default to `(0, 0)` when neither a placement point nor a viewport
      // centre is available (initial boot before React Flow registers).
      let viewportCenter: Point | undefined;
      if (rfInstance && canvasWrapper) {
        const rect = canvasWrapper.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          viewportCenter = rfInstance.screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
        }
      }
      const uiState: UiResolverState = {
        nodes: get().nodes,
        edges: get().edges,
        ...(viewportCenter ? { viewportCenter } : {}),
      };
      const execution = resolveUiIntent(intent, uiState);
      const editNodeId = execution.editNodeId;
      const editTargetAlreadyExists =
        editNodeId !== undefined &&
        uiState.nodes.some(({ id }) => id === editNodeId);
      if (execution.commands.length > 0) {
        get().executeCommands(
          execution.commands,
          undefined,
          intent.type === 'RESIZE_NODE' && intent.preview
            ? {
                frozenStructuredGutters: intent.frozenStructuredGutters,
              }
            : undefined,
        );
      }
      if (editNodeId !== undefined && !editTargetAlreadyExists) {
        const node = get().nodes.find(({ id }) => id === editNodeId);
        if (node?.type === 'note') {
          // Inline the settle-previous + expand + focus-tick sequence
          // instead of calling `openExpanded(node.id)` on purpose:
          // `openExpanded` re-enters `dispatchUiIntent` with an
          // `EXPAND_NODE` intent, which would (a) recurse through the
          // resolver in the middle of this `ADD_NODES` dispatch, and
          // (b) record an `EXPAND_NODE` gesture in the recent-action
          // window / event buffer that the user never performed —
          // polluting the context handed to the agent. Opening the
          // editor here is a silent side effect of creation, so it must
          // not emit its own intent event.
          const previousId = get().expandedNodeId;
          if (previousId && previousId !== node.id) {
            const previousNode = get().nodes.find(
              ({ id }) => id === previousId,
            );
            if (
              previousNode?.type === 'note' ||
              previousNode?.type === 'text'
            ) {
              settleNodePreprocess(previousId);
            }
          }
          set((state) => ({
            expandedNodeId: node.id,
            expandedNodeFocusTick: state.expandedNodeFocusTick + 1,
          }));
        } else if (node?.type === 'text') {
          set({ pendingInlineEditNodeId: node.id });
        }
      }
      // Apply UI-only state mutations (e.g. expand-overlay toggle) that
      // bypass the command pipeline.
      if (execution.expandedNodeId !== undefined) {
        set({ expandedNodeId: execution.expandedNodeId });
      }
      // Push trace from intent resolution to the module-scoped
      // window and mirror into the server-bound event buffer. Both
      // are store-external on purpose — no Zustand subscriber
      // observes them, so writing them through `set` would only
      // cost every other selector a re-run per click.
      //
      // Transient gesture-preview ticks (rAF-coalesced live resize)
      // set `preview: true`: their commands already ran above so the
      // grid solver re-flows during the drag, but we skip event +
      // recent-action recording so one resize gesture doesn't persist
      // an event per animation frame. The authoritative single event
      // is recorded by the end-of-gesture `setNodeGeometry` commit.
      const isTransientPreview =
        intent.type === 'RESIZE_NODE' && intent.preview === true;
      if (!isTransientPreview && execution.trace.length > 0) {
        intentActionWindow.pushMany(execution.trace);
        canvasEvents.bufferMany(get().canvasId, execution.trace);
      }
    },

    setPortalNodePins: async (updates) => {
      const callerCanvasId = get().canvasId;
      if (!callerCanvasId || updates.length === 0) return false;
      try {
        await drainPendingSaves();
        if (get().canvasId !== callerCanvasId || get().versionConflict) {
          return false;
        }
        const response = await postCanvasExecute(callerCanvasId, {
          commands: [{ type: 'SET_PORTAL_NODE_PINS', updates }],
          originator: { source: 'ui', tabId: canvasSyncTabId },
        });
        const current = get();
        if (current.canvasId === response.canvasId && response.commit) {
          const consumed = current.consumeCommit({
            kind: 'event',
            commit: response.commit,
            pendingEffects: response.pendingEffects as CommitPendingEffects,
          });
          if (consumed.shouldReload) {
            await reloadCanvasWhenSafe(callerCanvasId);
          }
        } else if (
          current.canvasId === response.canvasId &&
          current.version === response.fromVersion
        ) {
          current.applyDeltasFromAgent(
            response.deltas as Delta[],
            response.toVersion,
            response.pendingEffects as Parameters<
              typeof current.applyDeltasFromAgent
            >[2],
          );
        } else if (
          (response.deltas as Delta[]).some(isWorldReferenceTopologyDelta)
        ) {
          canvasHistoryManager.clearCanvas(response.canvasId);
          nodeRefTopologySignatures.delete(response.canvasId);
        }
        // Refresh unconditionally: a Pin invoked from a source Space
        // mutates the World (`response.canvasId` is the World), while the
        // active canvas still needs its derived pin state re-read. The
        // refresh itself is scope-aware and generation-guarded.
        await get().refreshWorldReferences();
        return true;
      } catch (error) {
        toast(
          error instanceof ApiError && error.code === 'WORLD_PORTAL_MISSING'
            ? i18n.t('world.pinSourceMissing')
            : i18n.t('world.pinFailed'),
          { tone: 'danger' },
        );
        return false;
      }
    },

    getAgentChatContext: (): AgentChatContext => {
      const { nodes } = get();
      const buildSelectedDetail = makeBuildSelectedDetail(nodes);
      const selectedNodes = nodes
        .filter((n) => n.selected)
        .map(buildSelectedDetail);

      // Fold in any Stage-2 partial stroke selection as sketch wire
      // nodes carrying `strokeIds`. Stroke selection lives outside
      // ReactFlow node selection (gesturePreviewStore), so these nodes
      // are normally NOT in the `n.selected` set — append them with
      // their stroke subset so the server can auto-snapshot + address
      // just those strokes and tell the agent it is a partial selection.
      const strokeSel = useGesturePreviewStore.getState().sketchStrokeSelection;
      const selectedIds = new Set(selectedNodes.map((n) => n.id));
      for (const [nodeId, strokeIds] of Object.entries(strokeSel)) {
        if (!strokeIds || strokeIds.length === 0) continue;
        const node = nodes.find((n) => n.id === nodeId);
        if (!node || node.type !== 'sketch') continue;
        if (selectedIds.has(nodeId)) {
          // Rare mixed case: the sketch is also whole-node selected —
          // attach the subset to its existing wire entry.
          const existing = selectedNodes.find((n) => n.id === nodeId);
          if (existing) existing.strokeIds = strokeIds;
          continue;
        }
        const data = node.data as Record<string, unknown> | undefined;
        selectedNodes.push({
          id: nodeId,
          type: 'sketch',
          label: data?.label as string | undefined,
          strokeIds,
        });
      }

      return { selectedNodes };
    },

    getIntentContext: (): IntentContext => {
      const { nodes, edges } = get();
      const buildSelectedDetail = makeBuildSelectedDetail(nodes);

      // Wire shape: raw canvas state only. The server enriches into
      // `AgentNodeOutline` (with `filename`, `preview`,
      // `parentFrame.label`) before any prompt rendering.
      return {
        nodes: nodes.map((n): WireCanvasNode => {
          const size = getNodeSize(n);
          const data = n.data as Record<string, unknown> | undefined;
          const node: WireCanvasNode = {
            id: n.id,
            type: (n.type ?? 'note') as CanvasNodeType,
            position: { x: n.position.x, y: n.position.y },
            size: { width: size.width, height: size.height },
          };
          const label = data?.label as string | undefined;
          if (label) node.label = label;
          const content = data?.content as string | undefined;
          if (content) node.content = content;
          const src = data?.src as string | undefined;
          if (src) node.src = src;
          if (n.parentId) node.parentId = n.parentId;
          return node;
        }),
        edges: edges.map((e) => ({ source: e.source, target: e.target })),
        recentActions: intentActionWindow.snapshot(),
        selectedNodes: nodes.filter((n) => n.selected).map(buildSelectedDetail),
      };
    },

    loadCanvas: async (canvasId, options) => {
      const targetId = canvasId ?? get().canvasId;
      const loadGeneration = ++canvasLoadGeneration;
      const protectedNodes = options?.preserveLocalChanges ? get().nodes : null;
      const protectedEdges = options?.preserveLocalChanges ? get().edges : null;
      const protectedTitle = options?.preserveLocalChanges
        ? get().canvasTitle
        : null;
      const protectedVersion = options?.preserveLocalChanges
        ? get().version
        : null;
      const protectedStructureRevision = options?.preserveLocalChanges
        ? get().structureRevision
        : null;
      const protectedStructureGeneration = options?.preserveLocalChanges
        ? get().structureDirtyGeneration
        : null;
      const localStateIsStillProtected = (): boolean =>
        protectedNodes === null ||
        (get().nodes === protectedNodes &&
          get().edges === protectedEdges &&
          get().canvasTitle === protectedTitle &&
          get().version === protectedVersion &&
          get().structureRevision === protectedStructureRevision &&
          get().structureDirtyGeneration === protectedStructureGeneration &&
          get().structureDirtyGeneration === get().structureSyncedGeneration &&
          get().pendingContentNodeIds().length === 0 &&
          !get().versionConflict);
      const abortProtectedLoad = (): void => {
        if (
          loadGeneration === canvasLoadGeneration &&
          get().canvasId === targetId
        ) {
          set({ isLoading: false });
        }
      };
      set({ isLoading: true, canvasNotFound: false, versionConflict: false });
      // Clear any stale "modified elsewhere" toast before we fetch a
      // fresh baseline — the warning is bound to the old version we're
      // about to replace.
      dismissVersionConflictToast();
      try {
        if (!options?.preserveLocalChanges) {
          canvasHistoryManager.activate(targetId, options?.resetHistory);
        }
        if (canvasId) {
          set({ canvasId: targetId });
        }
        const response = await getCanvas(targetId);
        if (
          loadGeneration !== canvasLoadGeneration ||
          get().canvasId !== targetId
        ) {
          return;
        }
        if (!localStateIsStillProtected()) {
          abortProtectedLoad();
          return;
        }
        if (!response) {
          console.warn('Canvas not found:', targetId);
          canvasHistoryManager.clear();
          canvasCommitGate.clear();
          nodeInvalidationTracker.clear();
          pendingCommitPreprocessVersions.clear();
          set({
            isLoading: false,
            canvasNotFound: true,
            ingestionByNodeId: {},
            pendingForkThreadIds: {},
            worldReferences: {},
            worldReferenceError: null,
            pinnedSourceNodeIds: {},
          });
          return;
        }

        const state = response.state as {
          nodes?: Node[];
          edges?: Edge[];
          // Legacy field: older canvases still carry a server-side
          // viewport. Used only as a one-shot fallback when this client
          // has no local viewport entry yet; the next structure PUT
          // strips it from persisted topology for good.
          viewport?: CanvasViewport;
        };
        // Repair question nodes whose execution status drifted to a
        // stale non-terminal value (most often `idle`) while they
        // actually completed a run — the `status: 'done'` autosave can
        // be silently dropped by a 409 when the agent edits the canvas
        // mid-conversation. Nodes that own a `threadId` always have a
        // persisted conversation, so a stale status is demoted to
        // `done` here, restoring the badge + reopen affordance.
        // Normalize tree order on load: persisted topology is not
        // guaranteed to list every parent frame ahead of its children
        // (older writes, or a delta-authored save), and a child ahead of
        // its parent makes React Flow throw "Parent node not found" on the
        // first mount. This is a defensive boundary guard on untrusted
        // on-disk state — see the same invariant enforced in
        // `applyDeltasFromAgent`.
        // Give every toggleable-height node an explicit `heightMode` and
        // a numeric `style.height` materialized from its stored
        // measurement hint, so geometry no longer depends on whether the
        // node has ever been rendered. See `normalizeNodeHeights`.
        const loadedNodes = normalizeNodeHeights(
          normalizeTreeOrder(
            reconcileQuestionStatus(state.nodes ?? []) as NestableNode[],
          ) as Node[],
        );
        const loadedEdges = state.edges ?? [];
        const loadedNodeRefSignature = nodeRefTopologySignature(loadedNodes);
        const previousNodeRefSignature =
          nodeRefTopologySignatures.get(targetId);
        // Prefer this client's persistent UI state; fall back to whatever the
        // server still has from before viewport was moved client-side.
        // A corrupt entry on either side falls through to `null`, which
        // Canvas.tsx interprets as "do a one-shot fitView".
        const storedViewport = readViewportFromStorage(targetId);
        const legacyServerViewport =
          state.viewport &&
          Number.isFinite(state.viewport.x) &&
          Number.isFinite(state.viewport.y) &&
          Number.isFinite(state.viewport.zoom) &&
          state.viewport.zoom > 0
            ? state.viewport
            : null;
        const loadedViewport = storedViewport ?? legacyServerViewport;
        // Measure never-measured notes *before* the canvas is shown.
        // Normalization gives them their policy minimum, which on a
        // canvas saved before the height model means every note paints
        // collapsed and then expands as it mounts. The load is already
        // showing a loading state; spending a bounded slice of it here
        // buys a canvas that is correct on its first frame. Whatever the
        // budget does not cover falls through to the prewarm queue.
        const warmedCanvas = await warmupNodeHeights(loadedNodes, {
          canvasId: targetId,
          edges: loadedEdges,
          centre: viewportCentreOf(loadedViewport),
        });
        if (
          loadGeneration !== canvasLoadGeneration ||
          get().canvasId !== targetId
        ) {
          return;
        }
        if (!localStateIsStillProtected()) {
          abortProtectedLoad();
          return;
        }
        if (options?.preserveLocalChanges) {
          canvasHistoryManager.activate(targetId, options.resetHistory);
        }
        if (
          previousNodeRefSignature !== undefined &&
          previousNodeRefSignature !== loadedNodeRefSignature
        ) {
          canvasHistoryManager.clearCanvas(targetId);
        }
        nodeRefTopologySignatures.set(targetId, loadedNodeRefSignature);
        const warmedNodes = warmedCanvas.nodes;
        const loadedStructureGeneration = get().structureDirtyGeneration + 1;
        // An authoritative node replacement invalidates every transient that
        // points at the previous in-memory geometry. This applies both to a
        // different-canvas switch and to a same-canvas SSE gap/snapshot heal:
        // even when the canvas id is unchanged, selected stroke ids and
        // retained polygons may have been deleted or moved remotely.
        useGesturePreviewStore.getState().resetCanvasScopedTransients();
        // Apply the authoritative server state via the no-autosave setter.
        // A load must NEVER schedule a structure PUT: the nodes/edges we
        // just fetched already ARE the server's state, so bumping the
        // canvas `version` would be a spurious self-write. Relying on the
        // `!prev.isLoading` autosave gate was not enough — two concurrent
        // loads (e.g. the CanvasPage mount load racing the realtime-sync
        // `snapshot` reload) can flip `isLoading` false before the losing
        // load's commit runs, leaking a PUT that resets `updatedAt` to the
        // open time. History is cleared above, so `canUndo`/`canRedo` are
        // reset here too (the no-autosave setter skips the middleware's
        // availability sync).
        get()._setStateNoAutosave({
          nodes: warmedNodes,
          edges: warmedCanvas.edges,
          viewport: loadedViewport,
          canvasTitle: response.title || 'Untitled',
          version: response.version,
          structureRevision: response.structureRevision ?? null,
          structureDirtyGeneration: loadedStructureGeneration,
          structureSyncedGeneration: loadedStructureGeneration,
          isLoading: false,
          canUndo: canvasHistoryManager.canUndo,
          canRedo: canvasHistoryManager.canRedo,
          ingestionByNodeId: {},
          pendingForkThreadIds: {},
          worldReferences: {},
          worldReferenceError: null,
          pinnedSourceNodeIds: {},
        });
        canvasCommitGate.clear();
        nodeInvalidationTracker.clear();
        pendingCommitPreprocessVersions.clear();
        void get().refreshWorldReferences();

        // Warmup hints were folded in before the commit, and a load
        // deliberately never schedules a save — so without this they
        // would live only in memory and every open would re-measure the
        // same notes. Schedule one save so the canvas warms up exactly
        // once. This rides the structure save because that is where
        // every other derived height goes today; Step 6 of the height
        // model moves them all onto a dedicated channel that touches
        // neither `version` nor the broadcast.
        if (warmedNodes !== loadedNodes) {
          scheduleExplicitStructureSave();
        }

        // Seed each md-backed node's optimistic-concurrency baseline from
        // the authoritative content we just loaded, so the first edit
        // carries the correct `expectRev` and the per-node content CAS can
        // catch a concurrent (cross-tab / cross-device / agent) write.
        nodeContentQueue.replaceBaselines(warmedNodes);

        // If the user left a question-replay open on this canvas in a
        // previous session and that question node has since been
        // deleted, drop the now-dangling pointer in chatStore so the
        // panel doesn't end up stuck on a foreign thread.
        useChatStore
          .getState()
          .validateQuestionReplay(
            targetId,
            new Set(warmedNodes.map((n) => n.id)),
          );

        // Backfill: any node with an empty label gets re-queued so the
        // server can regenerate one. The server's preprocessing
        // dispatcher decides per node profile whether there's any
        // actual work to do, so we don't filter by type here.
        for (const node of warmedNodes) {
          if (!shouldBackfillNodeLabel(node)) continue;
          preprocessQueue.schedule(node);
        }
      } catch (error) {
        console.error('Failed to load canvas:', error);
        if (
          loadGeneration === canvasLoadGeneration &&
          get().canvasId === targetId
        ) {
          set({ isLoading: false });
        }
      }
    },

    switchCanvas: async (canvasId: string) => {
      const currentId = get().canvasId;
      if (canvasId === currentId) return;

      // Invalidate a primary GET/warmup for the outgoing canvas immediately;
      // waiting until the replacement load starts leaves a drain window where
      // that old response could still install itself into the new route.
      canvasLoadGeneration += 1;

      // Flip into the loading state *before* awaiting anything so the
      // shell shows the loading state on the very next render instead of
      // briefly painting the previous canvas while the structure save
      // flush resolves. `loadCanvas` below will set `isLoading: true`
      // again (idempotent) once it starts the actual fetch.
      set({
        isLoading: true,
        canvasNotFound: false,
        versionConflict: false,
      });
      // Same rationale as `loadCanvas`: the persistent conflict toast
      // is bound to the outgoing canvas; clear it so it doesn't bleed
      // into the new one (which has its own fresh version baseline).
      dismissVersionConflictToast();

      // Flush any pending save for the current canvas before switching
      await structureScheduler.flushAsync();
      // Also drain any pending per-node content PUTs so editor edits
      // made on the outgoing canvas land before we tear its state down.
      await nodeContentQueue.flushAll();

      // Cancel all pending preprocessing timers
      preprocessQueue.cancelAll();

      // Reset state for clean slate. `viewport` is cleared so the new
      // canvas's restore effect either applies its own saved viewport
      // or, for older canvases without one, runs a one-shot fitView.
      set({
        expandedNodeId: null,
        pendingInlineEditNodeId: null,
        collapsedFrameIds: new Set(),
        canvasNotFound: false,
        viewport: null,
      });
      // The intent action window lives outside the store; clear it
      // alongside the in-store reset so the new canvas doesn't
      // inherit the previous canvas's recent-action trail.
      intentActionWindow.clear();
      useToolStore.getState().resetForCanvasSwitch();
      useGesturePreviewStore.getState().resetCanvasScopedTransients();
      // Load the new canvas
      await get().loadCanvas(canvasId);
    },

    saveCanvas: async (options) => {
      // Once the server has rejected a save with a version mismatch, our
      // local `version` is permanently stale until the user reloads. Skip
      // further attempts so we don't generate a 409 on every autosave tick
      // (and don't clobber the surfaced toast with more failures).
      if (get().versionConflict) return;

      const { isSaving } = get();
      // `force` (unload path) skips coalescing: we want the latest
      // geometry on the wire via keepalive even if a regular PUT is
      // already in flight (that one gets aborted by the browser on
      // page close, so deferring to it would silently drop the edit).
      //
      // CONTRACT: `force` must stay unload-only and always pair with
      // `keepalive`. Outside unload the bypassed in-flight PUT is *not*
      // aborted, so a forced second PUT would race it and can land a
      // stale-baseline write → server 409 (CANVAS_VERSION_CONFLICT).
      // The dev tripwire below flags any accidental non-unload use.
      if (import.meta.env.DEV && options?.force && !options?.keepalive) {
        console.warn(
          '[saveCanvas] `force` is unload-only and must be paired with ' +
            '`keepalive`; a forced non-keepalive save can 409 by racing an ' +
            'in-flight PUT.',
        );
      }
      if (isSaving && !options?.force) {
        set({ pendingSave: true });
        return;
      }

      set({ isSaving: true });
      let saveSucceeded = false;
      try {
        const {
          nodes,
          edges,
          version,
          canvasId,
          canvasTitle,
          structureRevision,
          structureDirtyGeneration,
        } = get();
        // Strip every per-node content / label / src / summary / etc. field
        // for nodes that already exist. A new markdown-backed node is the
        // exception: topology and its initial sidecar must be one aggregate
        // commit, so its content-owned fields ride this structure PUT.
        // Viewport is intentionally omitted: it's local UI state mirrored
        // into `localStorage`, not canvas data.
        const aggregateCreateAttempt =
          nodeContentQueue.beginAggregateCreateCommit(nodes);
        const slimNodes = stripNodeContentForStructurePut(
          nodes,
          new Set(aggregateCreateAttempt.nodeIds),
        );
        const response = await putCanvas(
          canvasId,
          {
            version,
            title: canvasTitle || 'Untitled',
            state: { nodes: slimNodes, edges },
            ...(structureRevision
              ? { expectStructureRevision: structureRevision }
              : {}),
            originator: { source: 'ui', tabId: canvasSyncTabId },
          },
          { keepalive: options?.keepalive },
        );
        let shouldReloadAfterSave = false;
        if (response.commit) {
          // Consume the complete HTTP commit so the same gate handles it and
          // SSE in either order. Even if SSE won and this is now a duplicate,
          // the explicit generation still marks our local structure durable.
          shouldReloadAfterSave = get().consumeCommit({
            kind: 'event',
            commit: response.commit,
            acknowledgedStructureGeneration: structureDirtyGeneration,
          }).shouldReload;
        } else if (response.ack) {
          shouldReloadAfterSave = get().consumeCommit({
            kind: 'ack',
            ack: response.ack,
            acknowledgedStructureGeneration: structureDirtyGeneration,
          }).shouldReload;
        } else {
          // Legacy response fallback. Never let a delayed response regress a
          // version already advanced by realtime delivery.
          const current = get();
          current._setStateNoAutosave({
            version: Math.max(current.version, response.version),
            structureSyncedGeneration: Math.max(
              current.structureSyncedGeneration,
              structureDirtyGeneration,
            ),
          });
        }
        const committedCreateIds =
          await nodeContentQueue.completeAggregateCreateCommit(
            canvasId,
            aggregateCreateAttempt,
            response.commit,
          );
        for (const nodeId of committedCreateIds) {
          preprocessQueue.releaseDeferred(nodeId);
        }
        if (shouldReloadAfterSave) void reloadCanvasWhenSafe(canvasId);
        saveSucceeded = true;
      } catch (error) {
        if (error instanceof CanvasConflictError) {
          if (error.code === 'CANVAS_VERSION_CONFLICT') {
            // Server is ahead of us (another tab / device / agent wrote
            // first). Stop the autosave loop and surface a persistent
            // toast (with a Reload action) so the user knows their edits
            // aren't being saved and has a one-click recovery. The toast
            // is dismissable so the user can copy any unsaved text out
            // first; `loadCanvas` clears the flag (and the toast) once
            // the client re-syncs.
            if (!get().versionConflict) {
              set({ versionConflict: true });
              showVersionConflictToast();
            }
            return;
          }
          // Surface other conflicts (e.g. CANVAS_TITLE_CONFLICT) to the
          // caller — `tryRename` reverts the optimistic UI on those.
          throw error;
        }
        console.error('Failed to save canvas:', error);
      } finally {
        set({ isSaving: false });

        const { pendingSave } = get();
        if (pendingSave) {
          set({ pendingSave: false });
          // Fire-and-forget: re-save the latest state after the in-flight save completes.
          // Conflict errors are surfaced via tryRename; ignore them here so
          // the rejection doesn't escape into the runtime as unhandled.
          void get()
            .saveCanvas()
            .catch((err) => {
              if (!(err instanceof CanvasConflictError)) {
                console.error('Re-save after pending failed:', err);
              }
            });
        }
      }

      // Piggy-back the action-log flush on the autosave cadence so we
      // don't open a separate timer just for events. Fire-and-forget —
      // failures are retried on the next flush trigger.
      if (saveSucceeded) {
        void canvasEvents.flush(get().canvasId);
      }
    },

    tryRename: async (kind, id, nextName) => {
      const trimmed = nextName.trim();
      if (!trimmed) return false;

      // Case-insensitive + Unicode-normalized comparison, matching the
      // backend (`normalizeForCompare` in storage/naming.ts).
      const normalize = (s: string) => s.normalize('NFC').toLowerCase();

      if (kind === 'canvas') {
        const { canvasId, canvasTitle } = get();
        if (id !== canvasId) return false;
        if (normalize(canvasTitle) === normalize(trimmed)) {
          // No-op rename: still update local label casing without a roundtrip.
          if (canvasTitle !== trimmed) set({ canvasTitle: trimmed });
          return true;
        }
        const previous = canvasTitle;
        set({ canvasTitle: trimmed });
        try {
          await get().saveCanvas();
          // `saveCanvas` swallows `CANVAS_VERSION_CONFLICT` (sets the
          // store flag + toast). When that path fired, the title we
          // optimistically applied was never actually persisted, so
          // revert and report failure to the caller.
          if (get().versionConflict) {
            if (get().canvasTitle === trimmed) {
              set({ canvasTitle: previous });
            }
            return false;
          }
          return true;
        } catch (err) {
          if (
            err instanceof CanvasConflictError &&
            err.code === 'CANVAS_TITLE_CONFLICT'
          ) {
            if (get().canvasTitle === trimmed) {
              set({ canvasTitle: previous });
            }
            const taken = err.conflictWith ?? trimmed;
            toast(
              `Canvas name "${taken}" is already in use. Choose a different name.`,
              { tone: 'warning', duration: 5000 },
            );
            return false;
          }
          // Other errors (network etc.) — leave optimistic title; caller
          // can retry. Log so the failure isn't silent.
          console.error('Failed to rename canvas:', err);
          return true;
        }
      }

      // kind === 'node'
      const { nodes, canvasId } = get();
      const target = nodes.find((n) => n.id === id);
      if (!target) return false;
      const currentLabel =
        typeof target.data?.['label'] === 'string'
          ? (target.data['label'] as string)
          : '';
      // Snapshot the existing labelSource so the rollback path can
      // restore the original provenance ('user' / 'agent' / 'auto' /
      // undefined) verbatim instead of hard-coding 'auto'. Downstream
      // consumers (paste resolver, content PUT, preprocess dispatcher)
      // all gate on this field, so clobbering it would silently change
      // behaviour.
      const currentLabelSource = (
        target.data as Record<string, unknown> | undefined
      )?.['labelSource'];
      if (normalize(currentLabel) === normalize(trimmed)) {
        // No-op: avoid a needless dispatch.
        if (currentLabel !== trimmed) {
          get().updateNodeData(id, { label: trimmed, labelSource: 'user' });
        }
        return true;
      }
      // Local sibling pre-check. Only compare against nodes the user can see;
      // the backend re-validates on persist.
      const collision = nodes.find((n) => {
        if (n.id === id) return false;
        const label = n.data?.['label'];
        if (typeof label !== 'string') return false;
        return normalize(label) === normalize(trimmed);
      });
      if (collision) {
        toast(
          `Name "${trimmed}" is already used by another node on this canvas. Choose a different name.`,
          { tone: 'warning', duration: 5000 },
        );
        return false;
      }
      // Optimistic patch — the per-node content middleware schedules a
      // debounced PUT. We force-flush immediately so the user sees the
      // 409 toast at rename time rather than ~500 ms later.
      get().updateNodeData(id, { label: trimmed, labelSource: 'user' });
      try {
        await nodeContentQueue.flushNow(canvasId, id, { source: 'user' });
        return true;
      } catch (err) {
        if (
          err instanceof CanvasConflictError &&
          err.code === 'NODE_LABEL_CONFLICT'
        ) {
          // Revert the optimistic label and surface the conflict as a
          // toast. `_setStateNoAutosave` skips both autosave scheduling
          // and the content-diff hook so reverting doesn't schedule
          // another doomed PUT.
          get()._setStateNoAutosave({
            nodes: get().nodes.map((n) => {
              if (n.id !== id) return n;
              const latestData = (n.data ?? {}) as Record<string, unknown>;
              if (
                latestData['label'] !== trimmed ||
                latestData['labelSource'] !== 'user'
              ) {
                return n;
              }
              // Strip the optimistic `labelSource: 'user'` first so we
              // can restore the original provenance exactly — including
              // the "was previously absent" case (omit the key entirely
              // rather than leaving a literal `undefined` value behind).
              const { labelSource: _omitted, ...rest } = latestData;
              return {
                ...n,
                data: {
                  ...rest,
                  label: currentLabel,
                  // Restore the original label source captured before
                  // the optimistic patch so we don't silently rewrite
                  // provenance ('user' / 'agent') to 'auto' on revert.
                  ...(currentLabelSource !== undefined
                    ? { labelSource: currentLabelSource }
                    : {}),
                },
              };
            }),
          });
          const taken = err.conflictWith ?? trimmed;
          toast(
            `Name "${taken}" is already used by another node on this canvas. Choose a different name.`,
            { tone: 'warning', duration: 5000 },
          );
          return false;
        }
        // Non-conflict failures (500 after retry, network) have already
        // been handled by `nodeContentQueue.handleSaveFailure` — it
        // reverted the label and toasted. Just propagate the rejection
        // as `return false` so the caller knows the rename didn't stick.
        console.error('Failed to rename node:', err);
        return false;
      }
    },

    flushCanvasEvents: async () => {
      await canvasEvents.flush(get().canvasId);
    },

    onNodeDragStart: (event, _draggedNode, draggedNodes) => {
      // Snapshot the true pre-drag positions before any intermediate
      // position updates are applied by ReactFlow.
      get().beginGesture('SET_NODE_GEOMETRY');
      // A height correction landing mid-drag would move geometry under
      // the user's hand. Hold them until the gesture settles.
      suspendHeightCommits('node-drag');

      // Record the pre-drag positions of the dragged nodes so
      // `onNodeDragStop` can tell whether the gesture actually moved
      // anything (and thus needs a structure save) even when the
      // resolver emits no command.
      const liveNodes = get().nodes;
      _dragStartPositions = new Map(
        draggedNodes.map((d) => {
          const live = liveNodes.find((n) => n.id === d.id);
          const pos = live?.position ?? d.position;
          return [d.id, { x: pos.x, y: pos.y }];
        }),
      );

      // The snap session module owns its own defensive cleanup
      // (`beginSnapSession` calls `endSnapSession` internally before
      // setting up the new gesture), so we don't need to do it here.
      beginSnapSession({
        nodes: get().nodes as NestableNode[],
        gestureIds: new Set(draggedNodes.map((n) => n.id)),
        altPressed: event.altKey,
      });
    },

    onNodeResizeStart: () => {
      get().beginGesture('SET_NODE_GEOMETRY');
      suspendHeightCommits('node-resize');
    },

    onNodeDrag: (_event, draggedNode, draggedNodes) => {
      // Capture the cursor's screen position now (before the rAF) so the
      // structured-frame drop indicator can be placed at the actual
      // pointer, not where the dragged node settled. Guarded against
      // touch / programmatic emits that lack client coords.
      const ptrEvent = _event as
        | { clientX?: number; clientY?: number }
        | undefined;
      const pointerScreen =
        ptrEvent &&
        typeof ptrEvent.clientX === 'number' &&
        typeof ptrEvent.clientY === 'number'
          ? { x: ptrEvent.clientX, y: ptrEvent.clientY }
          : null;

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
        const { nodes, edges } = get();

        // Publish this tick's peer slide-aside (or withdraw it when the
        // node no longer hovers a structured frame). Called exactly once
        // per tick, at every exit point below. The positions live in the
        // gesture-preview store, never on `nodes`, so the pickers and
        // solvers above always see the real pre-drag geometry and no
        // mid-drag save / snapshot can capture a previewed position.
        // Dragged nodes are filtered out: React Flow owns their position
        // until release, so projecting one would fight the cursor.
        const draggedIds = new Set(draggedNodes.map((d) => d.id));
        const commitReflow = (
          reflow: readonly StructuredReflowEntry[] | null,
        ) => {
          const preview = useGesturePreviewStore.getState();
          if (!reflow) {
            preview.clearStructuredReflowPositions();
            return;
          }
          preview.setStructuredReflowPositions(
            reflow.filter((entry) => !draggedIds.has(entry.id)),
          );
        };

        // Space-held drag opts out of *parent membership changes* only.
        // The current parent's frame still refits around the child's
        // new position (so the virtual outline grows / shrinks live),
        // and the structured-frame caret still tracks slot reorders
        // inside the existing parent. Reflected below by skipping the
        // `wouldUnframe` / `wouldAutoFrame` branches that would
        // otherwise mark the node as leaving its parent or entering a
        // different one. Mirrors the `continue` short-circuit in
        // `resolveNodeDragStop`.
        const bypassReparent = isReparentBypassed();

        const liveNodes = nodes.map((n) => {
          if (n.id === draggedNode.id)
            return { ...n, position: draggedNode.position };
          const live = draggedNodes.find((d) => d.id === n.id);
          if (live) return { ...n, position: live.position };
          return n;
        }) as NestableNode[];

        // Pointer in flow space — feeds the pointer-aware
        // wouldUnframe / wouldAutoFrame predicates so the live preview
        // mirrors the actual drop rules used by `resolveNodeDragStop`,
        // and gates the structured-frame indicator below.
        const pointerFlow = pointerScreen
          ? get().rfInstance?.screenToFlowPosition(pointerScreen)
          : undefined;

        // Collect frame IDs that need a preview, and which dragged children
        // would leave each frame (so we exclude them from the fit preview).
        const leavingByFrame = new Map<string, Set<string>>();
        const enteringByFrame = new Map<
          string,
          { x: number; y: number; width: number; height: number }[]
        >();
        const previewFrameIds = new Set<string>();

        // Reset the per-tick drag-decision cache before recomputing.
        // The resolver consumes this map at drop-time as the single
        // source of truth for "did the gesture cross a frame
        // boundary?" — so the cache must reflect *only* the current
        // tick's predicates, not a stale mix with prior ticks.
        // Decisions are written inside the per-node loop below.
        // Skipped entirely when Space-bypass is active: no decisions
        // are recorded, the resolver sees an empty cache for those
        // ids and short-circuits via `intent.bypassReparent`.
        clearDragDecisions();

        for (const dn of draggedNodes) {
          const originalNode = nodes.find((n) => n.id === dn.id);
          if (!originalNode) continue;
          // If the node is currently in a frame, check whether it would unframe.
          let wouldUnframeNow = false;
          if (originalNode.parentId) {
            const parentId = originalNode.parentId;
            previewFrameIds.add(parentId);

            // Per-axis halo scaled with the dragged node — mirrors
            // `resolveNodeDragStop` so preview and commit stay in sync.
            const liveNode = liveNodes.find((n) => n.id === dn.id);
            const dragSize = liveNode
              ? getNodeSize(liveNode)
              : { width: 0, height: 0 };
            // A structured parent claims a much larger capture zone, and
            // it has to be honoured HERE: this tick's answer is cached
            // and replayed verbatim at drop time, so deciding "unframe"
            // while the overlay says "insert a new track" is exactly how
            // a node ends up outside the frame it was shown entering.
            const stickToStructured = wouldStickToStructuredFrame(
              liveNodes,
              dn.id,
              pointerFlow,
            );
            if (
              !bypassReparent &&
              !stickToStructured &&
              wouldUnframe(liveNodes, dn.id, {
                epsilon: 0,
                margin: 10,
                pointer: pointerFlow,
                pointerCaptureMargin: {
                  x: Math.max(
                    FRAME_POINTER_CAPTURE_MARGIN,
                    dragSize.width * 0.3,
                  ),
                  y: Math.max(
                    FRAME_POINTER_CAPTURE_MARGIN,
                    dragSize.height * 0.3,
                  ),
                },
              })
            ) {
              wouldUnframeNow = true;
              let leaving = leavingByFrame.get(parentId);
              if (!leaving) {
                leaving = new Set();
                leavingByFrame.set(parentId, leaving);
              }
              leaving.add(dn.id);
            }
          }

          // Check if the node would enter a different frame (both root and cross-frame).
          // Preview triggers when either the 50% overlap threshold is met OR the
          // cursor is hovering inside a candidate frame with any positive overlap —
          // identical to what `resolveNodeDragStop` will commit.
          const targetFrameId = bypassReparent
            ? undefined
            : wouldAutoFrame(liveNodes, dn.id, {
                threshold: 0.5,
                pointer: pointerFlow,
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

          // Persist this tick's decision so `onNodeDragStop` (via the
          // resolver) can honour exactly what the user last saw —
          // bypassing fresh halo / overlap recomputation against the
          // store's snapped positions and the mouseup pointer, which
          // can disagree with the live preview by a few px under
          // smart-snap. Skipped when Space-bypass is active (cache
          // stays empty for those ids; resolver handles via
          // `intent.bypassReparent`).
          if (!bypassReparent) {
            writeDragDecision(dn.id, {
              unframe: wouldUnframeNow,
              enterFrameId: targetFrameId ?? null,
            });
          }
        }

        // Compute fit previews for all affected frames and show them all
        // simultaneously — e.g. source frame shrinking + target frame expanding.
        // Each entry is tagged with a UI role so the overlay can paint the
        // landing target (`enteringByFrame`) distinctly from a frame that
        // is merely losing a child (`leavingByFrame`).
        //
        // Role assignment per frame:
        //   - `leaving && !entering`  → the dragged child is exiting
        //     this frame and is not coming back  →  paint as `source`.
        //   - everything else (entering, or merely-current-parent
        //     with no exit)  →  the node will land here  →  `target`.
        // The "merely-current-parent" branch matters when a child is
        // dragged around *inside* its own frame: that frame is still
        // the landing destination, so painting it `source` would
        // wrongly mute the only relevant overlay.
        const previews: FrameFitPreview[] = [];

        // ── Where the drop would land ────────────────────────────────
        // Resolved BEFORE the fit-preview pass, because the structured
        // drop zone below already solves the target frame's post-drop
        // layout. Solving it here too is the same work twice, and the
        // fit pass's answer would only be overwritten by the zone's.
        const primary = nodes.find((n) => n.id === draggedNode.id) as
          | NestableNode
          | undefined;
        const enteringFrameId = bypassReparent
          ? undefined
          : wouldAutoFrame(liveNodes, draggedNode.id, {
              threshold: 0.5,
              pointer: pointerFlow,
            });
        let targetFrameId = enteringFrameId ?? primary?.parentId;
        // Sticky case (node already lives in a frame): only keep showing the
        // structured indicator while the cursor is still inside that frame's
        // capture zone. Same predicate as the unframe decision above and as
        // NODE_DRAG_STOP, so the preview and the committed drop cannot
        // disagree (no "shows insert, lands outside") while the outer
        // prepend / append bands stay reachable.
        if (
          !enteringFrameId &&
          targetFrameId &&
          !wouldStickToStructuredFrame(liveNodes, draggedNode.id, pointerFlow)
        ) {
          targetFrameId = undefined;
        }
        const targetFrame = targetFrameId
          ? liveNodes.find((n) => n.id === targetFrameId)
          : undefined;
        const gridCfg = readFrameGridConfig(targetFrame);

        /** Content-driven fit preview for one structured frame. */
        const solveStructuredPreview = (
          frameId: string,
        ): FrameFitPreview | null => {
          const leaving = leavingByFrame.get(frameId);
          const entering = enteringByFrame.get(frameId);
          const previewNodes = leaving?.size
            ? liveNodes.filter((node) => !leaving.has(node.id))
            : liveNodes;
          const layout = solveStructuredFrameLayout(
            previewNodes,
            frameId,
            'compact',
            { edges },
          );
          const frameAbs = getFrameAbsolutePosition(liveNodes, frameId);
          if (!layout || !frameAbs) return null;
          return {
            frameId,
            position: frameAbs,
            width: layout.frameSize.width,
            height: layout.frameSize.height,
            role: leaving && !entering ? 'source' : 'target',
          };
        };

        // Skipped in the pass below and reported from the drop zone
        // instead; recomputed there only if the zone fails to resolve.
        const deferredStructuredTarget =
          gridCfg && targetFrameId && getFrameSizing(targetFrame) === 'hug'
            ? targetFrameId
            : null;

        for (const frameId of previewFrameIds) {
          if (frameId === deferredStructuredTarget) continue;
          // Per-frame sizing gate: only `hug` frames preview a refit;
          // `manual` frames keep their pinned size during the drag.
          const frameNode = liveNodes.find((n) => n.id === frameId);
          if (getFrameSizing(frameNode) !== 'hug') continue;
          const leaving = leavingByFrame.get(frameId);
          const entering = enteringByFrame.get(frameId);
          if (readFrameGridConfig(frameNode)) {
            const preview = solveStructuredPreview(frameId);
            if (preview) previews.push(preview);
            continue;
          }
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

          const role: FrameFitPreviewRole =
            leaving && !entering ? 'source' : 'target';
          previews.push({
            frameId,
            position: { x: absX, y: absY },
            width: fit.width,
            height: fit.height,
            role,
          });
        }

        useGesturePreviewStore.getState().setFrameFitPreviews(previews);

        // ── Structured-frame drop indicator ──────────────────────────
        // Mirror what NODE_DRAG_STOP will decide, live: if the primary
        // dragged node is hovering a column / row / grid frame, show
        // where it would land. Free frames have no tracks → no
        // indicator.
        if (targetFrameId && targetFrame && gridCfg) {
          const frameAbs = getFrameAbsolutePosition(liveNodes, targetFrameId);
          // Frame-local drop point: prefer the cursor, fall back to the
          // dragged node's live top-left (matches the resolver).
          const liveDragged = liveNodes.find((n) => n.id === draggedNode.id);
          const framePoint =
            pointerFlow && frameAbs
              ? { x: pointerFlow.x - frameAbs.x, y: pointerFlow.y - frameAbs.y }
              : liveDragged
                ? { x: liveDragged.position.x, y: liveDragged.position.y }
                : null;

          // Frame-local rect of the dragged node so the indicator can
          // size the new-track ghost and rank the insertion line.
          const draggedAbs = getFrameAbsolutePosition(
            liveNodes,
            draggedNode.id,
          );
          const draggedSize = liveDragged ? getNodeSize(liveDragged) : null;
          const draggedRect =
            frameAbs && draggedAbs && draggedSize
              ? {
                  id: draggedNode.id,
                  x: draggedAbs.x - frameAbs.x,
                  y: draggedAbs.y - frameAbs.y,
                  width: draggedSize.width,
                  height: draggedSize.height,
                }
              : undefined;

          const zone = framePoint
            ? describeStructuredDropZone(
                liveNodes,
                targetFrameId,
                framePoint,
                gridCfg.axis,
                resolveFrameTrackCount(nodes, targetFrameId),
                draggedRect,
                { edges },
              )
            : null;

          if (zone && frameAbs) {
            const toAbsoluteRect = <T extends { x: number; y: number }>(
              rect: T,
            ): T => ({
              ...rect,
              x: frameAbs.x + rect.x,
              y: frameAbs.y + rect.y,
            });
            useGesturePreviewStore.getState().setStructuredDropPreview({
              frameId: targetFrameId,
              kind: zone.kind,
              x: frameAbs.x + zone.x,
              y: frameAbs.y + zone.y,
              width: zone.width,
              height: zone.height,
              context: {
                ...zone.context,
                tracks: zone.context.tracks.map(toAbsoluteRect),
                rows: zone.context.rows.map(toAbsoluteRect),
              },
            });
            if (getFrameSizing(targetFrame) === 'hug') {
              const structuredFramePreview: FrameFitPreview = {
                frameId: targetFrameId,
                position: frameAbs,
                width: zone.frameSize.width,
                height: zone.frameSize.height,
                role: 'target',
              };
              const targetPreviewIndex = previews.findIndex(
                (preview) => preview.frameId === targetFrameId,
              );
              if (targetPreviewIndex >= 0) {
                previews[targetPreviewIndex] = structuredFramePreview;
              } else {
                previews.push(structuredFramePreview);
              }
              useGesturePreviewStore.getState().setFrameFitPreviews(previews);
            }
            // Solver owns the slot here → suppress free-alignment guides.
            setSnapStructuredSuppressed(true);
            commitReflow(zone.reflow);
          } else {
            // The zone did not resolve, so nothing reported the size of
            // the frame the fit pass skipped. Compute it after all.
            if (deferredStructuredTarget) {
              const preview = solveStructuredPreview(deferredStructuredTarget);
              if (preview) {
                previews.push(preview);
                useGesturePreviewStore.getState().setFrameFitPreviews(previews);
              }
            }
            useGesturePreviewStore.getState().clearStructuredDropPreview();
            setSnapStructuredSuppressed(false);
            commitReflow(null);
          }
        } else {
          useGesturePreviewStore.getState().clearStructuredDropPreview();
          setSnapStructuredSuppressed(false);
          commitReflow(null);
        }
      });
    },

    onNodeDragStop: (_event, _node, draggedNodes) => {
      resumeHeightCommits('node-drag');
      // Cancel any pending preview computation — the drag is over.
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
        _dragPreviewRafId = null;
      }
      useGesturePreviewStore.getState().clearFrameFitPreview();
      useGesturePreviewStore.getState().clearStructuredDropPreview();
      // Withdraw the peer slide-aside. Purely visual — the nodes never
      // moved — so the resolver below already classifies the release
      // against the same geometry the preview was derived from, and the
      // peers snap to their committed positions in the same tick the
      // authoritative `SET_NODE_GEOMETRY` lands.
      useGesturePreviewStore.getState().clearStructuredReflowPositions();

      // Read the Space-bypass snapshot taken by `endSnapSession`.
      // The snap session is normally torn down by `onNodesChange`
      // (when the final `dragging:false` commit lands) *before* RF
      // emits `onNodeDragStop`, so `isReparentBypassed()` at this
      // point would already be false. `consumeLastDragReparentBypass`
      // returns the value the user was holding at release, then
      // clears it so a follow-up drag can't inherit a stale value.
      // Also covers the rare path where this handler runs first by
      // OR-ing with the live flag.
      const bypassReparent =
        consumeLastDragReparentBypass() || isReparentBypassed();

      // Read the per-dragged-node frame-membership decisions captured
      // by the live preview tick. Same teardown-before-stop ordering
      // as the bypass flag: `endSnapSession` snapshots the working
      // cache into `_lastDragDecisions`, this consumes it. Null when
      // no `rAF` tick ran during the drag (instant click-release) —
      // the resolver falls back to fresh recomputation in that case.
      // The cache always wins when present so the drop honours what
      // the user last saw.
      const cachedDecisions = consumeLastDragDecisions() ?? undefined;

      // Idempotent safety net. The normal cleanup path runs inside
      // `onNodesChange` when the final `dragging:false` commit lands
      // — that ordering is what keeps the release frame correctly
      // snapped. We still end the session here so that aborted
      // gestures (Esc cancel, mid-drag unmount, RF skipping the final
      // emit) don't leak the candidate index or Alt listeners between
      // drags. `endSnapSession` aborts the gesture's AbortController,
      // which detaches every window-level listener attached during
      // `beginSnapSession` in one operation.
      endSnapSession();

      // Convert the cursor's screen position to flow space so the
      // resolver can assign grid-frame columns based on where the
      // mouse actually was (not where the dragged node settled).
      // Guarded against unusual event shapes (touch, programmatic
      // emits) — the resolver gracefully falls back to node X.
      let pointerFlowPosition: { x: number; y: number } | undefined;
      const mouseEvent = _event as
        | { clientX?: number; clientY?: number }
        | undefined;
      if (
        mouseEvent &&
        typeof mouseEvent.clientX === 'number' &&
        typeof mouseEvent.clientY === 'number'
      ) {
        const flow = get().rfInstance?.screenToFlowPosition({
          x: mouseEvent.clientX,
          y: mouseEvent.clientY,
        });
        if (flow) pointerFlowPosition = flow;
      }

      get().dispatchUiIntent({
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: draggedNodes.map((n) => n.id),
        pointerFlowPosition,
        bypassReparent,
        cachedDecisions,
      });

      // Ensure a structure save is scheduled whenever the drag actually
      // moved a node. The resolver only emits a `SET_NODE_GEOMETRY`
      // command for frame / parent transitions; a plain free-node move
      // yields no command (the final position is already in the store
      // from the live `_setStateNoAutosave` ticks), so without this the
      // new position would never be persisted. Re-scheduling when the
      // resolver did commit is harmless — it just resets the debounce.
      const startPositions = _dragStartPositions;
      _dragStartPositions = null;
      if (startPositions) {
        const liveNodes = get().nodes;
        const moved = draggedNodes.some((d) => {
          const start = startPositions.get(d.id);
          if (!start) return false;
          const live = liveNodes.find((n) => n.id === d.id);
          if (!live) return false;
          return live.position.x !== start.x || live.position.y !== start.y;
        });
        if (moved) {
          scheduleExplicitStructureSave();
          // A real move: the pre-drag snapshot beginGesture took is a
          // legitimate undo entry — keep it (executeCommands already
          // consumed it for frame-transition moves; this is idempotent
          // for the free-move path that emits no command).
          canvasHistoryManager.consumeGestureSnapshot();
        } else {
          // Zero-distance "drag" (a click that merely selects a node
          // still fires onNodeDragStart → beginGesture). Nothing was
          // mutated, so discard the optimistic snapshot; otherwise it
          // captures the result of a prior un-snapshotted free move and
          // becomes a phantom empty undo step.
          canvasHistoryManager.rollbackGestureSnapshot();
        }
      }
    },

    cancelActiveNodeDrag: () => {
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
        _dragPreviewRafId = null;
      }
      const preview = useGesturePreviewStore.getState();
      preview.clearFrameFitPreview();
      preview.clearStructuredDropPreview();
      preview.clearStructuredReflowPositions();

      const startPositions = _dragStartPositions;
      _dragStartPositions = null;
      if (startPositions) {
        get()._setStateNoAutosave({
          nodes: get().nodes.map((node) => {
            const start = startPositions.get(node.id);
            return start
              ? {
                  ...node,
                  position: { x: start.x, y: start.y },
                  dragging: false,
                }
              : node;
          }),
        });
      }

      endSnapSession();
      canvasHistoryManager.rollbackGestureSnapshot();
      set({
        canUndo: canvasHistoryManager.canUndo,
        canRedo: canvasHistoryManager.canRedo,
      });
    },

    endActiveDragSession: () => {
      // Bridges the Canvas component's unmount cleanup into the snap
      // session's lifecycle. Without this, a component teardown
      // mid-drag (route change, canvas swap) would never trigger
      // `onNodeDragStop`, leaving the window-level Alt listeners,
      // the frame-fit RAF, and the candidate-index cache alive.
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
        _dragPreviewRafId = null;
      }
      // Same for any in-flight resize preview rAF — unmounting
      // mid-resize would otherwise let the queued fit-pass fire
      // against a torn-down canvas.
      resizePreviewController.cancelPendingRaf();
      useGesturePreviewStore.getState().clearFrameFitPreview();
      useGesturePreviewStore.getState().clearStructuredDropPreview();
      useGesturePreviewStore.getState().clearStructuredReflowPositions();
      _dragStartPositions = null;
      endSnapSession();
    },

    updateResizePreview: resizePreviewController.updateResizePreview,

    endResizePreview: resizePreviewController.endResizePreview,

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

      // ── Smart-snap: rewrite drag-time position changes ─────────────
      // This runs *before* applyNodeChanges commits to the store, so the
      // snapped position lands in the same React render as the raw
      // position would have — no 1-frame flicker. The session itself
      // decides which changes to rewrite (only `dragging:true`
      // position changes for tracked ids); when no session is active
      // (or it was disabled due to mixed parents), the call is a
      // cheap pass-through.
      const snappedChanges = isSnapSessionActive()
        ? applySnap(sanitized, get().rfInstance?.getZoom() ?? 1)
        : sanitized;

      let nextNodes = applyNodeChanges(snappedChanges, get().nodes) as Node[];

      // ── Live-resize style sync ─────────────────────────────────────
      // RF's `applyChange` writes a `dimensions` change to
      // `node.measured.{width,height}` only — and the `setAttributes`
      // strip above prevents it from writing the top-level
      // `node.{width,height}` either (those would shadow our
      // `style.{width,height}` source of truth on commit). But the
      // rendered DOM's inline size comes from
      // `node.{width,height} ?? node.style?.{width,height}`, so
      // without a style mirror the node would render at its
      // pre-resize size for the entire drag and only "snap" to the
      // committed size on mouseup (when `SET_NODE_GEOMETRY` writes
      // `style`). Mirror the snap session's authoritative
      // post-snap rect onto `style` + `position` for the resized
      // node, in the same `set` that `applyNodeChanges` writes.
      const resizeCtx = getResizeContext();
      const snappedRect = resizeCtx ? getResizeSnappedRect() : null;
      if (resizeCtx && snappedRect) {
        // Per-axis pass-through. The snap session's authoritative
        // post-snap rect is mirrored directly onto the resized node's
        // `position` + `style`. This matches what `flushScale`
        // dispatches on the next rAF tick: with the grid solver now
        // using per-axis padding + gap
        // (`packages/shared/src/canvas-engine/autoLayout/gridLayout.ts`),
        // a single-edge drag scales only the dragged axis and the
        // frame size = `oldSize × axisScale` exactly on that axis, so
        // mirroring the pointer-driven rect here can't put the frame
        // body smaller than the children's still-old-size snapshot.
        nextNodes = nextNodes.map((n) =>
          n.id === resizeCtx.nodeId
            ? {
                ...n,
                position: { x: snappedRect.local.x, y: snappedRect.local.y },
                style: {
                  ...n.style,
                  width: snappedRect.size.width,
                  height: snappedRect.size.height,
                },
                // `getNodeSize` resolves `measured` before `style`, and the
                // ResizeObserver only refreshes it a frame or two after the
                // DOM has already resized. Leaving it behind would let every
                // geometry consumer (selection outline, snap engine, frame
                // rects) trail the live gesture, so keep the pair in lockstep
                // exactly like `materializeAutoHeight` does.
                measured: {
                  ...n.measured,
                  width: snappedRect.size.width,
                  height: snappedRect.size.height,
                },
              }
            : n,
        );
      }

      // Internal RF changes (position mid-drag, select, dimensions /
      // measured) are purely transient UI state. The authoritative
      // geometry commit happens in `onNodeDragStop` via the
      // `SET_NODE_GEOMETRY` engine command, which DOES schedule
      // autosave. Routing this hot 60 fps drag-tick path through the
      // no-autosave setter avoids running the structure dirty
      // detector (and resetting the autosave debounce) on every frame.
      get()._setStateNoAutosave({ nodes: nextNodes });

      // ── Frame relayout on measured-size changes ────────────────────
      // Both structured (`column` / `row`) and free-mode frames refit
      // when a child's measured size changes (e.g. a note growing as
      // its content is edited, or a freshly-added note settling on its
      // content height — which has no committed `style.height` yet, so
      // the executor's synchronous fit treated it as zero). The deferred
      // relayout runs the structured grid solver (a no-op for free
      // frames) followed by a bounding-box `fitFrames` pass that handles
      // free frames and cascades to ancestors.
      if (!resizeCtx && !isSnapSessionActive()) {
        let framesToRelayout: Set<string> | undefined;
        for (const c of sanitized) {
          if (c.type !== 'dimensions') continue;
          if (c.resizing) continue; // live tick of a resize session
          const child = nextNodes.find((n) => n.id === c.id);
          if (!child?.parentId) continue;
          const parent = nextNodes.find((n) => n.id === child.parentId);
          if (!parent || parent.type !== 'frame') continue;
          // Per-frame sizing gate: structured (`column` / `row`)
          // frames always reflow (their layout mode is an explicit
          // opt-in), free-mode frames only chase their children's
          // measured size when `data.sizing === 'hug'`. `'manual'`
          // free frames keep their pinned size regardless of child
          // re-measurement.
          const mode = (parent.data as { layoutMode?: string } | undefined)
            ?.layoutMode;
          const isStructured =
            mode === 'column' || mode === 'row' || mode === 'grid';
          if (!isStructured && getFrameSizing(parent) !== 'hug') continue;
          // Skip when measured matches the explicitly-pinned size —
          // the RO is just confirming the size we already committed
          // (typical echo right after a `SET_NODE_GEOMETRY` commit)
          // and no structural change is needed.
          const dim = c.dimensions;
          const styleW = (child.style as { width?: number } | undefined)?.width;
          const styleH = (child.style as { height?: number } | undefined)
            ?.height;
          if (
            dim &&
            typeof styleW === 'number' &&
            typeof styleH === 'number' &&
            Math.abs(dim.width - styleW) <= 1 &&
            Math.abs(dim.height - styleH) <= 1
          ) {
            continue;
          }
          if (!framesToRelayout) framesToRelayout = new Set();
          framesToRelayout.add(parent.id);
        }
        if (framesToRelayout && framesToRelayout.size > 0) {
          scheduleDeferredFrameRelayout(
            framesToRelayout,
            () => get().nodes,
            () => get().edges,
            (nodes) => set({ nodes }),
          );
        }
      }

      if (isSnapSessionDragEndCommit(sanitized)) endSnapSession();
      if (isSnapSessionResizeEndCommit(sanitized)) endSnapSession();
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
        // Only edge `select` reaches this path (other persisted edge
        // mutations go through `CONNECT_NODES` / `DISCONNECT_EDGE`
        // commands above). Selection is transient UI state — bypass
        // autosave so toggling edge selection never schedules an empty
        // structure PUT.
        get()._setStateNoAutosave({
          edges: applyEdgeChanges(internalChanges, get().edges),
        });
      }
    },

    onConnect: (connection: Connection) => {
      get().dispatchUiIntent({
        type: 'CONNECT_EDGE',
        source: connection.source,
        target: connection.target,
        // Default every user-drawn connection to a forward arrow
        // (source → target). Users can still toggle the direction
        // afterward via the edge style controls.
        style: { direction: 'forward' },
      });
    },

    rfInstance: null,
    setRfInstance: (instance) => set({ rfInstance: instance }),

    canvasWrapper: null,
    setCanvasWrapper: (el) => set({ canvasWrapper: el }),

    viewport: null,
    setViewport: (viewport) => {
      // Skip no-op writes so passive `onMoveEnd` events (e.g. fired
      // after a programmatic setViewport that already matches the
      // current state) don't dirty the autosave diff.
      const current = get().viewport;
      if (
        current &&
        current.x === viewport.x &&
        current.y === viewport.y &&
        current.zoom === viewport.zoom
      ) {
        return;
      }
      set({ viewport });
      // Mirror into localStorage so reopening the browser or desktop app
      // restores this canvas's pan + zoom without a server round-trip.
      writeViewportToStorage(get().canvasId, viewport);
    },

    addNodes: (inputs) => {
      get().dispatchUiIntent({
        type: 'ADD_NODES',
        inputs,
      });
    },

    addNode: (input) => {
      get().addNodes([input]);
    },

    moveNoteExcerpt: ({ sourceNodeId, sourceContentAfterMove, newNote }) => {
      get().dispatchUiIntent({
        type: 'MOVE_NOTE_EXCERPT',
        sourceNodeId,
        sourceContentAfterMove,
        newNote,
      });
    },

    moveNoteBlockIntoNote: ({
      sourceNodeId,
      sourceContentAfterMove,
      targetNodeId,
      targetContentAfterInsert,
    }) => {
      get().dispatchUiIntent({
        type: 'MOVE_NOTE_BLOCK_INTO_NOTE',
        sourceNodeId,
        sourceContentAfterMove,
        targetNodeId,
        targetContentAfterInsert,
      });
    },

    moveSketchStrokesToRegion: ({
      sources,
      dropDelta,
      targetNodeId,
      dropPoint,
    }) => {
      // The transfer batch mixes caller-snapshot (`SET_NODE_GEOMETRY`) and
      // self-snapshot (`CREATE_NODES` / `DELETE_NODES`) commands, so bracket
      // it in the general data-gesture (arms + releases regardless of the
      // command mix) to fold everything into one undo entry.
      const before = get().nodes;
      get().beginNodeDataGesture();
      get().dispatchUiIntent({
        type: 'MOVE_SKETCH_STROKES_TO_REGION',
        sources,
        dropDelta,
        targetNodeId,
        dropPoint,
      });
      if (get().nodes === before) {
        // The resolver produced no applicable command (e.g. every source
        // vanished between selection and drop). Drop the optimistic
        // snapshot so no phantom empty undo entry is left behind.
        canvasHistoryManager.rollbackGestureSnapshot();
      } else {
        get().endNodeDataGesture();
      }
    },

    deleteNodes: (nodeIds) => {
      const sourceRefs = get().nodes.filter(
        (node) =>
          nodeIds.includes(node.id) &&
          (node.type === 'nodeRef' || node.type === 'frameRef'),
      );
      if (sourceRefs.length > 0) {
        void get().setPortalNodePins(
          sourceRefs.map((node) => {
            const target = (
              node.data as {
                target: { canvasId: string; nodeId: string };
              }
            ).target;
            return {
              sourceCanvasId: target.canvasId as `canvas-${string}`,
              sourceNodeIds: [target.nodeId as `node-${string}`],
              pinned: false,
            };
          }),
        );
      }
      const { spaceTitles, spaceTitlesLoaded } = useWorkspaceStore.getState();
      const nodesById = new Map(get().nodes.map((node) => [node.id, node]));
      const deletableNodeIds = nodeIds.filter((nodeId) => {
        const node = nodesById.get(nodeId);
        if (node?.type === 'nodeRef' || node?.type === 'frameRef') return false;
        if (node?.type !== 'canvasRef') return true;
        const targetCanvasId = node.data.targetCanvasId;
        return (
          spaceTitlesLoaded &&
          typeof targetCanvasId === 'string' &&
          !(targetCanvasId in spaceTitles)
        );
      });
      if (deletableNodeIds.length > 0) {
        const nodeRefTopologyBefore = nodeRefTopologySignature(get().nodes);
        get().dispatchUiIntent({
          type: 'DELETE_NODES',
          nodeIds: deletableNodeIds,
        });
        if (nodeRefTopologyBefore !== nodeRefTopologySignature(get().nodes)) {
          canvasHistoryManager.clear();
          set({ canUndo: false, canRedo: false });
        }
      }
    },

    disconnectEdges: (edgeIds) => {
      get().dispatchUiIntent({ type: 'DISCONNECT_EDGE', edgeIds });
    },

    setNodeGeometry: (items) => {
      get().dispatchUiIntent({ type: 'RESIZE_NODE', items });
    },

    previewResizeGeometry: resizePreviewController.previewResizeGeometry,

    captureFrameResizeSnapshot:
      resizePreviewController.captureFrameResizeSnapshot,

    applyFrameResizeScale: resizePreviewController.applyFrameResizeScale,

    flushFrameResizeScale: resizePreviewController.flushFrameResizeScale,

    clearFrameResizeSnapshot: resizePreviewController.clearFrameResizeSnapshot,

    setNoteHeightMode: (nodeIds, mode) => {
      if (nodeIds.length === 0) return;
      const idSet = new Set(nodeIds);
      const { nodes } = get();
      const items: Array<{
        nodeId: string;
        size: { width: number; height?: number | 'auto' };
      }> = [];

      for (const node of nodes) {
        if (!idSet.has(node.id)) continue;
        // Silently skip non-note ids — callers may pass mixed selections.
        if (node.type !== 'note') continue;

        // Prefer the explicit pinned width; fall back to the rendered
        // (measured) width for auto-width notes so the toggle doesn't
        // accidentally collapse the node to width 0.
        const styleW = node.style?.width as number | undefined;
        const { width: measuredW, height: measuredH } = getNodeSize(node);
        const w = typeof styleW === 'number' && styleW > 0 ? styleW : measuredW;
        if (!Number.isFinite(w) || w <= 0) continue;

        if (mode === 'auto') {
          items.push({
            nodeId: node.id,
            size: { width: w, height: 'auto' },
          });
        } else {
          // Auto → fixed: seed from remembered → measured (capped) → default.
          // `getNoteFixedHeight` reads the session-scoped memory populated
          // by `useTrackNoteFixedHeight` (mounted inside each NoteNode).
          const remembered = getNoteFixedHeight(node.id);
          const seed = seedNoteFixedHeight(remembered, measuredH);
          items.push({
            nodeId: node.id,
            size: { width: w, height: seed },
          });
        }
      }

      if (items.length === 0) return;

      // Fixed → auto hands the height back to the renderer, which needs a
      // measurement to hand back *to*. A pinned note has none: it renders
      // inside a box the user chose, so nothing it reports there is a
      // trustworthy intrinsic height. Measuring offscreen is exact and
      // works even for a note that is zoomed out far enough never to have
      // hydrated.
      //
      // The measurement and the toggle then land in one executor batch,
      // so the node goes straight to its content height instead of
      // collapsing to the policy minimum and expanding a frame later.
      // Notes whose hint is already current skip the measurement.
      void (async () => {
        const measurements = await measureMissingAutoHeights(
          mode === 'auto' ? items.map((item) => item.nodeId) : [],
          get,
        );

        // SET_NODE_GEOMETRY uses snapshot:'caller'; open a gesture so the
        // batch is captured as one undo entry without warnings. The
        // measurement rides the same batch, so undo restores the pinned
        // height in one step.
        get().beginGesture('SET_NODE_GEOMETRY');
        get().executeCommands(
          [
            {
              type: 'SET_NODE_GEOMETRY',
              items: items.map((item) => ({
                nodeId: item.nodeId as CanvasNodeId,
                size: item.size,
              })),
            },
            ...(measurements.length > 0
              ? [
                  {
                    type: 'APPLY_MEASURED_HEIGHT' as const,
                    items: measurements,
                  },
                ]
              : []),
          ],
          'ui',
        );
      })();
    },

    applyMeasuredHeights: (items) => {
      if (items.length === 0) return;
      get().executeCommands(
        [{ type: 'APPLY_MEASURED_HEIGHT', items }],
        'system',
      );
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

    convertNodeType: (nodeId, to) => {
      // Guard: refuse to mutate the node type while the inline editor is
      // open on this node. The expanded editor holds dirty state that would
      // otherwise be flushed back onto a node whose type just changed,
      // overwriting the conversion. The toolbar disables the toggle in this
      // state — this is a defensive backstop for programmatic callers.
      const { expandedNodeId, ingestionByNodeId } = get();
      if (expandedNodeId === nodeId) return;
      // Guard: don't change type mid-ingest, otherwise the in-flight ingest
      // result would land on a node that no longer matches its source type.
      if (ingestionByNodeId[nodeId]?.status === 'pending') return;
      get().dispatchUiIntent({ type: 'CONVERT_NODE_TYPE', nodeId, to });
    },

    beginGesture: (commandType) => {
      // Caller-snapshot gestures (drag / resize) arm here; the closing
      // caller-snapshot command consumes the flag inside `executeCommands`.
      if (COMMAND_META[commandType].snapshot === 'caller') {
        const { nodes, edges } = get();
        armGestureSnapshot(nodes, edges);
      }
    },

    beginNodeDataGesture: () => {
      // Bracket a burst of live `updateNodeData` ticks into ONE undo entry.
      // `MERGE_NODE_DATA` self-snapshots ('yes') and so never consumes the
      // flag, hence the explicit `endNodeDataGesture` counterpart below.
      const { nodes, edges } = get();
      armGestureSnapshot(nodes, edges);
    },

    endNodeDataGesture: () => {
      // Release the flag so the next unrelated edit snapshots normally.
      canvasHistoryManager.consumeGestureSnapshot();
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

    minimapEnabled: readMinimapEnabledFromStorage(),
    toggleMinimap: () => {
      const next = !get().minimapEnabled;
      writeMinimapEnabledToStorage(next);
      set({ minimapEnabled: next });
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
      const { nodes, edges } = get();
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

      // Capture edges whose BOTH endpoints are in the copied set, so the
      // paste helper can remap them onto the freshly-created node ids.
      // Edges that straddle the selection boundary are dropped (no remote
      // endpoint to point at on the destination canvas).
      const clonedEdges: Edge[] = edges
        .filter((e) => selectedIds.has(e.source) && selectedIds.has(e.target))
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...(e.data ? { data: JSON.parse(JSON.stringify(e.data)) } : {}),
        }));

      // The serialized payload rides in `text/html` so that pasting back into
      // Huabu preserves node identity, while foreign applications receive an
      // image or readable text instead of JSON. See the clipboard contract in
      // `docs/architecture/web-architecture.md`.
      const payload = JSON.stringify({
        __huabu_nodes__: cloned,
        __huabu_edges__: clonedEdges,
        __huabu_canvas_id__: get().canvasId,
      });
      const singleImage =
        cloned.length === 1 &&
        cloned[0].type === 'image' &&
        typeof cloned[0].data?.src === 'string'
          ? {
              src: resolveArtifactUrl(
                cloned[0].data.src,
                get().canvasId ?? undefined,
              ),
              label:
                typeof cloned[0].data?.label === 'string'
                  ? cloned[0].data.label
                  : undefined,
            }
          : undefined;

      void copyCanvasClipboard({
        payload,
        plainText: nodesToPlainText(cloned),
        image: singleImage,
      });
    },

    pasteNodes: (flowPosition, clipboardNodes, clipboardEdges, srcCanvasId) => {
      const dstCanvasId = get().canvasId;
      if (!dstCanvasId || clipboardNodes.length === 0) return;
      clipboardNodes = clipboardNodes.filter(
        (node) =>
          node.type !== 'canvasRef' &&
          node.type !== 'frameRef' &&
          node.type !== 'nodeRef',
      );
      if (clipboardNodes.length === 0) return;

      // ── Question-node conversation handling ─────────────────────────
      // A copied question node that already holds a conversation is
      // special-cased:
      //   - fork the thread server-side so the copy keeps the same history
      //     but continues on its own independent thread
      //     (`resolvePasteClipboard` preserves the new threadId for nodes
      //     flagged `__forkConversation`).
      // Never-run / empty question nodes fall through to a plain fresh
      // copy (the resolver resets their runtime state as before).
      const forkTasks: { srcThreadId: string; dstThreadId: string }[] = [];
      const prepared: Node[] = [];
      for (const node of clipboardNodes) {
        const data = (node.data ?? {}) as Record<string, unknown>;
        const isQuestion = node.type === 'question' || data.type === 'question';
        const threadId =
          typeof data.threadId === 'string' ? data.threadId : undefined;
        const status = data.status;
        const hasConversation =
          isQuestion &&
          !!threadId &&
          (status === 'done' || status === 'error' || status === 'running');
        if (hasConversation) {
          const dstThreadId = createId('thread');
          forkTasks.push({ srcThreadId: threadId, dstThreadId });
          prepared.push({
            ...node,
            data: {
              ...data,
              threadId: dstThreadId,
              status: 'done',
              errorMessage: undefined,
              __forkConversation: true,
            },
          });
          continue;
        }
        prepared.push(node);
      }

      clipboardNodes = prepared;

      // Fire the server-side history forks. The copy
      // already points at its new threadId, but until the server finishes
      // copying the history the node must not be opened (it would load an
      // empty conversation). We flag each new threadId as fork-pending up
      // front and clear it when the fork settles, so `QuestionNode` can
      // gate opening until the history is ready.
      const runForks = () => {
        if (forkTasks.length === 0) return;
        const sourceCanvasId = srcCanvasId ?? dstCanvasId;

        set({
          pendingForkThreadIds: {
            ...get().pendingForkThreadIds,
            ...Object.fromEntries(
              forkTasks.map((t) => [t.dstThreadId, true as const]),
            ),
          },
        });

        const clearPending = (threadId: string) => {
          const next = { ...get().pendingForkThreadIds };
          delete next[threadId];
          set({ pendingForkThreadIds: next });
        };

        void Promise.all(
          forkTasks.map((t) =>
            agentApi
              .forkThread(
                t.srcThreadId,
                t.dstThreadId,
                sourceCanvasId,
                dstCanvasId,
              )
              .catch((err) => {
                console.warn(
                  '[paste] Failed to fork question conversation',
                  err,
                );
                toast('Failed to copy a conversation', { tone: 'danger' });
              })
              .finally(() => clearPending(t.dstThreadId)),
          ),
        );
      };

      // Same-canvas pastes leave artifact keys as-is (the artifact is
      // already owned by this canvas). Cross-canvas pastes clone the
      // underlying file so the destination canvas owns its own copy —
      // otherwise deleting the source canvas would orphan the pasted
      // node. Artifacts reach a node two ways: a dedicated top-level
      // field (`ARTIFACT_DATA_FIELDS`) or an image embedded in a
      // Markdown body (`markdownArtifactFields`, e.g. a note's
      // `content`). Both must be walked, otherwise a note pastes with
      // its images still pointing at the source canvas.
      //
      // We only know it's a cross-canvas paste when the clipboard
      // payload carries `srcCanvasId` AND it differs from the current
      // canvas. Legacy clipboard payloads (no srcCanvasId) — or payloads
      // copied from this same canvas — fall through to the synchronous
      // fast path.
      const needsClone =
        !!srcCanvasId &&
        srcCanvasId !== dstCanvasId &&
        clipboardNodes.some((node) => {
          const data = (node.data ?? {}) as Record<string, unknown>;
          if (ARTIFACT_DATA_FIELDS.some((f) => parseArtifactRef(data[f])))
            return true;
          return markdownArtifactFields(data).some((field) => {
            const v = data[field];
            return (
              typeof v === 'string' && collectMarkdownArtifactRefs(v).length > 0
            );
          });
        });

      const dispatch = (nodes: Node[]) => {
        get().dispatchUiIntent({
          type: 'PASTE_CLIPBOARD',
          flowPosition,
          clipboardNodes: nodes,
          ...(clipboardEdges && clipboardEdges.length > 0
            ? { clipboardEdges }
            : {}),
        });
      };

      // Fast path: nothing to clone — preserve the prior synchronous
      // behaviour so simple intra-canvas pastes feel instant.
      if (!needsClone || !srcCanvasId) {
        dispatch(clipboardNodes);
        runForks();
        return;
      }

      void (async () => {
        // One clone per distinct source artifact, shared across every
        // node and every reference in this paste (the same image may be
        // embedded several times in one note, or reused across notes).
        const clones = new Map<string, Promise<string | null>>();
        const cloneRef = (ref: {
          canvasId: string | null;
          key: string;
        }): Promise<string | null> => {
          const from = ref.canvasId ?? srcCanvasId;
          if (from === dstCanvasId) return Promise.resolve(null);
          const cacheKey = `${from}/${ref.key}`;
          let pending = clones.get(cacheKey);
          if (!pending) {
            // Best effort — a failed clone falls back to the original
            // key. The new node then renders with the missing-file
            // placeholder (artifactMissing flag from the server) so the
            // user can still remove it.
            pending = cloneArtifactToCanvas(from, ref.key, dstCanvasId).catch(
              (err) => {
                console.warn(
                  '[paste] Failed to clone artifact for cross-canvas paste',
                  err,
                );
                return null;
              },
            );
            clones.set(cacheKey, pending);
          }
          return pending;
        };

        const remapped = await Promise.all(
          clipboardNodes.map(async (node) => {
            const data = { ...((node.data ?? {}) as Record<string, unknown>) };
            let mutated = false;

            for (const field of ARTIFACT_DATA_FIELDS) {
              const value = data[field];
              const ref = parseArtifactRef(value);
              if (!ref) continue;
              const newKey = await cloneRef(ref);
              if (newKey && newKey !== value) {
                data[field] = newKey;
                mutated = true;
              }
            }

            for (const field of markdownArtifactFields(data)) {
              const markdown = data[field];
              if (typeof markdown !== 'string' || markdown.length === 0)
                continue;
              const refs = collectMarkdownArtifactRefs(markdown);
              if (refs.length === 0) continue;
              const rewrites = new Map<string, string>();
              await Promise.all(
                refs.map(async (raw) => {
                  const ref = parseArtifactRef(raw);
                  if (!ref) return;
                  const newKey = await cloneRef(ref);
                  if (newKey && newKey !== raw) rewrites.set(raw, newKey);
                }),
              );
              if (rewrites.size === 0) continue;
              const next = rewriteMarkdownArtifactRefs(markdown, (raw) =>
                rewrites.get(raw),
              );
              if (next !== markdown) {
                data[field] = next;
                mutated = true;
              }
            }

            return mutated ? { ...node, data } : node;
          }),
        );
        // `dispatch` / `runForks` act on whatever canvas the store is
        // showing *now*, but the work above was scoped to the canvas
        // that was active when the paste started. Cloning takes one
        // round-trip per embedded image, which is more than enough time
        // for the user to switch Spaces — dropping the paste beats
        // landing it on the wrong canvas.
        if (get().canvasId !== dstCanvasId) return;
        dispatch(remapped);
        runForks();
      })();
    },

    canUndo: false,
    canRedo: false,

    undo: () => {
      const { nodes, edges, canvasId } = get();
      const snapshot = canvasHistoryManager.undo(nodes, edges);
      if (!snapshot) return;

      // Undo swaps in authoritative geometry, so any retained stroke
      // selection / polygon may no longer describe it (e.g. the classic
      // "move strokes then undo" strands the dashed region at the moved
      // position while the strokes revert). Drop the whole floating
      // selection — the delta is unknowable from a generic undo, so
      // re-homing the polygon is not possible; clearing is the safe,
      // reload-consistent choice.
      useGesturePreviewStore.getState().resetCanvasScopedTransients();

      const action: RecentAction = { action: 'canvas_undone' };
      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      });
      intentActionWindow.push(action);
      canvasEvents.buffer(canvasId, action);

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        preprocessQueue.schedule,
        {
          originator: { source: 'ui', tabId: canvasSyncTabId },
          onResponse: consumeMutationPublication,
        },
      );
    },

    redo: () => {
      const { nodes, edges, canvasId } = get();
      const snapshot = canvasHistoryManager.redo(nodes, edges);
      if (!snapshot) return;

      // See `undo`: a redo is the same authoritative geometry swap, so
      // discard the floating stroke selection for the same reason.
      useGesturePreviewStore.getState().resetCanvasScopedTransients();

      const action: RecentAction = { action: 'canvas_redone' };
      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
      });
      intentActionWindow.push(action);
      canvasEvents.buffer(canvasId, action);

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        preprocessQueue.schedule,
        {
          originator: { source: 'ui', tabId: canvasSyncTabId },
          onResponse: consumeMutationPublication,
        },
      );
    },
  })),
);

export default useCanvasStore;
