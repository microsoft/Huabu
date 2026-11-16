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
import deepEqual from 'fast-deep-equal';
import { t } from 'i18next';
import { create, type StateCreator } from 'zustand';

import {
  ARTIFACT_DATA_FIELDS,
  collectMarkdownArtifactRefs,
  createId,
  markdownArtifactFields,
  parseArtifactRef,
  parseBasis,
  rewriteMarkdownArtifactRefs,
  stripLegacyPortalTopology,
} from '@huabu/shared';
import {
  COMMAND_META,
  hasValidNodeProperties,
  autoHeightContentWidth,
  preserveAgentNodeOwnedData,
  projectAgentNodeEditableData,
  replayAgentNodeEditableData,
  stripTransientNodeFields,
  applyDeltas,
  applySharedPostEffects,
  applySharedPostEffectsFromWriteResult,
  executeCanvasCommands,
  autoHeightKey,
  getHeightPolicy,
  measuredSizeKey,
  readAutoHeightHint,
  readMeasuredSizeHint,
  resolveHeightMode,
  includePdfNotes,
  FRAME_POINTER_CAPTURE_MARGIN,
  getAbsolutePosition as getFrameAbsolutePosition,
  getFrameSizing,
  isAlwaysAutoHeightNodeType,
  wouldUnframe,
  wouldStickToStructuredFrame,
  wouldAutoFrame,
  readFrameGridConfig,
  rerouteAllEdges,
  resolveFrameTrackCount,
  describeStructuredDropZone,
  getNodeSize,
  moveNodeIntoContainer as projectNodeIntoFrame,
  moveNodeOutOfFrame as projectNodeOutOfFrame,
  normalizeTreeOrder,
  projectAffectedFrameGeometry,
  type AlignDirection,
  type Delta,
  type ExecutorOptions,
  type NestableNode,
  type SetSiblingOrderEvent,
} from '@huabu/shared/canvas-engine';

import { runWebPostEffects } from '@/handler/canvasCommand/postEffects.web';
import {
  resolveUiIntent,
  type AddNodeInput,
  type CanvasUiIntent,
  type UiResolverState,
} from '@/handler/canvasCommand/uiIntent';
import {
  compensateDetachedDragPosition,
  getDragPointerPosition,
  mergeLiveDragGeometry,
} from '@/handler/liveDragGeometry';
import {
  isPointInTrackGap,
  resolveGridDrop,
  getGridDragGroup,
  gridDragRequests,
  resolveMasonryDrop,
} from '@/handler/masonryDrop';
import { projectStructuredTargetGeometry } from '@/handler/projectStructuredTargetGeometry';
import {
  applySnap,
  beginSnapSession,
  clearDragDecisions,
  consumeLastDragDecisions,
  consumeLastDragReparentBypass,
  consumeLastNestedFrameEntryAllowed,
  endSnapSession,
  getResizeContext,
  getResizeSnappedRect,
  isReparentBypassed,
  isNestedFrameEntryAllowed,
  isSnapSessionActive,
  isSnapSessionDragEndCommit,
  isSnapSessionResizeEndCommit,
  setSnapStructuredSuppressed,
  writeDragDecision,
} from '@/handler/snap/snapSession';
import { getElectronBridge } from '@/hooks/useElectron';
import { getCanvasViewportCenter } from '@/utils/canvasViewport';
import {
  desktopStorageKey,
  readApplicationPreference,
  writeApplicationPreference,
} from '@/utils/desktopStorage';
import { pageLifecycle } from '@/utils/pageLifecycle';
import {
  changedSpaceEntries,
  isVisibleWorldNode,
  REQUEST_DELETE_SPACE,
} from '@/utils/spaceHierarchy';

import { canvasHistoryManager } from './canvasHistoryManager';
import { canStartEditing } from './canvasPresence/editLock';
import { useIdentityStore } from './identityStore';
import { useWorkspaceStore } from './workspaceStore';
import { getCanvas, postCanvasExecute, associateAgentNode } from '../api';
import { ApiError } from '../api/_client';
import { agentApi } from '../api/agent';
import { cloneArtifactToCanvas, resolveArtifactUrl } from '../api/artifact';
import {
  CanvasConflictError,
  NodeDuplicateFilesError,
  getCanvasAccess,
} from '../api/canvas';
import { renameSpace } from '../api/spaceCard';
import { measureMissingAutoHeights } from './canvasStore/height/measureMissingAutoHeights';
import { normalizeFrameHeaderInsets } from './canvasStore/load/normalizeFrameHeaderInsets';
import { normalizeNodeHeights } from './canvasStore/load/normalizeNodeHeights';
import { reconcileQuestionStatus } from './canvasStore/load/reconcileQuestionStatus';
import { shouldBackfillNodeLabel } from './canvasStore/load/shouldBackfillNodeLabel';
import { warmupNodeHeights } from './canvasStore/load/warmupNodeHeights';
import { createCanvasEventBuffer } from './canvasStore/save/eventBuffer';
import { NODE_CONTENT_KEYS } from './canvasStore/save/nodeContentFields';
import {
  createNodeContentQueue,
  type RemoteContentOutcome,
} from './canvasStore/save/nodeContentQueue';
import { createPreprocessQueue } from './canvasStore/save/preprocessQueue';
import { createUnloadFlush } from './canvasStore/save/unloadFlush';
import { replaySiblingOrder } from './canvasStore/siblingOrderReplay';
import { createResizePreviewController } from './canvasStore/slices/resizePreview';
import {
  createBrowserSync,
  type PreparedRemote,
} from './canvasStore/sync/browserSync';
import { restoreChanged } from './canvasStore/sync/historyRestore';
import { deriveHeldKeys, nodeUnitKey } from './canvasStore/sync/inFlight';
import {
  commandsForLocalDiff,
  commandsForStateDiff,
} from './canvasStore/sync/localDiffCommands';
import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';
import {
  applyUnits,
  changedUnits,
  PARENT_UNIT,
  PLACEMENT_UNITS,
  writeUnit,
  type UnitNode,
} from './canvasStore/sync/propertyUnits';
import {
  planRestore,
  type PlanState,
  type RestorePlan,
} from './canvasStore/sync/restorePlan';
import {
  commandsForServer,
  withClientIds,
} from './canvasStore/sync/serverCommands';
import { useChatStore } from './chatStore';
import { useGesturePreviewStore } from './gesturePreviewStore';
import { usePanelStore } from './panelStore';
import {
  selectActiveNodeId,
  selectIsNodeOpen,
  usePreviewWorkspaceStore,
} from './previewWorkspace/store';
import { useToolStore } from './toolStore';
import { toast, dismissToast } from '../components/Common/Toast';
import { seedNoteFixedHeight } from '../components/Nodes/note/autoHeight';
import { getNoteFixedHeight } from '../components/Nodes/note/heightMemory';
import {
  resumeHeightCommits,
  suspendHeightCommits,
} from '../components/Nodes/shared/height/commitSuspension';
import { copyCanvasClipboard } from '../utils/io/clipboard';
import { nodesToPlainText } from '../utils/io/nodeToPlainText';
import {
  syncStateOf,
  useCanvasSyncStatusStore,
  type CanvasSyncState,
} from './canvasStore/sync/syncStatus';

import type { SendOutcome } from './canvasStore/sync/sendQueue';
import type {
  FrameFitPreview,
  FrameFitPreviewRole,
  StructuredDropPreview,
} from './gesturePreviewStore';
import type { CanvasPreviewWorkspace } from './previewWorkspace/model';
import type { NodeIngestionInfo } from '@/handler/canvasCommand/preprocess';
import type {
  AgentChatContext,
  CanvasCommand,
  CanvasCommandType,
  CanvasContentPosition,
  CanvasExecution,
  CanvasExecutionSource,
  CanvasNodeId,
  CanvasNodeMeasuredHeightUpdate,
  CanvasNodeMeasuredSizeUpdate,
  CanvasNodeType,
  CanvasViewport,
  CanvasAccess,
  RecentAction,
  WireSelectionNode,
  PutNodeContentRequest,
} from '@huabu/shared';

const PREPROCESS_DEBOUNCE_MS = 1000;
const NODE_CONTENT_DEBOUNCE_MS = 500;
let accessRefreshInFlight:
  | { canvasId: string; promise: Promise<void> }
  | undefined;

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
    return parseStoredViewport(
      localStorage.getItem(desktopStorageKey(key)) ?? localStorage.getItem(key),
    );
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
      desktopStorageKey(viewportStorageKey(pending.canvasId)),
      JSON.stringify(pending.viewport),
    );
  } catch {
    // Viewport persistence must never block interaction.
  }
}

export function flushCanvasViewState(): void {
  flushViewportWrite();
  usePreviewWorkspaceStore.getState().flush();
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

// ─── MiniMap-visibility preference ────────────────────────────────────────
//
// Whether the canvas MiniMap overlay is shown is a global UI preference
// (not per-canvas), persisted by the application preference adapter. Defaults to off so
// first-time users get the cleaner canvas; once toggled in Settings the choice
// survives refreshes / restarts.

const MINIMAP_STORAGE_KEY = 'huabu.minimapEnabled';

function readMinimapEnabledFromStorage(): boolean {
  try {
    return readApplicationPreference(MINIMAP_STORAGE_KEY) === 'true';
  } catch {
    // Private mode / disabled storage — treat as off.
    return false;
  }
}

function writeMinimapEnabledToStorage(value: boolean): void {
  try {
    writeApplicationPreference(MINIMAP_STORAGE_KEY, String(value));
  } catch (error) {
    console.error('Could not save MiniMap visibility:', error);
    toast(error instanceof Error ? error.message : String(error), {
      tone: 'danger',
    });
    if (getElectronBridge()?.tabs) throw error;
  }
}

// ─── Per-node content flush ────────────────────────────────────────────────

export type NodeMetadataPatch = Pick<
  PutNodeContentRequest,
  'properties' | 'propertyDisplayKeys'
>;

/** Publish acknowledged property edits; only the toast retains a failed patch. */
export async function commitNodeProperties(
  nodeId: string,
  patch: Pick<NodeMetadataPatch, 'properties' | 'propertyDisplayKeys'>,
): Promise<boolean> {
  const { canvasId, nodes } = useCanvasStore.getState();
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  const original = nodes.find((node) => node.id === nodeId);
  let pending = false;
  const attempt = async (): Promise<boolean> => {
    if (pending) return false;
    pending = true;
    let submitted = false;
    try {
      const state = useCanvasStore.getState();
      const node = state.nodes.find((item) => item.id === nodeId);
      if (
        state.canvasId !== canvasId ||
        useWorkspaceStore.getState().workspaceId !== workspaceId ||
        !node ||
        !original ||
        !selectCanWriteCanvas(state) ||
        state.isLoading
      )
        throw new Error(t('node.propertiesRetryUnavailable'));
      const currentProperties = node.data.properties as
        | Record<string, unknown>
        | undefined;
      const originalProperties = original.data.properties as
        | Record<string, unknown>
        | undefined;
      if (
        Object.keys(patch.properties ?? {}).some(
          (key) =>
            !deepEqual(currentProperties?.[key], originalProperties?.[key]),
        ) ||
        (patch.propertyDisplayKeys &&
          !deepEqual(
            node.data.propertyDisplayKeys,
            original.data.propertyDisplayKeys,
          ))
      )
        throw new Error(t('node.propertiesRetryUnavailable'));
      if (!hasValidNodeProperties(patch, true))
        throw new Error('Invalid node properties');
      submitted = true;
      await nodeContentQueue.commitProperties(state.canvasId, nodeId, patch);
      if (
        useCanvasStore.getState().canvasId !== canvasId ||
        useWorkspaceStore.getState().workspaceId !== workspaceId
      ) {
        submitted = false;
        throw new Error(t('node.propertiesRetryUnavailable'));
      }
      return true;
    } catch (error) {
      console.error('Property edit failed:', nodeId, error);
      const retryable =
        submitted &&
        !(error instanceof CanvasConflictError) &&
        !(error instanceof NodeDuplicateFilesError) &&
        !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        );
      toast(
        submitted
          ? t('node.propertiesSaveFailed')
          : error instanceof Error
            ? error.message
            : String(error),
        {
          tone: 'danger',
          duration: 0,
          dismissible: true,
          ...(retryable
            ? {
                action: {
                  label: t('messages.retry'),
                  onClick: () => {
                    void attempt();
                  },
                },
              }
            : {}),
        },
      );
      return false;
    } finally {
      pending = false;
    }
  };
  return attempt();
}

/** Save through the ordinary queue; rejection leaves the optimistic edit intact. */
export async function commitNodeMetadata(
  nodeId: string,
  patch: NodeMetadataPatch,
): Promise<void> {
  const state = useCanvasStore.getState();
  const workspaceId = useWorkspaceStore.getState().workspaceId;
  if (!selectCanWriteCanvas(state) || state.isLoading)
    throw new Error('Canvas is not editable');
  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error('Node no longer exists');
  if (!hasValidNodeProperties(patch, true))
    throw new Error('Invalid node metadata');
  state.updateNodeData(nodeId, patch);
  await nodeContentQueue.flushNow(state.canvasId, nodeId, { source: 'user' });
  if (
    useCanvasStore.getState().canvasId !== state.canvasId ||
    useWorkspaceStore.getState().workspaceId !== workspaceId
  )
    throw new Error('Space changed while saving');
  if (
    !useCanvasStore
      .getState()
      .nodes.some((candidate) => candidate.id === nodeId) ||
    nodeContentQueue.pendingFields(nodeId).size > 0
  )
    throw new Error(
      'Node metadata is not saved; resolve the pending save before continuing',
    );
}

//
// Markdown sidecar persistence (debounced per-node PUT + serialized
// in-flight chain) lives in `./canvasStore/save/nodeContentQueue.ts`.
// The factory call is in the module-scope singletons section below.

// ── Spatial data ──────────────────────────────────────────────
//
// The frontend no longer normalises spatial data for the LLM.
// `/api/agent` resolves the anchor node's neighbourhood server-side
// from persisted topology (see `apps/server/src/modules/agent/
// node-neighbourhood.ts`); the web bundle only sends `anchorNodeId`.
//
// Existing UI-side proximity queries (frame drop targets) call shared
// geometry helpers directly with their own React Flow nodes — no central
// cache is needed.

type RFState = {
  nodes: Node[];
  edges: Edge[];
  canvasId: string;
  /** Permissions are tied to this exact Space; null is unknown in Bubble. */
  canvasAccess: (CanvasAccess & { canvasId: string }) | null;
  /** Refresh permissions alone, retaining dirty content and history. */
  refreshCanvasAccess: () => Promise<void>;
  version: number;
  /**
   * The content position this page's node content is valid from: every
   * content save up to it is shown (or being fetched). Set by a load, and
   * moved on by the sync store each time it has asked the server for the
   * saves after it. `null` until a load has brought one.
   */
  contentPosition: CanvasContentPosition | null;
  isLoading: boolean;
  canvasNotFound: boolean;
  moveSelectionDialogOpen: boolean;
  moveSelectionAnchor: HTMLElement | null;
  setMoveSelectionDialogOpen: (
    open: boolean,
    anchor?: HTMLElement | null,
  ) => void;

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

  pendingInlineEditNodeId: string | null;
  consumeInlineEditRequest: (nodeId: string) => void;

  pendingRevealNodeIds: string[];
  consumeRevealRequest: (nodeIds: string[]) => void;

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
  deleteNodes: (nodeIds: string[], edgeIds?: string[]) => void;
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
  /**
   * A pointer gesture ended. Sends what its live ticks changed if no command
   * batch has closed it yet, so nothing a preview moved is left unsent.
   */
  closePointerGesture: () => void;
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
   * it is this client's view state, never sent to the server.
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
    activeId: string | string[],
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
    nodeId: string | string[],
    frameId: string,
    reorderTarget?: { nodeId: string; position: 'before' | 'after' },
  ) => void;
  moveNodeOutOfFrame: (
    nodeId: string | string[],
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
    options?: { resetHistory?: boolean },
  ) => Promise<void>;
  switchCanvas: (canvasId: string) => Promise<void>;

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
    options?: Pick<ExecutorOptions, 'frozenStructuredGutters'> & {
      /**
       * A gesture preview tick: run and show the result, send nothing. The
       * batch that closes the gesture carries what the ticks changed.
       */
      localOnly?: boolean;
    },
  ) => void;
  /**
   * @internal Apply a server-authored delta batch (M2 headless executor).
   *
   * Bypasses the local engine — the server has already executed the
   * commands, persisted topology and content, and given us the
   * structural diff to apply. We still snapshot for undo, drive the
   * web-only post-effects (preprocessing trigger, AI-edit flag, etc.),
   * and reconcile our local `version` to `toVersion`.
   *
   * Commits through `_setStateNoAutosave` because the server is already
   * authoritative for this batch.
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
    agentNodeProjection?: boolean,
    /**
     * The batch's sibling paint order, installed after its deltas.
     * `onDiverged` runs when it could not be installed, the local order is
     * not the server's, and there is no unsaved local edit to protect; the
     * entity changes and the version are applied either way.
     */
    order?: {
      events?: readonly SetSiblingOrderEvent[];
      onDiverged?: () => void;
    },
    /**
     * Where the batch came from: the request id its writer supplied (this
     * page recognises its own) and the writer's kind. A person's edit, from
     * this page or another, takes no undo snapshot here.
     */
    sync?: { operationId?: string; source?: 'ui' | 'agent' | 'system' },
  ) => string[];
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
  getAgentChatContext: (selection?: AgentSourceSelection) => AgentChatContext;

  /**
   * Force-flush any buffered behavioural events to the server.
   *
   * Call this immediately before kicking off an agent or intent
   * request so the server-side action log is current when it builds
   * the request context. Resolves once the in-flight POST settles
   * (success or fail); a failed flush is retried on the next trigger.
   */
  flushCanvasEvents: (canvasId?: string) => Promise<void>;
};

function canChangeSpaceEntries(
  canvasId: string,
  previous: Node[],
  next: Node[],
): boolean {
  const workspace = useWorkspaceStore.getState();
  for (const node of changedSpaceEntries(previous, next)) {
    const target = node.data.targetCanvasId;
    if (typeof target !== 'string') continue;
    const summary = workspace.spaceSummaries[target];
    if (
      workspace.spaceTitlesStatus !== 'ready' ||
      (!summary && Object.hasOwn(workspace.spaceTitles, target))
    ) {
      toast(t('spaceHierarchy.ownershipUnavailable'), { tone: 'warning' });
      void workspace.refreshSpaceTitles();
      return false;
    }
    if (
      summary?.parentSpaceId === canvasId &&
      summary.parentEntryNodeId === node.id
    ) {
      toast(t('spaceHierarchy.entryProtected'), { tone: 'warning' });
      return false;
    }
  }
  return true;
}

// ─── Outgoing event buffer ────────────────────────────────────────────────
//
// Every `RecentAction` produced by a UI intent / undo / redo is mirrored
// into this in-memory buffer (keyed by canvasId) and uploaded to the
// server via `POST /api/canvas/:id/events` on three triggers:
//
//   1. Send-queue piggy-back — the buffer is flushed whenever the queue of
//      structure edits has drained, so events follow the edits they log.
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
 * Module-scoped per-node preprocessing queue. Each store mutation
 * that affects a markdown-backed node schedules a debounced
 * `preprocessNode` POST through this queue.
 */
const preprocessQueue = createPreprocessQueue({
  delayMs: PREPROCESS_DEBOUNCE_MS,
  getState: () => useCanvasStore.getState(),
  isBlocked: (nodeId) =>
    nodeContentQueue.hasPendingRestoredContent(nodeId) ||
    restoringNodeIds.has(nodeId),
});

/**
 * Module-scoped per-node markdown sidecar save queue. Coalesces rapid
 * editor edits into one PUT per node and serializes in-flight writes
 * so the server never sees two PUTs for the same node concurrently.
 */
const nodeContentQueue = createNodeContentQueue({
  delayMs: NODE_CONTENT_DEBOUNCE_MS,
  getState: () => useCanvasStore.getState(),
  waitForCreation: awaitQuestionCreation,
  retryCreation: (canvasId, nodeId) => retryFailedRestores(canvasId, nodeId),
  onRestoredContentPersisted: (canvasId, nodeId) =>
    preprocessQueue.resumeRestored(canvasId, nodeId),
  onContentPersisted: (canvasId, nodeId) => {
    // A reload that was waiting for this text can run now.
    resumeReloadHeldForContent();
    // The server now has the body this node was measured against.
    if (useCanvasStore.getState().canvasId !== canvasId) return;
    if (heightsAwaitingContent.delete(nodeId))
      reportMeasuredHeights([nodeId], undefined, nodeId);
    if (sizesAwaitingContent.delete(nodeId))
      reportMeasuredSizes([nodeId], undefined, nodeId);
  },
  pageId: CANVAS_PAGE_ID,
  onRemoteContentAdopted: (canvasId, nodeId, patch) =>
    canvasHistoryManager.rebaseRemoteContent(canvasId, nodeId, patch),
  onPropertiesSaved: (nodeId, patch) =>
    useCanvasStore.getState().updateNodeData(nodeId, patch),
});

// ─── Structure edits through execute ──────────────────────────────────────
//
// A `ui` command batch runs locally first, then the same commands are sent
// to `POST /execute` through a serial queue (see `./canvasStore/sync/`).
// The server's `update` for that batch — from the Canvas Sync stream, or the
// request's own response when it is the next contiguous version — is replayed
// field by field, so it cannot overwrite a property this page changed again
// meanwhile. This queue is the only writer of structure: nothing saves the
// whole Space.

/** Identifies this page in `originator.tabId`; a reload gets a new one. */
const SYNC_CLIENT_ID = CANVAS_PAGE_ID;

/**
 * Nodes as they were when the current pointer gesture began. Live drag and
 * resize ticks move nodes without a command; the batch that closes the
 * gesture holds what changed since this state, not only since its own start.
 */
let syncGestureBaseline: Node[] | null = null;

/**
 * Nodes whose parent another page changed while the open gesture held their
 * placement. The page kept showing them under their own parent, which is no
 * longer the one the server has (and `syncGestureBaseline` has been brought
 * up to).
 */
const gestureWithheldParents = new Set<string>();

/**
 * Close the open gesture's sync bookkeeping (or restart it from `next`).
 *
 * A gesture that kept another page's parent change back has ended: whatever
 * it sent states a read version from before that change, so the server
 * refuses it, and a gesture that sent nothing left the page behind the server. Either way the
 * page converges by loading the Space once nothing is left to send.
 */
function endSyncGesture(next: Node[] | null = null): void {
  syncGestureBaseline = next;
  if (gestureWithheldParents.size === 0) return;
  gestureWithheldParents.clear();
  const { canvasId } = useCanvasStore.getState();
  // After the caller has queued the gesture's batch, never before it.
  if (canvasId) queueMicrotask(() => browserSync.deferReload(canvasId));
}

/** The node and edge lists in the shape the sync modules read. */
function syncView(
  nodes: readonly Node[],
  edges: readonly Edge[],
): {
  nodes: readonly UnitNode[];
  edges: readonly ({ id: string } & Record<string, unknown>)[];
} {
  return {
    nodes: nodes as unknown as UnitNode[],
    edges: edges as unknown as ({ id: string } & Record<string, unknown>)[],
  };
}

/** Content fields are saved by the per-node content PUT, not the queue. */
function isContentUnit(unit: string): boolean {
  return unit.startsWith('data.') && NODE_CONTENT_KEYS.has(unit.slice(5));
}

/**
 * `data` keys that are shown, never sent: hints the server derives when it
 * reads a node (a missing or duplicated sidecar file), and the renderer
 * box the server records from `APPLY_MEASURED_SIZE`.
 */
const READ_MODEL_DATA_KEYS: ReadonlySet<string> = new Set([
  'contentMissing',
  'contentDuplicate',
  'duplicateFiles',
  'measuredSize',
]);

/** Units the send queue neither sends nor holds. */
function isUnsentUnit(unit: string): boolean {
  return (
    isContentUnit(unit) ||
    (unit.startsWith('data.') && READ_MODEL_DATA_KEYS.has(unit.slice(5)))
  );
}

type SyncState = { nodes: readonly Node[]; edges: readonly Edge[] };

/**
 * Commands that turn `before` into `after`, or `null` when no command list
 * does. The proposal read from the difference is run through the engine and
 * accepted only if it reproduces `after` exactly — the server runs the same
 * engine, so what it writes is then what this page shows.
 */
function commandsReproducing(
  canvasId: string,
  before: SyncState,
  after: SyncState,
): CanvasCommand[] | null {
  const { commands, uncovered } = commandsForStateDiff(
    syncView(before.nodes, before.edges) as Parameters<
      typeof commandsForStateDiff
    >[0],
    syncView(after.nodes, after.edges) as Parameters<
      typeof commandsForStateDiff
    >[1],
    isUnsentUnit,
  );
  if (uncovered.length > 0) return null;
  if (commands.length === 0) {
    // Nothing to send only if nothing sendable differs.
    return deriveHeldKeys(
      syncView(before.nodes, before.edges),
      syncView(after.nodes, after.edges),
      isUnsentUnit,
    ).size === 0
      ? []
      : null;
  }
  const run = executeCanvasCommands(
    { source: 'ui', commands },
    {
      nodes: before.nodes as Node[],
      edges: before.edges as Edge[],
      canvasId,
    },
  );
  const routed = applySharedPostEffectsFromWriteResult(run.writeResult);
  const difference = deriveHeldKeys(
    syncView(run.writeResult.nodes, routed.edges),
    syncView(after.nodes, after.edges),
    isUnsentUnit,
  );
  return difference.size === 0 ? commands : null;
}

/** The commands that save an undo or redo; see `sync/restorePlan.ts`. */
function planHistoryRestore(
  canvasId: string,
  before: SyncState,
  target: SyncState,
): RestorePlan {
  return planRestore({
    before: syncView(before.nodes, before.edges) as PlanState,
    target: syncView(target.nodes, target.edges) as PlanState,
    ignoreUnit: isUnsentUnit,
    contentKeys: NODE_CONTENT_KEYS,
    run: (commands) => {
      const out = executeCanvasCommands(
        { source: 'ui', commands },
        {
          nodes: before.nodes as Node[],
          edges: before.edges as Edge[],
          canvasId,
        },
      );
      const routed = applySharedPostEffectsFromWriteResult(out.writeResult);
      return syncView(out.writeResult.nodes, routed.edges) as PlanState;
    },
  });
}

/**
 * The state an undo shows when its commands do not reproduce the snapshot:
 * what the commands give, with the snapshot's content fields (saved by
 * their own writer) and the returning Agent Nodes (restored by theirs).
 */
function adoptPlanResult(
  target: { nodes: Node[]; edges: Edge[] },
  plan: RestorePlan,
): { nodes: Node[]; edges: Edge[] } {
  const computed = new Map(
    plan.result.nodes.map((node) => [node.id, node as unknown as Node]),
  );
  const returning = new Set(plan.restoredQuestionIds);
  const nodes = target.nodes.flatMap((wanted) => {
    if (returning.has(wanted.id)) return [wanted];
    const node = computed.get(wanted.id);
    if (!node) return [];
    const unsent = changedUnits(
      node as unknown as UnitNode,
      wanted as unknown as UnitNode,
    ).filter(isUnsentUnit);
    return [
      unsent.length > 0
        ? (applyUnits(
            node as unknown as UnitNode,
            wanted as unknown as UnitNode,
            unsent,
          ) as unknown as Node)
        : node,
    ];
  });
  const edges = [
    ...(plan.result.edges as unknown as Edge[]),
    ...target.edges.filter(
      (edge) => returning.has(edge.source) || returning.has(edge.target),
    ),
  ];
  return {
    nodes: normalizeTreeOrder(nodes as NestableNode[]) as Node[],
    edges,
  };
}

/**
 * The measurement key another page (or this page's own confirmed report)
 * last gave the server for a node. A page does not report a height for a
 * key that is already reported, so two pages that render the same note a
 * pixel apart do not keep rewriting each other's size.
 */
const reportedHeightKeys = new Map<string, string>();

/**
 * Report measured heights to the server. A node qualifies when its stored
 * measurement is current, was not already reported under the same key, and
 * its content is on the server (a measurement of a body the server has not
 * received is refused there, so it waits for the content save).
 */
function reportMeasuredHeights(
  nodeIds: Iterable<string>,
  held?: { prev: SyncState; next: SyncState },
  /** A node whose content save was just acknowledged. */
  savedNodeId?: string,
): void {
  const state = useCanvasStore.getState();
  if (!state.canvasId) return;
  const wanted = new Set(nodeIds);
  if (wanted.size === 0) return;
  const unsaved = new Set(nodeContentQueue.pendingNodeIds());
  const items: CanvasNodeMeasuredHeightUpdate[] = [];
  for (const node of state.nodes) {
    if (!wanted.has(node.id)) continue;
    if (resolveHeightMode(node) !== 'auto') continue;
    const { hint, freshness } = readAutoHeightHint(node);
    // A provisional measurement is reported too: it is the best footprint
    // there is until the final one replaces it.
    if (!hint || (freshness !== 'current' && !hint.provisional)) continue;
    if (hint.measuredFor !== autoHeightKey(node)) continue;
    if (
      !hint.provisional &&
      reportedHeightKeys.get(node.id) === hint.measuredFor
    )
      continue;
    if (unsaved.has(node.id) && node.id !== savedNodeId) {
      heightsAwaitingContent.add(node.id);
      continue;
    }
    items.push({
      nodeId: node.id as CanvasNodeId,
      intrinsicHeight: hint.intrinsicHeight,
      measuredFor: hint.measuredFor,
      ...(hint.provisional ? { provisional: true } : {}),
    });
    if (!hint.provisional) reportedHeightKeys.set(node.id, hint.measuredFor);
  }
  if (items.length === 0) return;
  browserSync.submit({
    canvasId: state.canvasId,
    commands: [{ type: 'APPLY_MEASURED_HEIGHT', items }],
    prev: syncView(
      held?.prev.nodes ?? state.nodes,
      held?.prev.edges ?? state.edges,
    ),
    next: syncView(
      held?.next.nodes ?? state.nodes,
      held?.next.edges ?? state.edges,
    ),
    // The server may refuse a measurement (its copy of the body differs);
    // the page still shows what it measured.
    derived: true,
    onSettled: (outcome) => {
      if (outcome.kind === 'response') return;
      // Never delivered: the next measurement reports it again.
      for (const item of items) {
        if (reportedHeightKeys.get(item.nodeId) === item.measuredFor)
          reportedHeightKeys.delete(item.nodeId);
      }
    },
  });
}

/** Nodes whose measured height waits for their content save to be reported. */
const heightsAwaitingContent = new Set<string>();

// ─── Renderer-measured boxes ──────────────────────────────────────────────
//
// `text`, `question` and `spacePreview` nodes have no authored height: only
// a renderer knows their box. The server lays Frames out around the box a
// page reported (`APPLY_MEASURED_SIZE`, stored as `data.measuredSize`).

interface MeasuredBox {
  key: string;
  width: number;
  height: number;
}

/** Boxes this page has reported and not yet seen on the server, by node. */
const reportedSizes = new Map<string, MeasuredBox>();
/** The box this page's renderer last measured for each node. */
const localSizes = new Map<string, MeasuredBox>();
/** Nodes whose measured box waits for their content save to be reported. */
const sizesAwaitingContent = new Set<string>();

/** Two renderers a pixel apart agree. */
function sameBox(a: MeasuredBox | undefined, b: MeasuredBox): boolean {
  return (
    a !== undefined &&
    a.key === b.key &&
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1
  );
}

/**
 * Report renderer-measured boxes to the server. A node qualifies when the
 * server does not already hold a box for the same content and width:
 *
 * - none stored, or one measured against other content: report;
 * - the same box (within a pixel), stored or already on its way: nothing;
 * - a different box under the same key: report only when this page had
 *   measured that content before, i.e. its own rendering changed (a font
 *   size, say). A page that merely renders another page's report a few
 *   pixels differently keeps its own layout and says nothing, so two pages
 *   never rewrite each other's measurement back and forth.
 *
 * A box measured against a body the server has not received would be
 * refused there, so it waits for the content save.
 */
function reportMeasuredSizes(
  nodeIds: Iterable<string>,
  held?: { prev: SyncState; next: SyncState },
  /** A node whose content save was just acknowledged. */
  savedNodeId?: string,
): void {
  const state = useCanvasStore.getState();
  if (!state.canvasId || state.isLoading || !selectCanWriteCanvas(state))
    return;
  const wanted = new Set(nodeIds);
  if (wanted.size === 0) return;
  const unsaved = new Set(nodeContentQueue.pendingNodeIds());
  const items: CanvasNodeMeasuredSizeUpdate[] = [];
  for (const node of state.nodes) {
    if (!wanted.has(node.id)) continue;
    if (getHeightPolicy(node.type).kind !== 'content') continue;
    const { width, height } = node.measured ?? {};
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !(width > 0) ||
      !(height > 0)
    )
      continue;
    const box: MeasuredBox = { key: measuredSizeKey(node), width, height };
    const before = localSizes.get(node.id);
    localSizes.set(node.id, box);
    if (sameBox(reportedSizes.get(node.id), box)) continue;
    const stored = readMeasuredSizeHint(node);
    if (stored?.measuredFor === box.key) {
      if (sameBox({ ...stored, key: stored.measuredFor }, box)) continue;
      if (before?.key !== box.key || sameBox(before, box)) continue;
    }
    if (unsaved.has(node.id) && node.id !== savedNodeId) {
      sizesAwaitingContent.add(node.id);
      continue;
    }
    items.push({
      nodeId: node.id as CanvasNodeId,
      width,
      height,
      measuredFor: box.key,
    });
    reportedSizes.set(node.id, box);
  }
  if (items.length === 0) return;
  browserSync.submit({
    canvasId: state.canvasId,
    commands: [{ type: 'APPLY_MEASURED_SIZE', items }],
    prev: syncView(
      held?.prev.nodes ?? state.nodes,
      held?.prev.edges ?? state.edges,
    ),
    next: syncView(
      held?.next.nodes ?? state.nodes,
      held?.next.edges ?? state.edges,
    ),
    // The server may ignore a box (its copy of the body differs); the page
    // still shows what it measured.
    derived: true,
    onSettled: (outcome) => {
      if (outcome.kind === 'response') return;
      // Never delivered: the next measurement reports it again.
      for (const item of items) {
        if (reportedSizes.get(item.nodeId)?.key === item.measuredFor)
          reportedSizes.delete(item.nodeId);
      }
    },
  });
}

/** How long the renderer gets to reflow before a changed node is checked. */
const MEASURED_SIZE_SETTLE_MS = 120;

/**
 * After a batch changed what a renderer-sized node's box is measured
 * against (its content, its authored width), look at the box again once the
 * renderer has reflowed. A resize that ends on the size its last live tick
 * left produces no further measurement event, yet the stored box describes
 * the old width.
 */
function scheduleMeasuredSizeCheck(
  before: readonly Node[],
  after: readonly Node[],
): void {
  if (before === after) return;
  const previous = new Map(before.map((node) => [node.id, node]));
  const nodeIds = after.flatMap((node) => {
    const start = previous.get(node.id);
    return start &&
      start !== node &&
      getHeightPolicy(node.type).kind === 'content' &&
      measuredSizeKey(start) !== measuredSizeKey(node)
      ? [node.id]
      : [];
  });
  if (nodeIds.length === 0) return;
  const { canvasId } = useCanvasStore.getState();
  setTimeout(() => {
    if (useCanvasStore.getState().canvasId === canvasId)
      reportMeasuredSizes(nodeIds);
  }, MEASURED_SIZE_SETTLE_MS);
}

/**
 * Nodes an undo is bringing back whose restoring batch is not answered yet.
 * Until it is, the server has no such node to preprocess.
 */
const restoringNodeIds = new Set<string>();

// ─── Legacy Frame-header migration ────────────────────────────────────────

/** Spaces whose header migration was sent during the load in progress. */
const headerMigrationTried = new Set<string>();

/**
 * Send the load-time Frame header migration as geometry commands. Returns
 * whether the server took them; the caller then loads the Space again.
 */
async function persistFrameHeaderMigration(
  canvasId: string,
  before: readonly Node[],
  after: readonly Node[],
): Promise<boolean> {
  const { commands } = commandsForLocalDiff(
    before as unknown as UnitNode[],
    after as unknown as UnitNode[],
    isUnsentUnit,
  );
  if (commands.length === 0) return false;
  try {
    const response = await postCanvasExecute(canvasId, {
      commands,
      originator: { source: 'ui', tabId: SYNC_CLIENT_ID },
    });
    return response.results.every(
      (result) => result.applied || result.reason === 'no-op',
    );
  } catch (error) {
    console.warn('Frame header update deferred:', error);
    return false;
  }
}

/**
 * The lineage of the read versions the server issued for the loaded Space
 * (`basis` of the load). A page's read version is this lineage with the
 * version it has applied.
 */
let syncLineage: { canvasId: string; lineage: string } | null = null;

let syncRejectedToastId: string | null = null;
let afterCanvasResync: (() => void) | null = null;

const browserSync = createBrowserSync({
  send: (canvasId, request, options) =>
    postCanvasExecute(canvasId, request, options),
  clientId: SYNC_CLIENT_ID,
  getState: () => {
    const { canvasId, version } = useCanvasStore.getState();
    return {
      canvasId,
      version,
      lineage: syncLineage?.canvasId === canvasId ? syncLineage.lineage : null,
    };
  },
  gestureHeld: () => {
    if (!syncGestureBaseline) return null;
    const { nodes, edges } = useCanvasStore.getState();
    const keys = deriveHeldKeys(
      syncView(syncGestureBaseline, edges),
      syncView(nodes, edges),
      isUnsentUnit,
    );
    return keys.size > 0 ? (key) => keys.has(key) : null;
  },
  applyOwnResponse: (response, operationId) => {
    useCanvasStore.getState().applyDeltasFromAgent(
      response.deltas as Delta[],
      response.toVersion,
      response.pendingEffects as Parameters<RFState['applyDeltasFromAgent']>[2],
      false,
      {
        events: response.orderEvents,
        onDiverged: () => browserSync.deferReload(response.canvasId),
      },
      { operationId, source: 'ui' },
    );
  },
  applyWithheld: (canvasId, units) => {
    const state = useCanvasStore.getState();
    if (state.canvasId !== canvasId) return;
    const byNode = new Map<string, typeof units>();
    for (const unit of units) {
      byNode.set(unit.nodeId, [...(byNode.get(unit.nodeId) ?? []), unit]);
    }
    let touched = false;
    const nodes = state.nodes.map((node) => {
      const pending = byNode.get(node.id);
      if (!pending) return node;
      let next = node as unknown as UnitNode;
      for (const unit of pending) next = writeUnit(next, unit.unit, unit.value);
      if (changedUnits(node as unknown as UnitNode, next).length === 0)
        return node;
      touched = true;
      return next as unknown as Node;
    });
    if (!touched) return;
    // A parent put back to the server's needs the parent-before-child order
    // React Flow requires; sibling order follows with the reload a refusal
    // asks for.
    state._setStateNoAutosave({
      nodes: units.some((unit) => unit.unit === PARENT_UNIT)
        ? (normalizeTreeOrder(nodes as NestableNode[]) as Node[])
        : nodes,
    });
  },
  onRejected: ({ canvasId, outcome }) => {
    if (useCanvasStore.getState().canvasId !== canvasId) return;
    // One notice however many commands were refused.
    if (syncRejectedToastId) dismissToast(syncRejectedToastId);
    // A failed precondition (a conversation fork) reports its own reason.
    syncRejectedToastId =
      outcome.kind === 'failed' && !outcome.sent
        ? toast(
            outcome.error instanceof Error
              ? outcome.error.message
              : t('canvasSync.changeRejected'),
            { tone: 'danger' },
          )
        : toast(t('canvasSync.changeRejected'), { tone: 'warning' });
  },
  reload: (canvasId) => {
    const state = useCanvasStore.getState();
    if (state.canvasId !== canvasId) return;
    // A reload would drop a body the user is still typing. It is not given
    // up: it runs as soon as that text has been saved.
    if (nodeContentQueue.pendingNodeIds().length > 0) {
      holdReloadForContent(canvasId);
      return;
    }
    releaseReloadHeldForContent();
    const done = afterCanvasResync;
    void state
      .loadCanvas(canvasId, { resetHistory: true })
      .then(() => done?.());
  },
  ignoreUnit: isContentUnit,
});

// ─── A reload that waits for unsaved note text ────────────────────────────
//
// Every reload the sync layer asks for (a version gap, a snapshot that does
// not match, a paint order that could not be installed, an update that never
// arrived, a rejected command) ends in `reload` above, which will not replace
// a body the server does not have. Such a reload is held here instead of
// being dropped: it runs by itself when the content queue has nothing unsaved
// left — normally a moment later, when the debounced save is acknowledged.
// When the text cannot be saved (a failing save, a conflict the user has not
// answered) the page says what the reload is waiting for.

/** How long a held reload waits quietly before the page says why. */
const RELOAD_HELD_NOTICE_MS = 5_000;
/** How often a held reload looks whether the text has been dealt with. */
const RELOAD_HELD_POLL_MS = 1_000;

let reloadHeldForContent: {
  canvasId: string;
  poll: ReturnType<typeof setInterval>;
  noticeTimer: ReturnType<typeof setTimeout> | null;
  toastId: string | null;
} | null = null;

function releaseReloadHeldForContent(): void {
  const held = reloadHeldForContent;
  if (!held) return;
  reloadHeldForContent = null;
  clearInterval(held.poll);
  if (held.noticeTimer) clearTimeout(held.noticeTimer);
  if (held.toastId) dismissToast(held.toastId);
}

/** Run the held reload if nothing stands in its way any more. */
function resumeReloadHeldForContent(): void {
  const held = reloadHeldForContent;
  if (!held) return;
  if (useCanvasStore.getState().canvasId !== held.canvasId) {
    // The user left the Space; the next visit loads it anyway.
    releaseReloadHeldForContent();
    return;
  }
  if (nodeContentQueue.pendingNodeIds().length > 0) return;
  releaseReloadHeldForContent();
  // Through the queue's own gate again: not over unsent structure edits.
  browserSync.deferReload(held.canvasId);
}

function holdReloadForContent(canvasId: string): void {
  if (reloadHeldForContent?.canvasId === canvasId) return;
  releaseReloadHeldForContent();
  const held: NonNullable<typeof reloadHeldForContent> = {
    canvasId,
    // A save's acknowledgement resumes at once; this also catches text that
    // stops being unsaved another way (a conflict answered with the server's
    // version, the node deleted).
    poll: setInterval(resumeReloadHeldForContent, RELOAD_HELD_POLL_MS),
    noticeTimer: setTimeout(() => {
      held.noticeTimer = null;
      if (reloadHeldForContent !== held) return;
      const names = unsavedNoteNames(canvasId);
      if (names === null) return;
      held.toastId = toast(t('canvasSync.reloadWaiting', { notes: names }), {
        tone: 'warning',
        duration: 0,
      });
    }, RELOAD_HELD_NOTICE_MS),
    toastId: null,
  };
  reloadHeldForContent = held;
}

/**
 * The notes of `canvasId` whose text is not saved, as one phrase for a
 * notice: up to three titles, then how many more. `null` when there is none.
 */
function unsavedNoteNames(canvasId: string): string | null {
  const state = useCanvasStore.getState();
  if (state.canvasId !== canvasId) return null;
  const unsaved = new Set(nodeContentQueue.unsavedNodeIds(canvasId));
  if (unsaved.size === 0) return null;
  const titles = state.nodes
    .filter((node) => unsaved.has(node.id))
    .map((node) => {
      const label = (node.data as { label?: unknown } | undefined)?.label;
      return typeof label === 'string' && label.trim()
        ? t('canvasSync.noteName', { name: label.trim() })
        : t('canvasSync.untitledNote');
    });
  // Text of a node that is no longer shown (deleted here, save still failing).
  for (let i = titles.length; i < unsaved.size; i++)
    titles.push(t('canvasSync.untitledNote'));
  const shown = titles.slice(0, 3).join(t('canvasSync.noteSeparator'));
  return titles.length > 3
    ? t('canvasSync.notesAndMore', { notes: shown, count: titles.length - 3 })
    : shown;
}

// ─── Unsynced and error notices ───────────────────────────────────────────
//
// While a request keeps failing the page says so and keeps retrying. Once
// the retry limit is reached nothing more is sent until the user chooses:
// keep trying, or reload the Space and give up what was not sent. The page
// never reloads over unsent changes on its own.

let syncNotice: { state: 'unsynced' | 'error'; toastId: string } | null = null;

function dismissSyncNotice(): void {
  if (!syncNotice) return;
  dismissToast(syncNotice.toastId);
  syncNotice = null;
}

function showSyncNotice(canvasId: string, state: CanvasSyncState): void {
  if (state !== 'unsynced' && state !== 'error') {
    dismissSyncNotice();
    return;
  }
  if (syncNotice?.state === state) return;
  dismissSyncNotice();
  syncNotice = {
    state,
    toastId:
      state === 'unsynced'
        ? toast(t('canvasSync.unsynced'), {
            tone: 'warning',
            duration: 0,
            dismissible: false,
          })
        : toast(t('canvasSync.sendFailed'), {
            tone: 'danger',
            duration: 0,
            dismissible: false,
            action: {
              label: t('canvasSync.keepTrying'),
              onClick: () => {
                syncNotice = null;
                browserSync.queue.resume(canvasId);
              },
            },
            secondaryAction: {
              label: t('canvasSync.reloadAndDiscard'),
              onClick: () => {
                syncNotice = null;
                void discardUnsentCanvasEdits(canvasId);
              },
            },
          }),
  };
}

/** The longest "reload and discard" waits for note text to be saved first. */
const DISCARD_CONTENT_SAVE_WAIT_MS = 5_000;
let discardingUnsentEdits = false;

/**
 * The user's choice in the error state: give up what could not be sent and
 * show the server's Space again.
 *
 * Structure edits are what could not be sent; note text has its own request
 * and may well get through. So the text is saved first, and then the Space
 * is reloaded. Text that cannot be saved either is never dropped on the
 * quiet: the notes are named and the user decides — discard that text too,
 * or cancel (to copy it out, or to keep trying), which leaves the page
 * exactly as it was. Every path ends in something the user sees.
 */
export async function discardUnsentCanvasEdits(
  canvasId: string,
): Promise<void> {
  if (discardingUnsentEdits) return;
  const isCurrent = () => useCanvasStore.getState().canvasId === canvasId;
  if (!isCurrent()) return;
  discardingUnsentEdits = true;
  try {
    if (nodeContentQueue.unsavedNodeIds(canvasId).length > 0) {
      const savingToast = toast(t('canvasSync.savingTextBeforeReload'), {
        tone: 'info',
        duration: 0,
        dismissible: false,
      });
      try {
        nodeContentQueue.retryFailedSaves(canvasId);
        // Bounded: the text of a node whose creation is among the unsent
        // edits waits for that creation, which is not coming.
        await Promise.race([
          nodeContentQueue.flushAll(),
          new Promise((resolve) =>
            setTimeout(resolve, DISCARD_CONTENT_SAVE_WAIT_MS),
          ),
        ]);
      } finally {
        dismissToast(savingToast);
      }
      if (!isCurrent()) return;
    }
    const names = unsavedNoteNames(canvasId);
    if (names === null) {
      await reloadDiscardingUnsent(canvasId, false);
      return;
    }
    toast(t('canvasSync.unsavedTextConfirm', { notes: names }), {
      tone: 'danger',
      duration: 0,
      dismissible: false,
      action: {
        label: t('canvasSync.cancelDiscard'),
        // Nothing was given up: the page is in the state the choice was
        // made from, so offer that choice again.
        onClick: () =>
          showSyncNotice(canvasId, useCanvasSyncStatusStore.getState().state),
      },
      secondaryAction: {
        label: t('canvasSync.discardTextAndReload'),
        onClick: () => void reloadDiscardingUnsent(canvasId, true),
      },
    });
  } finally {
    discardingUnsentEdits = false;
  }
}

/**
 * Drop the unsent structure edits — and, when the user has confirmed it,
 * the note text that could not be saved — then load the server's Space.
 */
async function reloadDiscardingUnsent(
  canvasId: string,
  discardContent: boolean,
): Promise<void> {
  const state = useCanvasStore.getState();
  if (state.canvasId !== canvasId) return;
  if (!discardContent && nodeContentQueue.unsavedNodeIds(canvasId).length > 0) {
    // Typed between the check and here: ask rather than lose it.
    void discardUnsentCanvasEdits(canvasId);
    return;
  }
  releaseReloadHeldForContent();
  browserSync.discard(canvasId);
  if (discardContent) {
    preprocessQueue.cancelAll();
    const resumeContentSaves = nodeContentQueue.suspendCanvas(canvasId);
    try {
      // Requests already issued cannot be taken back; let them settle so
      // none of them answers into the reloaded Space.
      await Promise.race([
        waitForSidecarWrites(),
        new Promise((resolve) =>
          setTimeout(resolve, DISCARD_CONTENT_SAVE_WAIT_MS),
        ),
      ]);
      if (useCanvasStore.getState().canvasId !== canvasId) return;
      nodeContentQueue.discardCanvas(canvasId);
    } finally {
      resumeContentSaves();
    }
  }
  const done = afterCanvasResync;
  await useCanvasStore.getState().loadCanvas(canvasId, { resetHistory: true });
  done?.();
  if (useCanvasStore.getState().canvasId === canvasId)
    toast(t('canvasSync.reloadedDiscarded'), { tone: 'info' });
}

browserSync.queue.subscribe((status) => {
  // The action log follows the edits it describes. Fire-and-forget: a
  // failed flush is retried on the next trigger.
  if (status.phase === 'idle') void canvasEvents.flush(status.canvasId);
  if (useCanvasStore.getState().canvasId !== status.canvasId) return;
  const state = syncStateOf(status);
  useCanvasSyncStatusStore.setState({
    canvasId: status.canvasId,
    state,
    pending: status.pending,
  });
  showSyncNotice(status.canvasId, state);
});

/** A drag or resize is in progress under the pointer. */
function pointerGestureActive(): boolean {
  return isSnapSessionActive() || getResizeContext() !== null;
}

/** Apply what a server update changed to the open gesture's starting point. */
function rebaseGestureBaseline(deltas: readonly Delta[]): void {
  if (!syncGestureBaseline) return;
  const changes = new Map(
    deltas.flatMap((delta) =>
      delta.type === 'REPLACE_NODE' ? [[delta.next.id, delta] as const] : [],
    ),
  );
  if (changes.size === 0) return;
  syncGestureBaseline = syncGestureBaseline.map((node) => {
    const change = changes.get(node.id);
    if (!change) return node;
    return applyUnits(
      node as unknown as UnitNode,
      change.next as unknown as UnitNode,
      changedUnits(
        change.prev as unknown as UnitNode,
        change.next as unknown as UnitNode,
      ),
    ) as unknown as Node;
  });
}

/**
 * Send what the open pointer gesture changed without a command — the
 * positions its live ticks left in the store — and close the gesture.
 *
 * @param edgesBefore Edges before the drop re-routed them.
 */
function submitGestureTicks(edgesBefore: readonly Edge[]): void {
  const baseline = syncGestureBaseline;
  const state = useCanvasStore.getState();
  endSyncGesture();
  if (!baseline || !state.canvasId) return;
  const { commands } = commandsForLocalDiff(
    baseline as unknown as UnitNode[],
    state.nodes as unknown as UnitNode[],
    isContentUnit,
  );
  if (commands.length === 0) return;
  canvasHistoryManager.noteChange(
    deriveHeldKeys(
      syncView(baseline, edgesBefore),
      syncView(state.nodes, state.edges),
    ).keys(),
  );
  browserSync.submit({
    canvasId: state.canvasId,
    commands,
    prev: syncView(baseline, edgesBefore),
    next: syncView(state.nodes, state.edges),
  });
}

/**
 * Give the open Space the read-version lineage a load would have brought,
 * for suites that put a Space into the store without loading it.
 */
export function setCanvasSyncLineageForTests(
  canvasId: string,
  lineage: string | null,
): void {
  syncLineage = lineage === null ? null : { canvasId, lineage };
}

/**
 * Forget every queued batch and unconfirmed hold. The queue is module state
 * that outlives a test; suites that edit structure call this between cases.
 */
export function resetCanvasSyncForTests(): void {
  browserSync.reset();
  syncLineage = null;
  syncGestureBaseline = null;
  gestureWithheldParents.clear();
  heightsAwaitingContent.clear();
  reportedHeightKeys.clear();
  sizesAwaitingContent.clear();
  reportedSizes.clear();
  localSizes.clear();
  restoringNodeIds.clear();
  failedRestores.clear();
  dismissSyncNotice();
  releaseReloadHeldForContent();
  discardingUnsentEdits = false;
  useCanvasSyncStatusStore.setState({ state: 'synced', pending: 0 });
}

/**
 * Converge this page to the server's whole Space: after a version gap, a
 * reconnect snapshot that does not match, or a diverged paint order. Runs at
 * once when nothing is waiting to be sent, otherwise as soon as the send
 * queue has drained — never while it still holds unsent changes.
 */
export function requestCanvasResync(
  canvasId: string,
  afterReload?: () => void,
): void {
  afterCanvasResync = afterReload ?? null;
  browserSync.deferReload(canvasId);
}

/** Drain issued sidecar writers without promoting held/debounced writes. */
async function waitForSidecarWrites(): Promise<void> {
  await Promise.all([
    nodeContentQueue.waitForIdle(),
    preprocessQueue.waitForIdle(),
  ]);
}

/** Agent Node creations and re-associations of `canvasId` still in flight. */
function pendingQuestionCreations(canvasId: string): Promise<void>[] {
  const prefix = `${canvasId}\0`;
  return [...questionCreations]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, creation]) => creation.promise);
}

/**
 * Whether a drain has the send queue to wait for: an edit of the user's, or
 * a derived report (a measured height or box) that is not failing. A report
 * that cannot be sent is not worth holding the user for.
 */
function drainWaitsForQueue(canvasId: string): boolean {
  const status = browserSync.queue.status(canvasId);
  return (
    status.pending > status.derivedPending ||
    (status.pending > 0 && status.failures === 0)
  );
}

/**
 * Resolves once every queued structure edit has been answered, or as soon as
 * a request fails. A drain is a moment the user is waiting on (leaving the
 * Space, submitting a prompt): a request that was failing is tried again at
 * once, and one more failure is reported instead of sitting out the retry
 * schedule. That attempt counts towards the retry limit like any other, so
 * repeated drains end in the stalled state rather than retrying for ever.
 * A queue that has stalled reports at once.
 */
function whenSentOrFailing(canvasId: string): Promise<'idle' | 'failing'> {
  const { queue } = browserSync;
  if (!drainWaitsForQueue(canvasId)) return Promise.resolve('idle');
  const before = queue.status(canvasId);
  // Stalled is the user's decision to make (keep trying, or discard).
  if (before.phase === 'stalled') return Promise.resolve('failing');
  if (before.failures > 0) queue.retryNow(canvasId);
  let seen = before.failures;
  return new Promise((resolve) => {
    const unsubscribe = queue.subscribe((status) => {
      if (status.canvasId !== canvasId) return;
      const outcome =
        status.pending === 0
          ? 'idle'
          : status.phase === 'stalled' || status.failures > seen
            ? // Only derived reports are failing: nothing to stay for.
              status.pending > status.derivedPending
              ? 'failing'
              : 'idle'
            : null;
      seen = Math.min(seen, status.failures);
      if (!outcome) return;
      unsubscribe();
      resolve(outcome);
    });
  });
}

/**
 * Send every queued structure edit AND every pending debounced per-node
 * content save now, then resolve once both have settled.
 *
 * Called from the router-root `SpaceNavigationGuard` so navigating away
 * from a canvas (back to list, into settings, into docs, into another
 * canvas) holds the navigation until every queued request has been sent
 * and answered. Without this, trailing edits would fire later under a stale
 * captured `canvasId` — by which time the user has moved on and there's
 * nothing left in the store to revert if the write fails. A request that
 * fails, or an unresolved content failure, rejects: navigation must retain
 * local edits until saved or explicitly discarded.
 *
 * Order: structure first (the send queue, then Agent Node associations),
 * then per-node content. Resurrection makes this ordering a dependency: the
 * node must be on the Space again before its held sidecar is written.
 * Keep the captured scope if navigation finishes during an await; outgoing
 * saves were drained by navigation, and the new Space belongs to another turn.
 */
export async function drainPendingSaves(
  canvasId = useCanvasStore.getState().canvasId,
): Promise<void> {
  const isActive = () => useCanvasStore.getState().canvasId === canvasId;
  const initial = useCanvasStore.getState();
  if (isActive() && !initial.isLoading)
    nodeContentQueue.retryFailedSaves(canvasId);
  do {
    if ((await whenSentOrFailing(canvasId)) === 'failing') {
      throw new Error(
        'Changes to this Space could not be sent. Retry before leaving it.',
      );
    }
    // A re-association failure is reported, and rolled back, by its owner.
    await Promise.allSettled(pendingQuestionCreations(canvasId));
    if (isActive()) await nodeContentQueue.flushAll();
    await canvasHistoryManager.waitForDeletes(canvasId);
    if (isActive() && nodeContentQueue.hasPendingRestoredContent()) {
      throw new Error(
        'Restored node content is waiting for its node to be restored. Retry before leaving this Canvas.',
      );
    }
    await nodeContentQueue.flushAllForSubmission(canvasId);
  } while (isActive() && drainWaitsForQueue(canvasId));
}

/** Explicit navigation-only discard; already-issued writes cannot be undone. */
export async function discardPendingSaves(canvasId: string): Promise<void> {
  const state = useCanvasStore.getState();
  if (state.canvasId !== canvasId)
    throw new Error('Cannot discard edits from a different Space');
  state._setStateNoAutosave({ isLoading: true });
  preprocessQueue.cancelAll();
  browserSync.discard(canvasId);
  const resumeContentSaves = nodeContentQueue.suspendCanvas(canvasId);
  try {
    // Keep failure records until every admitted writer has settled.
    await waitForSidecarWrites();
    await canvasHistoryManager.waitForDeletes(canvasId);
    if (useCanvasStore.getState().canvasId !== canvasId)
      throw new Error('Space changed while discarding edits');
    preprocessQueue.cancelAll();
    nodeContentQueue.discardCanvas(canvasId);
    canvasHistoryManager.clearCanvas(canvasId);
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: '',
      canvasTitle: '',
      nodes: [],
      edges: [],
      version: 0,
      contentPosition: null,
      viewport: null,
      isLoading: false,
      canUndo: false,
      canRedo: false,
      ingestionByNodeId: {},
      pendingForkThreadIds: {},
    });
  } catch (error) {
    if (useCanvasStore.getState().canvasId === canvasId)
      useCanvasStore.getState()._setStateNoAutosave({ isLoading: false });
    throw error;
  } finally {
    resumeContentSaves();
  }
}

/**
 * Drain every save queue for the current Canvas before the session ends,
 * and report whether everything reached the Server. Signing out removes the
 * credential the unload flush would need, so whatever is still queued or
 * failed then would be lost.
 */
export async function savedBeforeSignOut(): Promise<boolean> {
  try {
    // The desktop close path: stop recordings, await imports and uploads,
    // then save structure and every node's content strictly, failing on any
    // retained structure or content failure.
    await pageLifecycle.prepare(new AbortController().signal);
    const { canvasId } = useCanvasStore.getState();
    if (canvasId) await canvasEvents.flush(canvasId);
    else await drainPendingSaves();
    await preprocessQueue.flushAll();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the open Canvas holds an edit the Server has not acknowledged:
 * queued, in flight or failed. Leaving the page now would lose it. A
 * derived report (a measured height or box) is not an edit.
 */
export function hasUnsavedCanvasEdits(): boolean {
  const { canvasId } = useCanvasStore.getState();
  if (!canvasId) return false;
  return (
    hasUnsavedStructureOrContent() || browserSync.queue.hasUserPending(canvasId)
  );
}

/** Unsaved work of the per-node content PUT. */
function hasUnsavedStructureOrContent(): boolean {
  const { canvasId } = useCanvasStore.getState();
  if (!canvasId) return false;
  return nodeContentQueue.hasUnsavedContent(canvasId);
}

/**
 * Resend what a lapsed session refused, once it has been renewed. Best
 * effort: a save that fails again is reported as any other save failure.
 */
export async function resendUnsavedCanvasEdits(): Promise<void> {
  const { canvasId } = useCanvasStore.getState();
  if (!canvasId) return;
  // A lapsed session may have used up the retry limit.
  browserSync.queue.resume(canvasId);
  await drainPendingSaves(canvasId);
}

export class CanvasSubmissionSaveError extends Error {
  readonly code = 'canvas_save_failed';

  constructor(
    readonly canvasId: string,
    cause: unknown,
  ) {
    super(`Cannot submit before Canvas ${canvasId} is saved`, { cause });
    this.name = 'CanvasSubmissionSaveError';
  }
}

export async function saveCanvasForSubmission(canvasId: string): Promise<void> {
  try {
    await drainPendingSaves(canvasId);
  } catch (error) {
    throw new CanvasSubmissionSaveError(canvasId, error);
  }
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
 * Another page saved the content (body, label, summary, …) of these nodes:
 * show it here, unless this page has unsaved content of its own for a node.
 * See `NodeContentQueue.adoptRemoteContent`.
 */
export function adoptRemoteNodeContent(
  canvasId: string,
  nodeIds: readonly string[],
): Promise<RemoteContentOutcome[]> {
  return Promise.all(
    nodeIds.map((nodeId) =>
      nodeContentQueue.adoptRemoteContent(canvasId, nodeId),
    ),
  );
}

/** Save `nodeId`'s queued content now; settles once the server has answered. */
export function flushNodeContent(nodeId: string): Promise<void> {
  const { canvasId } = useCanvasStore.getState();
  if (!canvasId || !nodeContentQueue.pendingNodeIds().includes(nodeId))
    return Promise.resolve();
  // A save already on the wire with nothing queued behind it (a property
  // edit, which is sent the moment it is committed) is what there is to
  // wait for; another save would only repeat it.
  const inFlight = nodeContentQueue.whenInFlightSaved(nodeId);
  if (inFlight.onlyInFlight) return inFlight.done;
  return nodeContentQueue
    .flushNow(canvasId, nodeId, { source: 'auto' })
    .catch(() => undefined);
}

/**
 * Trigger preprocessing for a single node once the user has finished
 * editing it (exit-edit "settle").
 *
 * Called for editor-authored nodes (`note` / `text`) from their exit-edit
 * boundaries — Preview Workspace departure for `note` and `TextNode`'s
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

function settleDepartingPreviewEditors(
  previous: CanvasPreviewWorkspace,
  next?: CanvasPreviewWorkspace,
): void {
  const { canvasId, nodes } = useCanvasStore.getState();
  const retained = new Set(
    next?.groups.flatMap((group) => {
      const target = group.activeTabId
        ? next.tabs[group.activeTabId]?.target
        : undefined;
      return target?.kind === 'node' && target.canvasId === canvasId
        ? [target.nodeId]
        : [];
    }),
  );
  for (const group of previous.groups) {
    const target = group.activeTabId
      ? previous.tabs[group.activeTabId]?.target
      : undefined;
    if (
      target?.kind !== 'node' ||
      target.canvasId !== canvasId ||
      retained.has(target.nodeId)
    )
      continue;
    const node = nodes.find((candidate) => candidate.id === target.nodeId);
    if (node?.type === 'note' || node?.type === 'text') {
      settleNodePreprocess(node.id);
    }
  }
}

export function drainNodePreprocessing(): Promise<void> {
  return preprocessQueue.flushAll();
}

pageLifecycle.register('canvas', {
  flush: async () => {
    const { canvasId } = useCanvasStore.getState();
    if (canvasId) {
      await saveCanvasForSubmission(canvasId);
      await drainNodePreprocessing();
      await saveCanvasForSubmission(canvasId);
    }
    flushCanvasViewState();
  },
});

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
      flushPreviewWorkspace: () => usePreviewWorkspaceStore.getState().flush(),
      sendQueue: {
        hasUnsent: () =>
          browserSync.queue.hasPending(useCanvasStore.getState().canvasId),
        flushKeepalive: () => browserSync.queue.flushKeepalive(),
        // The desktop app closes through its own acknowledged save flow; a
        // cancelled `beforeunload` there would block the window silently.
        // Derived reports are flushed, but only an edit asks to stay.
        warnBeforeLeaving: () =>
          !getElectronBridge() &&
          browserSync.queue.hasUserPending(useCanvasStore.getState().canvasId),
      },
    }),
  );
  // Back online: try at once instead of waiting out the backoff, and leave
  // the error state the outage caused.
  window.addEventListener('online', () => {
    const { canvasId } = useCanvasStore.getState();
    if (canvasId && browserSync.queue.hasPending(canvasId))
      browserSync.queue.resume(canvasId);
  });
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

      if (!prev.isLoading) {
        const next = get();
        // --- Per-node content diff ---
        // Editor edits flush on their own debounce through the per-node
        // content PUT and never participate in the canvas-level `version`
        // counter. Structure is not saved from here: every structural
        // writer sends commands through the send queue.
        if (prev.nodes !== next.nodes) {
          const nextIds = new Set(next.nodes.map((node) => node.id));
          for (const node of prev.nodes) {
            if (!nextIds.has(node.id)) {
              nodeContentQueue.forgetNode(node.id);
              preprocessQueue.forgetNode(node.id);
            }
          }
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
// node and therefore has to be sent. This is required because live drag
// ticks commit positions through `_setStateNoAutosave`, and the drag-stop
// resolver only emits a `SET_NODE_GEOMETRY` command when a frame / parent
// change is involved — so a plain free-node move produces no command of
// its own (see `submitGestureTicks`).
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
export interface AgentSourceSelection {
  nodeIds: readonly string[];
  strokeSelection: Readonly<Record<string, readonly string[]>>;
  excludeNodeIds?: readonly string[];
  lasso?: boolean;
}

function makeBuildSelectedDetail(
  allNodes: Node[],
  selection: AgentSourceSelection,
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
      ...(selection.lasso && n.type === 'text' && data?.contentMissing !== true
        ? { content: typeof data?.content === 'string' ? data.content : '' }
        : {}),
      ...(src !== undefined ? { src } : {}),
      ...(n.type === 'sketch' && selection.strokeSelection[n.id]?.length
        ? { strokeIds: [...selection.strokeSelection[n.id]] }
        : {}),
    };

    if (n.type === 'frame') {
      if (selection.lasso) {
        detail.referenceOnly = true;
        const children = allNodes
          .filter(
            (child) =>
              child.parentId === n.id &&
              !child.hidden &&
              !selection.strokeSelection[child.id]?.length &&
              !selection.excludeNodeIds?.includes(child.id),
          )
          .map((child) => ({
            id: child.id,
            type: (child.type ?? 'note') as CanvasNodeType,
            label: child.data.label as string | undefined,
            referenceOnly: true,
          }));
        if (children.length > 0) detail.children = children;
        return detail;
      }
      const children = allNodes
        .filter(
          (child) =>
            child.parentId === n.id &&
            !selection.excludeNodeIds?.includes(child.id),
        )
        .map(build);
      if (children.length > 0) detail.children = children;
    }

    return detail;
  };
  return build;
}

const questionCreations = new Map<
  string,
  { promise: Promise<void>; toVersion?: number }
>();
const questionForks = new Map<string, Promise<unknown>>();

export async function awaitQuestionCreation(
  canvasId: string,
  nodeId: string,
): Promise<void> {
  await questionCreations.get(`${canvasId}\0${nodeId}`)?.promise;
}

function scheduleAcknowledgedNodePreprocessing(node: Node): void {
  const { canvasId } = useCanvasStore.getState();
  const creation = questionCreations.get(`${canvasId}\0${node.id}`)?.promise;
  if (!creation) {
    preprocessQueue.schedule(node);
    return;
  }
  void creation.then(
    () => {
      const current = useCanvasStore.getState();
      if (current.canvasId !== canvasId) return;
      const live = current.nodes.find((candidate) => candidate.id === node.id);
      if (live) preprocessQueue.schedule(live);
    },
    () => {},
  );
}

function rollbackFailedQuestions(canvasId: string, nodes: Node[]): void {
  const failedIds = new Set(nodes.map((node) => node.id));
  canvasHistoryManager.discardNodes(canvasId, failedIds);
  const current = useCanvasStore.getState();
  if (current.canvasId !== canvasId) return;
  for (const id of failedIds) nodeContentQueue.forgetNode(id);
  // The server never took these nodes, so removing them is this page's own
  // business: nothing is sent.
  useCanvasStore.setState({
    nodes: current.nodes.filter((node) => !failedIds.has(node.id)),
    edges: current.edges.filter(
      (edge) => !failedIds.has(edge.source) && !failedIds.has(edge.target),
    ),
  });
  usePreviewWorkspaceStore
    .getState()
    .validate(new Set(useCanvasStore.getState().nodes.map((node) => node.id)));
}

/**
 * Re-establish the identity of Agent Nodes an undo brought back. Their
 * content is held by the content queue until the association is confirmed.
 *
 * @param after The batch that restores everything else of the same undo
 *   (a parent Frame, say); the association is requested once it is answered.
 */
function restoreQuestionAssociations(
  canvasId: string,
  previous: Node[],
  restored: Node[],
  after?: Promise<unknown>,
): void {
  const previousIds = new Set(previous.map((node) => node.id));
  for (const node of restored) {
    if (node.type !== 'question' || previousIds.has(node.id)) continue;
    nodeContentQueue.holdRestoredNodes(canvasId, [node]);
    const token = nodeContentQueue.restoreTokens().get(node.id);
    // Wait only for already-issued writes, not saves that need this association.
    const creation = Promise.allSettled([
      after,
      canvasHistoryManager.waitForDeletion(canvasId, node.id),
    ]).then(async () => {
      const response = await associateAgentNode(canvasId, node.id, {
        kind: 'restore',
        node: {
          ...stripTransientNodeFields(node),
          type: 'question',
          data: projectAgentNodeEditableData(node.data),
        },
        threadId:
          typeof node.data.threadId === 'string'
            ? node.data.threadId
            : undefined,
        requireBinding: node.data.bindingState === 'bound',
      });
      const pending = questionCreations.get(`${canvasId}\0${node.id}`);
      if (pending?.promise === creation) pending.toVersion = response.toVersion;
      const current = useCanvasStore.getState();
      if (current.canvasId !== canvasId) return;
      const confirmed = response.node as Node;
      current._setStateNoAutosave({
        nodes: current.nodes.map((live) =>
          live.id === node.id && current.version <= response.toVersion
            ? {
                ...live,
                data: {
                  ...preserveAgentNodeOwnedData(live.data, confirmed.data),
                  agentBinding:
                    confirmed.data.agentBinding ?? live.data.agentBinding,
                },
              }
            : live,
        ),
        ...(current.version === response.fromVersion
          ? { version: response.toVersion }
          : {}),
      });
      // The node is on the Space again: its held content may be written.
      if (token)
        nodeContentQueue.acknowledgeRestores(
          canvasId,
          new Map([[node.id, token]]),
        );
      const live = useCanvasStore
        .getState()
        .nodes.find((item) => item.id === node.id);
      if (live) preprocessQueue.schedule(live);
    });
    questionCreations.set(`${canvasId}\0${node.id}`, { promise: creation });
    void creation.catch((error) => {
      rollbackFailedQuestions(canvasId, [node]);
      toast(
        error instanceof Error
          ? error.message
          : 'Failed to restore Agent conversation',
        { tone: 'danger' },
      );
    });
  }
}

/**
 * Nodes an undo brought back whose restoring batch the server refused or
 * the page dropped, with their Space. The server has no such node, so
 * nothing about it can be saved until the restore is sent again.
 */
const failedRestores = new Map<string, string>();

/**
 * Queue the batch that puts `restoredNodes` back on the server. Until it is
 * answered a content save for one of them waits, as for a creation: the
 * server would drop it as a write to a deleted node.
 *
 * @returns Settles when the batch has been answered or dropped.
 */
function sendRestore(
  canvasId: string,
  commands: CanvasCommand[],
  restoredNodes: readonly Node[],
  held: Pick<Parameters<typeof browserSync.submit>[0], 'prev' | 'next'>,
  deletions: readonly Promise<unknown>[],
): Promise<unknown> {
  for (const node of restoredNodes) restoringNodeIds.add(node.id);
  const restore = browserSync.submit({
    canvasId,
    commands,
    ...held,
    ...(deletions.length > 0 ? { gate: Promise.all(deletions) } : {}),
    onSettled: () => {
      // Answered either way: a refusal is followed by a reload.
      for (const node of restoredNodes) {
        restoringNodeIds.delete(node.id);
        preprocessQueue.resumeRestored(canvasId, node.id);
      }
    },
  });
  if (restoredNodes.length > 0) {
    const returned = restore.entry.settled.then((outcome) => {
      if (outcome.kind === 'failed') throw outcome.error;
      if (outcome.kind === 'discarded')
        throw new Error('The restore was discarded before it was sent');
      const refused = outcome.response.results
        .slice(restore.offset, restore.offset + commands.length)
        .some(
          (result, index) =>
            commands[index].type === 'RESTORE_NODES' && !result.applied,
        );
      if (refused) throw new Error('The node could not be restored');
    });
    for (const node of restoredNodes) {
      questionCreations.set(`${canvasId}\0${node.id}`, { promise: returned });
    }
    void returned.then(
      () => {
        for (const node of restoredNodes) failedRestores.delete(node.id);
      },
      () => {
        // What still waits for these nodes (an edit made to one meanwhile)
        // can be saved once `retryFailedRestores` has sent them again.
        for (const node of restoredNodes) failedRestores.set(node.id, canvasId);
      },
    );
  }
  return restore.entry.settled;
}

/**
 * Send again the restore of every node of `canvasId` whose restoring batch
 * failed, when `nodeId` is one of them: the Retry of a content save that
 * waits for such a node. The nodes go back as this page shows them now,
 * content included, so the content save that follows descends from it.
 */
function retryFailedRestores(canvasId: string, nodeId: string): void {
  const state = useCanvasStore.getState();
  if (state.canvasId !== canvasId || failedRestores.get(nodeId) !== canvasId)
    return;
  const ids = new Set(
    [...failedRestores]
      .filter(([, owner]) => owner === canvasId)
      .map(([id]) => id),
  );
  for (const id of ids) failedRestores.delete(id);
  const returning = state.nodes.filter((node) => ids.has(node.id));
  if (returning.length === 0) return;
  // What the server holds: this page's Space without those nodes.
  const before = {
    nodes: state.nodes.filter((node) => !ids.has(node.id)),
    edges: state.edges.filter(
      (edge) => !ids.has(edge.source) && !ids.has(edge.target),
    ),
  };
  const plan = planHistoryRestore(canvasId, before, state);
  if (plan.commands.length === 0) return;
  nodeContentQueue.prepareServerCreatedNodes(returning);
  void sendRestore(
    canvasId,
    plan.commands,
    returning,
    {
      prev: syncView(before.nodes, before.edges),
      next: syncView(state.nodes, state.edges),
    },
    [],
  );
}

/**
 * Undo or redo one history entry.
 *
 * The entry is a snapshot of the Space before one local edit. It is put
 * back whole, as before, unless another page's edit has been applied since:
 * then only what the local edit changed is put back, so the other page's
 * edit stays.
 *
 * The result is saved as the commands that reproduce it, through the send
 * queue (see `sync/restorePlan.ts`): per-property commands where they
 * exist, `RESTORE_NODES` for a node that comes back (with its content, in
 * the same batch) or that no property command reaches. An Agent Node that
 * comes back is re-associated through its own endpoint, with its content
 * held until that is confirmed. When the engine would not reproduce the
 * snapshot exactly, the page shows what the commands give instead, so it
 * and the server hold the same state.
 */
function restoreFromHistory(direction: 'undo' | 'redo'): void {
  const store = useCanvasStore.getState();
  const { nodes, edges, canvasId } = store;
  const snapshot = canvasHistoryManager[direction](nodes, edges, (candidate) =>
    canChangeSpaceEntries(canvasId, nodes, candidate.nodes),
  );
  if (!snapshot) return;
  // Undo swaps in authoritative geometry, so any retained stroke
  // selection / polygon may no longer describe it (e.g. the classic
  // "move strokes then undo" strands the dashed region at the moved
  // position while the strokes revert). Drop the whole floating
  // selection — the delta is unknowable from a generic undo, so
  // re-homing the polygon is not possible; clearing is the safe,
  // reload-consistent choice.
  useGesturePreviewStore.getState().resetCanvasScopedTransients();

  const snapshotTarget =
    snapshot.remoteSince && snapshot.changed
      ? (() => {
          const restored = restoreChanged(
            { nodes, edges } as unknown as Parameters<typeof restoreChanged>[0],
            snapshot as unknown as Parameters<typeof restoreChanged>[1],
            snapshot.changed,
          );
          return {
            nodes: normalizeTreeOrder(
              restored.nodes as unknown as NestableNode[],
            ) as Node[],
            edges: restored.edges as unknown as Edge[],
          };
        })()
      : { nodes: snapshot.nodes, edges: snapshot.edges };

  const action: RecentAction = {
    action: direction === 'undo' ? 'canvas_undone' : 'canvas_redone',
  };
  const plan = canvasId
    ? planHistoryRestore(canvasId, { nodes, edges }, snapshotTarget)
    : null;
  // No command list reproduces the snapshot exactly (the engine fits a
  // Frame or routes an edge its own way): show what the commands give, so
  // this page and the server hold the same state.
  const target =
    plan && !plan.exact
      ? adoptPlanResult(snapshotTarget, plan)
      : snapshotTarget;
  const restoredIds = new Set(plan?.restoredNodeIds ?? []);
  const restoredNodes = target.nodes.filter((node) => restoredIds.has(node.id));
  // The batch writes each returning node's content with it, so the content
  // queue must not create it a second time.
  if (restoredNodes.length > 0)
    nodeContentQueue.prepareServerCreatedNodes(restoredNodes);
  useCanvasStore.setState({ nodes: target.nodes, edges: target.edges });
  let sent: Promise<unknown> | undefined;
  if (plan && plan.commands.length > 0) {
    const live = useCanvasStore.getState();
    // A returning node's earlier sidecar delete must have landed first.
    const deletions = restoredNodes.flatMap((node) =>
      canvasHistoryManager.hasPendingDeletes(canvasId)
        ? [canvasHistoryManager.waitForDeletion(canvasId, node.id)]
        : [],
    );
    sent = sendRestore(
      canvasId,
      plan.commands,
      restoredNodes,
      { prev: syncView(nodes, edges), next: syncView(live.nodes, live.edges) },
      deletions,
    );
  }
  if (plan && plan.restoredQuestionIds.length > 0) {
    restoreQuestionAssociations(canvasId, nodes, target.nodes, sent);
    if (plan.followUp.length > 0) {
      const live = useCanvasStore.getState();
      const associations = plan.restoredQuestionIds.map(
        (nodeId) => questionCreations.get(`${canvasId}\0${nodeId}`)?.promise,
      );
      browserSync.submit({
        canvasId,
        commands: plan.followUp,
        prev: syncView(live.nodes, live.edges),
        next: syncView(live.nodes, live.edges),
        gate: Promise.all(associations),
      });
    }
  }
  preprocessQueue.reconcileHistory(nodes);
  canvasEvents.buffer(canvasId, action);

  canvasHistoryManager.syncServerAfterRestore(
    canvasId,
    nodes,
    target.nodes,
    waitForSidecarWrites,
    (nodeId) => {
      const creation = questionCreations.get(`${canvasId}\0${nodeId}`)?.promise;
      if (!sent) return creation;
      // The sidecar is unlinked after the batch that removes the node.
      return Promise.allSettled([creation, sent]).then(() => undefined);
    },
  );
}

const useCanvasStore = create<RFState>()(
  autoSaveMiddleware((set, get) => ({
    nodes: [],
    edges: [],
    canvasId: '',
    canvasAccess: null,
    refreshCanvasAccess: () => {
      const canvasId = get().canvasId;
      if (!canvasId) return Promise.resolve();
      if (accessRefreshInFlight?.canvasId === canvasId)
        return accessRefreshInFlight.promise;
      const principalId =
        useIdentityStore.getState().identity?.principal.principalId;
      const isCurrent = () =>
        get().canvasId === canvasId &&
        useIdentityStore.getState().identity?.principal.principalId ===
          principalId;
      const promise = getCanvasAccess(canvasId)
        .then((access) => {
          if (isCurrent()) set({ canvasAccess: { canvasId, ...access } });
        })
        .catch(() => {
          if (isCurrent())
            set({ canvasAccess: { canvasId, write: false, manage: false } });
        })
        .finally(() => {
          if (accessRefreshInFlight?.promise === promise)
            accessRefreshInFlight = undefined;
        });
      accessRefreshInFlight = { canvasId, promise };
      return promise;
    },
    version: 0,
    contentPosition: null,
    isLoading: false,
    canvasNotFound: false,
    moveSelectionDialogOpen: false,
    moveSelectionAnchor: null,
    setMoveSelectionDialogOpen: (open, anchor) =>
      set({
        moveSelectionDialogOpen: open,
        moveSelectionAnchor: open ? (anchor ?? null) : null,
      }),
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

    pendingInlineEditNodeId: null,
    consumeInlineEditRequest: (nodeId) => {
      if (get().pendingInlineEditNodeId !== nodeId) return;
      set({ pendingInlineEditNodeId: null });
    },

    pendingRevealNodeIds: [],
    consumeRevealRequest: (nodeIds) => {
      if (get().pendingRevealNodeIds !== nodeIds) return;
      set({ pendingRevealNodeIds: [] });
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
    executeCommands: (inputCommands, source, options) => {
      const resolvedSource = source ?? 'ui';
      const { localOnly, ...engineOptions } = options ?? {};
      const state = {
        nodes: get().nodes,
        edges: get().edges,
        canvasId: get().canvasId,
      };
      // A `ui` batch is persisted by sending these same commands to the
      // server, so the ids it creates must be decided here.
      const closesGesture = resolvedSource === 'ui' && !localOnly;
      const queueable = closesGesture && !!state.canvasId;
      const commands = queueable ? withClientIds(inputCommands) : inputCommands;
      const forServer = queueable
        ? commandsForServer(
            commands,
            NODE_CONTENT_KEYS,
            (nodeId) =>
              state.nodes.find((node) => node.id === nodeId)?.type ===
              'question',
          )
        : { commands: [], sourceIndex: [] };
      const routed = queueable;
      const execution: CanvasExecution = {
        source: resolvedSource,
        commands,
      };

      // The batch that closes a pointer gesture also carries what the
      // gesture's live ticks changed without a command.
      const openGesture =
        closesGesture && canvasHistoryManager.gestureSnapshotTaken
          ? syncGestureBaseline
          : null;
      const gestureBaseline = routed ? openGesture : null;
      // The gesture's ticks leave with this batch. A gesture still under the
      // pointer (a resize a modifier key interrupted) goes on from here, so
      // what its later ticks change is measured from the state this batch
      // leaves.
      const gestureTicksSent = (): void => {
        if (!openGesture) return;
        endSyncGesture(pointerGestureActive() ? get().nodes : null);
      };
      const prelude = gestureBaseline
        ? commandsForLocalDiff(
            gestureBaseline as unknown as UnitNode[],
            state.nodes as unknown as UnitNode[],
            isContentUnit,
          ).commands
        : [];
      const submitPreludeOnly = (): void => {
        if (!gestureBaseline || prelude.length === 0) return;
        browserSync.submit({
          canvasId: state.canvasId,
          commands: prelude,
          prev: syncView(gestureBaseline, state.edges),
          next: syncView(state.nodes, state.edges),
        });
      };

      const { writeResult, commandResults, pendingEffects } =
        executeCanvasCommands(execution, state, {
          ...engineOptions,
          // Agent batches must always refit parent frames because the
          // LLM cannot accurately predict rendered dimensions.
          forceFitFrames: resolvedSource === 'agent',
        });

      // Only commit if at least one command was applied.
      if (
        !commandResults.some((r) => r.applied) ||
        !canChangeSpaceEntries(state.canvasId, state.nodes, writeResult.nodes)
      ) {
        // The gesture's ticks are this edit; record them for its undo entry.
        if (openGesture && openGesture !== state.nodes) {
          canvasHistoryManager.noteChange(
            deriveHeldKeys(
              syncView(openGesture, state.edges),
              syncView(state.nodes, state.edges),
            ).keys(),
          );
        }
        submitPreludeOnly();
        if (!routed || prelude.length > 0) gestureTicksSent();
        return;
      }

      // Whether the send queue persists this batch. A batch whose applied
      // commands are all local (selection, content fields) is not sent.
      const viaQueue =
        routed &&
        (prelude.length > 0 ||
          forServer.sourceIndex.some(
            (index) => commandResults[index]?.applied,
          ));

      const previousIds = new Set(state.nodes.map((node) => node.id));
      const createdNodes = viaQueue
        ? writeResult.nodes.filter((node) => !previousIds.has(node.id))
        : [];
      // The server writes a created node's first content from the command,
      // so the content queue must not also create it.
      if (createdNodes.length > 0)
        nodeContentQueue.prepareServerCreatedNodes(createdNodes);

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

      // What this edit changed, for an undo that must not take back what
      // another page changed since.
      if (
        resolvedSource === 'ui' &&
        !localOnly &&
        ((writeResult.snapshotNeeded && !gestureAlreadySnapshotted) ||
          gestureAlreadySnapshotted)
      ) {
        canvasHistoryManager.noteChange(
          deriveHeldKeys(
            syncView(openGesture ?? state.nodes, state.edges),
            syncView(get().nodes, get().edges),
          ).keys(),
        );
      }

      if (closesGesture) scheduleMeasuredSizeCheck(state.nodes, get().nodes);

      // A routed batch that sends nothing (a selection change) leaves the
      // gesture open for the batch that will.
      if (viaQueue || !routed) gestureTicksSent();

      let sent: Promise<unknown> | undefined;
      if (viaQueue) {
        const forks = createdNodes.flatMap((node) => {
          const fork =
            node.type === 'question'
              ? questionForks.get(`${state.canvasId}\0${node.data.threadId}`)
              : undefined;
          return fork ? [fork] : [];
        });
        // Whether the server took every node this batch created.
        const creationError = (
          outcome: SendOutcome,
          offset: number,
        ): unknown => {
          if (outcome.kind === 'failed') return outcome.error;
          if (outcome.kind === 'discarded')
            return new Error('Creation was discarded before it was sent');
          for (const node of createdNodes) {
            const index = forServer.commands.findIndex(
              (command) =>
                (command.type === 'CREATE_NODES' &&
                  command.nodes.some((created) => created.id === node.id)) ||
                // The Note a PDF was given. When another page gave the PDF
                // its Note first the command is a no-op there, and this
                // page's own Note was never created.
                (command.type === 'INITIALIZE_PDF_NOTE' &&
                  command.noteId === node.id),
            );
            // A node the engine created as a consequence has no creating
            // command to acknowledge.
            if (index < 0) continue;
            const result =
              outcome.response.results[offset + prelude.length + index];
            if (!result?.applied)
              return new Error('Node creation was not acknowledged');
          }
          return undefined;
        };
        const { entry, offset } = browserSync.submit({
          canvasId: state.canvasId,
          commands: [...prelude, ...forServer.commands],
          prev: syncView(gestureBaseline ?? state.nodes, state.edges),
          next: syncView(get().nodes, get().edges),
          ...(forks.length > 0 ? { gate: Promise.all(forks) } : {}),
          ...(createdNodes.length > 0
            ? {
                // The queue already told the user. A creation the server
                // did not take is not on the Space: remove only its
                // optimistic nodes, including copies in later undo
                // entries, before the next batch is sent.
                onSettled: (outcome, at) => {
                  if (creationError(outcome, at) !== undefined)
                    rollbackFailedQuestions(state.canvasId, createdNodes);
                },
              }
            : {}),
        });
        sent = entry.settled;
        if (createdNodes.length > 0) {
          const creation = entry.settled.then((outcome) => {
            if (outcome.kind === 'response') {
              for (const node of createdNodes) {
                const pending = questionCreations.get(
                  `${state.canvasId}\0${node.id}`,
                );
                if (pending?.promise === creation)
                  pending.toVersion = outcome.response.toVersion;
              }
            }
            const error = creationError(outcome, offset);
            if (error !== undefined) throw error;
          });
          for (const node of createdNodes) {
            questionCreations.set(`${state.canvasId}\0${node.id}`, {
              promise: creation,
            });
          }
          void creation.catch(() => undefined);
        }
      }

      // Drain web-only effects (preprocessing trigger, delete
      // tracking, AI flag, transition cleanup, deferred frame fit).
      runWebPostEffects({
        effects: pendingEffects,
        canvasId: state.canvasId,
        getNodes: () => get().nodes,
        getEdges: () => get().edges,
        // A deferred Frame refit is this page's own layout around what its
        // renderer measured; the server lays out from the reported boxes.
        setNodes: (nodes) => set({ nodes }),
        triggerPreprocessing: scheduleAcknowledgedNodePreprocessing,
        forgetNodeContent: nodeContentQueue.forgetNode,
        // The sidecar is unlinked only after the batch that removes the
        // node from the Space has been answered.
        getPendingCreation: (nodeId) => {
          const creation = questionCreations.get(
            `${state.canvasId}\0${nodeId}`,
          )?.promise;
          if (!sent) return creation;
          return Promise.allSettled([creation, sent]).then(() => undefined);
        },
        waitForNodeContent: waitForSidecarWrites,
        validatePreviewNodes: (liveNodeIds) =>
          usePreviewWorkspaceStore.getState().validate(liveNodeIds),
      });
    },

    /**
     * Apply a server-authored delta batch (M2 headless executor).
     *
     * Differs from `executeCommands` in three ways:
     *   1. No engine execution — we replay `deltas` directly via the
     *      shared `applyDeltas` helper.
     *   2. Nothing is sent back — server is already authoritative for
     *      this batch; commit via `_setStateNoAutosave` and reconcile
     *      local `version` to `toVersion`.
     *   3. Snapshot the pre-batch state for ordinary undo.
     */
    applyDeltasFromAgent: (
      deltas,
      toVersion,
      pendingEffects,
      agentNodeProjection = false,
      order,
      sync,
    ) => {
      const orderEvents = order?.events ?? [];
      const reconcileIncomingVersion = (): void => {
        get()._setStateNoAutosave({
          version: Math.max(get().version, toVersion),
        });
      };

      // A locally removed optimistic Question must not reappear when its
      // delayed creation arrives over HTTP or SSE. Its tracked DELETE waits
      // for that same creation, so the server converges to the removal too.
      const removedQuestionIds = new Set(
        deltas.flatMap((delta) => {
          if (delta.type !== 'INSERT_NODE' || delta.node.type !== 'question')
            return [];
          const creation = questionCreations.get(
            `${get().canvasId}\0${delta.node.id}`,
          );
          return creation &&
            (creation.toVersion === undefined ||
              toVersion <= creation.toVersion) &&
            !get().nodes.some((node) => node.id === delta.node.id)
            ? [delta.node.id]
            : [];
        }),
      );
      deltas = deltas.filter(
        (delta) =>
          !(
            delta.type === 'INSERT_NODE' &&
            removedQuestionIds.has(delta.node.id)
          ) &&
          !(
            delta.type === 'INSERT_EDGE' &&
            (removedQuestionIds.has(delta.edge.source) ||
              removedQuestionIds.has(delta.edge.target))
          ),
      );

      // Never let an incoming agent write clobber a
      // node the user is mid-editing. Skip REPLACE/DELETE deltas that
      // target a node with un-persisted local content edits (INSERT is a
      // fresh id, never a collision). Report the skipped ids so the UI
      // can flag the conflict on the originating thread's change card.
      const dirty = new Set(nodeContentQueue.pendingNodeIds());
      const skippedNodeIds: string[] = [];
      const skippedRemoteNodes: Node[] = [];
      const advancedRemoteBaselines: Node[] = [];
      const preservedPendingNodeIds = new Set<string>();
      const localNodesById = new Map(
        get().nodes.map((node) => [node.id, node]),
      );
      if (agentNodeProjection) {
        deltas = deltas.map((delta) => {
          if (
            delta.type !== 'REPLACE_NODE' ||
            delta.prev.type !== 'question' ||
            delta.next.type !== 'question'
          )
            return delta;
          const live = localNodesById.get(delta.next.id);
          if (live?.type !== 'question') return delta;
          // Lifecycle/title projections carry stale geometry in coarse deltas.
          // Apply their data effects without replacing local resize/undo state.
          return {
            ...delta,
            prev: live,
            next: {
              ...live,
              data: preserveAgentNodeOwnedData(
                replayAgentNodeEditableData(
                  live.data,
                  delta.prev.data,
                  delta.next.data,
                ),
                delta.next.data,
              ),
            },
          };
        });
      }
      // Apply the batch property by property: write only what it changed,
      // and leave alone what this page changed and has not had confirmed.
      // A gesture under the pointer holds what its ticks have changed so
      // far, exactly as a queued batch would: the update must not move a
      // node out from under the hand.
      const incoming = deltas;
      const gestureKeys = syncGestureBaseline
        ? deriveHeldKeys(
            syncView(syncGestureBaseline, get().edges),
            syncView(get().nodes, get().edges),
            isUnsentUnit,
          )
        : null;
      const locallyHeld = (key: string): boolean =>
        gestureKeys?.has(key) === true;
      const remote: PreparedRemote = browserSync.prepareRemote({
        deltas,
        localNodes: syncView(get().nodes, get().edges).nodes,
        localEdges: syncView(get().nodes, get().edges).edges,
        ...((gestureKeys?.size ?? 0) > 0 ? { alsoHeld: locallyHeld } : {}),
        ...(sync?.operationId ? { operationId: sync.operationId } : {}),
        ...(sync?.source ? { source: sync.source } : {}),
      });
      deltas = remote.deltas;
      // The gesture goes on under the parent this page shows; remember that
      // its batch was made there.
      for (const unit of remote.withheld) {
        if (
          unit.unit === PARENT_UNIT &&
          gestureKeys?.has(nodeUnitKey(unit.nodeId, PARENT_UNIT))
        )
          gestureWithheldParents.add(unit.nodeId);
      }
      // A person's edit is theirs to undo, not this page's.
      const recordUndo = !remote.own && sync?.source !== 'ui';
      const serverNodeOf = (node: { id: string }): Node =>
        (remote.serverNodes.get(node.id) ?? node) as unknown as Node;
      const safeDeltas =
        dirty.size === 0
          ? deltas
          : deltas.flatMap((d): Delta[] => {
              if (d.type === 'REPLACE_NODE' && dirty.has(d.next.id)) {
                const prevData = (d.prev.data ?? {}) as Record<string, unknown>;
                const nextData = (d.next.data ?? {}) as Record<string, unknown>;
                const pendingFields = nodeContentQueue.pendingFields(d.next.id);
                // JSON transport gives unchanged keywords/provenance separate
                // object identities; compare their values, not references.
                const changedContentFields = [...NODE_CONTENT_KEYS].filter(
                  (key) => !deepEqual(prevData[key], nextData[key]),
                );
                const changesPendingContent = changedContentFields.some((key) =>
                  pendingFields.has(key),
                );
                const local = localNodesById.get(d.next.id);
                if (local?.type === 'question') {
                  const localData = (local.data ?? {}) as Record<
                    string,
                    unknown
                  >;
                  const mergedData = { ...nextData };
                  for (const key of pendingFields) {
                    if (key in localData) mergedData[key] = localData[key];
                    else delete mergedData[key];
                  }
                  preservedPendingNodeIds.add(d.next.id);
                  if (changesPendingContent) {
                    skippedNodeIds.push(d.next.id);
                    skippedRemoteNodes.push(serverNodeOf(d.next));
                  } else if (
                    changedContentFields.some((key) =>
                      [
                        'content',
                        'src',
                        'properties',
                        'propertyDisplayKeys',
                      ].includes(key),
                    )
                  ) {
                    advancedRemoteBaselines.push(serverNodeOf(d.next));
                  }
                  return [
                    {
                      ...d,
                      prev: local,
                      next: { ...local, data: mergedData },
                    },
                  ];
                }
                if (!changesPendingContent) {
                  // Coarse REPLACE_NODE deltas carry the server's full node,
                  // including stale content fields. A lifecycle-only update
                  // (for example Question running/done/viewed) is safe to
                  // apply while preserving every locally pending content
                  // field; otherwise applying `next` would erase the edit.
                  if (local) {
                    const localData = (local.data ?? {}) as Record<
                      string,
                      unknown
                    >;
                    const mergedData = { ...nextData };
                    for (const key of NODE_CONTENT_KEYS) {
                      if (key in localData) mergedData[key] = localData[key];
                      else delete mergedData[key];
                    }
                    preservedPendingNodeIds.add(d.next.id);
                    return [
                      {
                        ...d,
                        prev: local,
                        next: { ...d.next, data: mergedData },
                      },
                    ];
                  }
                }
                skippedNodeIds.push(d.next.id);
                skippedRemoteNodes.push(serverNodeOf(d.next));
                return [];
              }
              if (d.type === 'DELETE_NODE' && dirty.has(d.node.id)) {
                skippedNodeIds.push(d.node.id);
                return [];
              }
              return [d];
            });

      // Local-first rebase for a node the user is mid-editing: we keep their
      // in-memory version (skipped above) but adopt the agent's just-written
      // revision as the save baseline. The user's next autosave then rebases
      // on top (expectRev = agent's rev) and cleanly overwrites the agent's
      // version, instead of tripping a false NODE_CONTENT_CONFLICT against a
      // change the local-first policy already decided the user wins. The
      // "your version was kept" notice tells the user what happened; the
      // change-review card lets them inspect the agent's dropped edit.
      //
      // Not so for a node frozen by a content conflict: the user has not
      // chosen between their text and the server's yet, and an update must
      // not choose for them. It stays frozen; "Keep mine" will overwrite
      // the revision this update brought.
      const rebasedRemoteNodes = [
        ...skippedRemoteNodes,
        ...advancedRemoteBaselines,
      ].filter((remoteNode) => !nodeContentQueue.rebaseConflict(remoteNode));
      if (rebasedRemoteNodes.length > 0) {
        nodeContentQueue.seedBaselines(rebasedRemoteNodes);
      }

      if (safeDeltas.length === 0 && orderEvents.length === 0) {
        // Nothing to apply locally (empty batch, or every row protected).
        // Still reconcile the version so the next local edit's autosave
        // doesn't 409 against our stale view of server state.
        reconcileIncomingVersion();
        rebaseGestureBaseline(incoming);
        remote.finish();
        return skippedNodeIds;
      }

      const prevNodes = get().nodes;
      const prevEdges = get().edges;
      const canvasId = get().canvasId;
      const insertedSpaceTargets = safeDeltas.flatMap((delta) =>
        delta.type === 'INSERT_NODE' &&
        delta.node.type === 'spacePreview' &&
        typeof delta.node.data.targetCanvasId === 'string'
          ? [delta.node.data.targetCanvasId]
          : [],
      );
      if (insertedSpaceTargets.length)
        void useWorkspaceStore
          .getState()
          .refreshSpaceTitles(insertedSpaceTargets);
      let undoSnapshotTaken = false;
      if (agentNodeProjection) {
        canvasHistoryManager.rebaseAgentInitialContent(safeDeltas);
      } else if (
        recordUndo &&
        safeDeltas.some((delta) => {
          if (delta.type === 'INSERT_NODE' && delta.node.type === 'question') {
            const live = prevNodes.find((node) => node.id === delta.node.id);
            if (!live) return true;
            return !deepEqual(
              {
                ...stripTransientNodeFields(live),
                data: projectAgentNodeEditableData(live.data),
              },
              {
                ...stripTransientNodeFields(delta.node),
                data: projectAgentNodeEditableData(delta.node.data ?? {}),
              },
            );
          }
          if (delta.type !== 'REPLACE_NODE' || delta.next.type !== 'question')
            return true;
          return !deepEqual(
            {
              ...delta.prev,
              data: projectAgentNodeEditableData(delta.prev.data ?? {}),
            },
            {
              ...delta.next,
              data: projectAgentNodeEditableData(delta.next.data ?? {}),
            },
          );
        })
      ) {
        canvasHistoryManager.takeSnapshot(prevNodes, prevEdges);
        canvasHistoryManager.noteChange(remote.covered);
        undoSnapshotTaken = true;
      }
      // Another person's edit is not in this page's history, so no earlier
      // entry may put the whole Space back to how it was before it.
      if (!remote.own && sync?.source === 'ui')
        canvasHistoryManager.markRemoteChange();

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
      const entityOrderedNodes = normalizeTreeOrder(
        applied.nodes as NestableNode[],
      );

      // Entity deltas cannot express sibling paint order, so the server's
      // order is installed over their result. A failed replay keeps that
      // result unchanged.
      const orderReplay =
        orderEvents.length > 0
          ? replaySiblingOrder(
              prevNodes as NestableNode[],
              entityOrderedNodes,
              // Includes the optimistic copy of a node this page created.
              remote.insertedNodeIds,
              orderEvents,
            )
          : { nodes: entityOrderedNodes, diverged: false };
      const orderedNodes = orderReplay.nodes;
      if (
        recordUndo &&
        !agentNodeProjection &&
        !undoSnapshotTaken &&
        orderedNodes.some(
          (node, index) => node.id !== entityOrderedNodes[index]?.id,
        )
      ) {
        // An order-only change is undoable like any other applied batch.
        canvasHistoryManager.takeSnapshot(prevNodes, prevEdges);
      }

      get()._setStateNoAutosave({
        nodes: orderedNodes as Node[],
        edges: applied.edges as Edge[],
      });
      reconcileIncomingVersion();

      // Re-seed the content-CAS baseline of the nodes whose saved content
      // this batch changed (or created), from the server's own copy of the
      // node in the batch. A node the batch left alone, or changed only in
      // structure, keeps the baseline it has: what the page shows is not
      // always what the server stores (a PDF's extracted body is not sent
      // with a load, an Office body is normalized), so a revision computed
      // from it would refuse the node's next property save as a conflict —
      // after every structure edit, since the page's own edits come back
      // through here. Skipped mid-edit nodes had their baseline adopted to
      // the agent's rev above (local-first rebase), and a node with unsaved
      // content is not the server's; both are left out.
      {
        const skippedSet = new Set(skippedNodeIds);
        const present = new Set((applied.nodes as Node[]).map((n) => n.id));
        const contentChanged = new Set<string>();
        for (const delta of incoming) {
          if (delta.type === 'INSERT_NODE') contentChanged.add(delta.node.id);
          else if (delta.type === 'REPLACE_NODE') {
            const before = (delta.prev.data ?? {}) as Record<string, unknown>;
            const after = (delta.next.data ?? {}) as Record<string, unknown>;
            if (
              [...NODE_CONTENT_KEYS].some(
                (key) => !deepEqual(before[key], after[key]),
              )
            )
              contentChanged.add(delta.next.id);
          }
        }
        nodeContentQueue.seedBaselines(
          [...contentChanged]
            .filter(
              (id) =>
                present.has(id) &&
                remote.serverNodes.has(id) &&
                !skippedSet.has(id) &&
                !preservedPendingNodeIds.has(id) &&
                !dirty.has(id),
            )
            .map((id) => serverNodeOf({ id })),
        );
      }

      // Post-effects must not run for nodes whose delta we skipped — they
      // were not actually mutated locally, so preprocessing / fit them is
      // wrong.
      const skipped = new Set([...skippedNodeIds, ...removedQuestionIds]);
      runWebPostEffects({
        // This page already ran the effects of its own batch when it
        // executed it. Preprocessing of another person's edit is triggered
        // by the page that made it.
        effects: remote.own
          ? {
              mutatedNodes: [],
              deletedNodeIds: [],
              contentEditedNodeIds: [],
              deferredFitFrameIds: [],
            }
          : {
              mutatedNodes:
                sync?.source === 'ui'
                  ? []
                  : skipped.size === 0
                    ? pendingEffects.mutatedNodes
                    : pendingEffects.mutatedNodes.filter(
                        (n) => !skipped.has(n.id),
                      ),
              deletedNodeIds:
                skipped.size === 0
                  ? pendingEffects.deletedNodeIds
                  : pendingEffects.deletedNodeIds.filter(
                      (id) => !skipped.has(id),
                    ),
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
        triggerPreprocessing: scheduleAcknowledgedNodePreprocessing,
        forgetNodeContent: nodeContentQueue.forgetNode,
        getPendingCreation: (nodeId) =>
          questionCreations.get(`${canvasId}\0${nodeId}`)?.promise,
        waitForNodeContent: waitForSidecarWrites,
        validatePreviewNodes: (liveNodeIds) =>
          usePreviewWorkspaceStore.getState().validate(liveNodeIds),
      });

      // Keep the open gesture's starting point in step with the server —
      // including what was kept back just now — so its closing batch sends
      // only what the gesture itself changed, and a cancelled gesture goes
      // back to the server's values.
      rebaseGestureBaseline(incoming);

      // A measurement the server holds needs no second report from here.
      for (const delta of safeDeltas) {
        const reportedNode =
          delta.type === 'REPLACE_NODE'
            ? delta.next
            : delta.type === 'INSERT_NODE'
              ? delta.node
              : undefined;
        if (!reportedNode) continue;
        const { hint } = readAutoHeightHint(reportedNode as unknown as Node);
        if (hint && !hint.provisional)
          reportedHeightKeys.set(reportedNode.id, hint.measuredFor);
        // The server holds a box for this node now: this page's own report,
        // or another page's.
        if (readMeasuredSizeHint(reportedNode as unknown as Node))
          reportedSizes.delete(reportedNode.id);
      }

      // Release what this batch confirmed and install what it left to the
      // server's earlier value.
      remote.finish();

      // Rows withheld for local-first reasons and unsaved edits make the
      // local order differ on purpose; the next save settles it. So does an
      // unconfirmed local change to the same parent's children: the update
      // for that change carries the order the server ended with.
      if (
        orderReplay.diverged &&
        skipped.size === 0 &&
        !hasUnsavedStructureOrContent() &&
        !orderEvents.some((event) => remote.orderHeld(event.parentId)) &&
        // A parent change kept back leaves the node among its local
        // siblings; the answer to the change that holds it settles both.
        !remote.withheld.some((unit) => unit.unit === PARENT_UNIT)
      ) {
        order?.onDiverged?.();
      }

      return skippedNodeIds;
    },

    pendingContentNodeIds: () => nodeContentQueue.pendingNodeIds(),

    /** Resolve a web-only UiIntent and execute the resulting commands. */
    dispatchUiIntent: (intent) => {
      if (intent.type === 'DELETE_NODES') {
        const state = get();
        const summaries = useWorkspaceStore.getState().spaceSummaries;
        const affected = new Set(intent.nodeIds);
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of state.nodes) {
            if (
              node.parentId &&
              affected.has(node.parentId) &&
              !affected.has(node.id)
            ) {
              affected.add(node.id);
              changed = true;
            }
          }
        }
        const owned = Object.entries(summaries).filter(
          ([, summary]) =>
            summary?.parentSpaceId === state.canvasId &&
            summary.parentEntryNodeId &&
            affected.has(summary.parentEntryNodeId),
        );
        if (owned.length) {
          const [childId, child] = owned[0]!;
          if (
            owned.length === 1 &&
            intent.nodeIds.length === 1 &&
            intent.nodeIds[0] === child?.parentEntryNodeId
          ) {
            window.dispatchEvent(
              new CustomEvent(REQUEST_DELETE_SPACE, { detail: childId }),
            );
          } else {
            toast(t('spaceHierarchy.deleteEntrySeparately'), {
              tone: 'warning',
            });
          }
          return;
        }
      }
      // Fullscreen Preview unmounts Canvas; retain a nearby placement until
      // the queued reveal can run against the restored, unobscured viewport.
      const viewportCenter = getCanvasViewportCenter(get());
      const uiState: UiResolverState = {
        nodes: get().nodes,
        edges: get().edges,
        ...(viewportCenter ? { viewportCenter } : {}),
      };
      const execution = resolveUiIntent(intent, uiState);
      if (execution.rejectionKey) {
        toast(t(execution.rejectionKey), { tone: 'warning' });
        return;
      }
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
                localOnly: true,
              }
            : undefined,
        );
      }
      if (execution.revealNodeIds?.length) {
        const existingIds = new Set(uiState.nodes.map((node) => node.id));
        const liveIds = new Set(get().nodes.map((node) => node.id));
        const createdIds = execution.revealNodeIds.filter(
          (id) => !existingIds.has(id) && liveIds.has(id),
        );
        if (createdIds.length > 0) {
          set({ pendingRevealNodeIds: createdIds });
        }
      }
      if (editNodeId !== undefined && !editTargetAlreadyExists) {
        const node = get().nodes.find(({ id }) => id === editNodeId);
        if (node?.type === 'note') {
          // Inline the settle-previous + expand + focus-tick sequence
          // Opening the editor here is a silent side effect of creation,
          // so it updates workspace presentation without emitting another
          // user-intent event.
          const previousId = selectActiveNodeId(
            usePreviewWorkspaceStore.getState(),
          );
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
          const previewTabId = usePreviewWorkspaceStore
            .getState()
            .openPreviewTarget({
              kind: 'node',
              canvasId: get().canvasId,
              nodeId: node.id,
            });
          if (previewTabId) {
            usePreviewWorkspaceStore.getState().requestNodeFocus(previewTabId);
          }
        } else if (node?.type === 'text') {
          set({ pendingInlineEditNodeId: node.id });
        }
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
        canvasEvents.bufferMany(get().canvasId, execution.trace);
      }
    },

    getAgentChatContext: (captured): AgentChatContext => {
      const { nodes } = get();
      const selection = captured ?? {
        nodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
        strokeSelection:
          useGesturePreviewStore.getState().sketchStrokeSelection,
      };
      const included = new Set(selection.nodeIds);
      const buildSelectedDetail = makeBuildSelectedDetail(nodes, selection);
      const selectedNodes = nodes
        .filter(
          (node) =>
            included.has(node.id) &&
            !selection.excludeNodeIds?.includes(node.id),
        )
        .map(buildSelectedDetail);

      // Fold in any Stage-2 partial stroke selection as sketch wire
      // nodes carrying `strokeIds`. Stroke selection lives outside
      // ReactFlow node selection (gesturePreviewStore), so these nodes
      // are normally NOT in the `n.selected` set — append them with
      // their stroke subset so the server can auto-snapshot + address
      // just those strokes and tell the agent it is a partial selection.
      const strokeSel = selection.strokeSelection;
      const selectedIds = new Set<string>();
      const collectSelectedIds = (values: WireSelectionNode[]): void => {
        for (const value of values) {
          if (value.referenceOnly) continue;
          selectedIds.add(value.id);
          if (value.children?.length) collectSelectedIds(value.children);
        }
      };
      collectSelectedIds(selectedNodes);
      for (const [nodeId, strokeIds] of Object.entries(strokeSel)) {
        if (selection.excludeNodeIds?.includes(nodeId)) continue;
        if (!strokeIds || strokeIds.length === 0) continue;
        const node = nodes.find((n) => n.id === nodeId);
        if (!node || node.type !== 'sketch') continue;
        if (selectedIds.has(nodeId)) {
          // Rare mixed case: the sketch is also whole-node selected —
          // attach the subset to its existing wire entry.
          const existing = selectedNodes.find((n) => n.id === nodeId);
          if (existing) existing.strokeIds = [...strokeIds];
          continue;
        }
        const data = node.data as Record<string, unknown> | undefined;
        selectedNodes.push({
          id: nodeId,
          type: 'sketch',
          label: data?.label as string | undefined,
          strokeIds: [...strokeIds],
        });
      }

      return { selectedNodes };
    },

    loadCanvas: async (canvasId, options) => {
      // Explicit reloads must not discard the only copy of a restored body.
      // SSE gap reloads already skip dirty nodes; this also covers manual load.
      if (nodeContentQueue.hasPendingRestoredContent())
        await drainPendingSaves();
      set({
        isLoading: true,
        canvasAccess: null,
        pendingRevealNodeIds: [],
        canvasNotFound: false,
      });
      try {
        const targetId = canvasId ?? get().canvasId;
        // Loading a Space only restores an existing legacy conversation.
        // Creating a new Chat is an explicit action requiring Agent defaults.
        const chatThreadId = useChatStore.getState().threadMap[targetId];
        usePreviewWorkspaceStore
          .getState()
          .loadForCanvas(targetId, { chatThreadId });
        canvasHistoryManager.activate(targetId, options?.resetHistory);
        if (canvasId && targetId !== get().canvasId) {
          useToolStore.getState().resetForCanvasSwitch();
          get()._setStateNoAutosave({
            canvasId: targetId,
            canvasTitle: '',
          });
        }
        const response = await getCanvas(targetId);
        if (get().canvasId !== targetId) return;
        if (!response) {
          console.warn('Canvas not found:', targetId);
          canvasHistoryManager.clear();
          set({
            isLoading: false,
            canvasNotFound: true,
            ingestionByNodeId: {},
            pendingForkThreadIds: {},
          });
          return;
        }

        set({
          canvasAccess: response.access
            ? { canvasId: targetId, ...response.access }
            : null,
        });

        const state = response.state as {
          nodes?: Node[];
          edges?: Edge[];
          // Legacy field: older canvases still carry a server-side
          // viewport. Used only as a one-shot fallback when this client
          // has no local viewport entry yet. Nothing the browser sends
          // carries it any more.
          viewport?: CanvasViewport;
        };
        // Remove obsolete question auto-run state without guessing a
        // terminal outcome. A node can own a persisted conversation whose
        // last turn failed, so thread/content presence must never imply done.
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
        // Ignore retired topology in memory only. Import and snapshot reloads
        // enter here too; loading does not delete files or persist a migration.
        const topology = stripLegacyPortalTopology(
          state.nodes ?? [],
          state.edges ?? [],
        );
        const loadedNodes = normalizeNodeHeights(
          normalizeTreeOrder(
            reconcileQuestionStatus(topology.nodes) as NestableNode[],
          ) as Node[],
        );
        const loadedEdges = topology.edges;
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
        let warmedNodes = normalizeFrameHeaderInsets(warmedCanvas.nodes);
        let warmedEdges =
          warmedNodes === warmedCanvas.nodes
            ? warmedCanvas.edges
            : rerouteAllEdges(warmedNodes, warmedCanvas.edges);
        if (get().canvasId !== targetId) return;
        const loadedVersion = response.version;
        let headerSaveFailed = false;
        if (warmedNodes !== warmedCanvas.nodes) {
          // Persist the coordinate change before exposing it to users or
          // agents: send it as the geometry commands that state it, then
          // load what the server made of them. One attempt per load; a
          // Space that still needs it afterwards is shown as stored.
          const migrated =
            !headerMigrationTried.has(targetId) &&
            (await persistFrameHeaderMigration(
              targetId,
              warmedCanvas.nodes,
              warmedNodes,
            ));
          if (get().canvasId !== targetId) return;
          if (migrated) {
            headerMigrationTried.add(targetId);
            try {
              return await get().loadCanvas(canvasId, options);
            } finally {
              headerMigrationTried.delete(targetId);
            }
          }
          headerSaveFailed = true;
          warmedNodes = loadedNodes;
          warmedEdges = loadedEdges;
        }
        if (get().canvasId !== targetId) return;
        // An authoritative node replacement invalidates every transient that
        // points at the previous in-memory geometry. This applies both to a
        // different-canvas switch and to a same-canvas SSE gap/snapshot heal:
        // even when the canvas id is unchanged, selected stroke ids and
        // retained polygons may have been deleted or moved remotely.
        useGesturePreviewStore.getState().resetCanvasScopedTransients();
        // The loaded Space is the server's: nothing local is unconfirmed.
        syncGestureBaseline = null;
        gestureWithheldParents.clear();
        const loadedBasis = response.basis ? parseBasis(response.basis) : null;
        syncLineage = loadedBasis
          ? { canvasId: targetId, lineage: loadedBasis.lineage }
          : null;
        browserSync.adoptedServerState(targetId);
        heightsAwaitingContent.clear();
        reportedHeightKeys.clear();
        sizesAwaitingContent.clear();
        reportedSizes.clear();
        localSizes.clear();
        restoringNodeIds.clear();
        failedRestores.clear();
        for (const node of loadedNodes) {
          const { hint } = readAutoHeightHint(node);
          if (hint && !hint.provisional)
            reportedHeightKeys.set(node.id, hint.measuredFor);
        }
        // Do not autosave the loaded baseline again. The no-autosave setter
        // also skips history availability sync, so restore those flags here.
        get()._setStateNoAutosave({
          nodes: warmedNodes,
          edges: warmedEdges,
          viewport: loadedViewport,
          canvasTitle: response.title || 'Untitled',
          version: loadedVersion,
          contentPosition: response.contentPosition ?? null,
          isLoading: false,
          canUndo: canvasHistoryManager.canUndo,
          canRedo: canvasHistoryManager.canRedo,
          ingestionByNodeId: {},
          pendingForkThreadIds: {},
        });
        usePreviewWorkspaceStore
          .getState()
          .validate(new Set(warmedNodes.map((node) => node.id)));

        // Persist Note warmup hints unless the header write already included them.
        if (
          !headerSaveFailed &&
          warmedCanvas.nodes !== loadedNodes &&
          warmedNodes === warmedCanvas.nodes
        ) {
          const loadedById = new Map(
            loadedNodes.map((node) => [node.id, node]),
          );
          reportMeasuredHeights(
            warmedNodes.flatMap((node) =>
              loadedById.get(node.id) === node ? [] : [node.id],
            ),
          );
        }

        // Seed each md-backed node's optimistic-concurrency baseline from
        // the authoritative content we just loaded, so the first edit
        // carries the correct `expectRev` and the per-node content CAS can
        // catch a concurrent (cross-tab / cross-device / agent) write.
        nodeContentQueue.seedBaselines(
          warmedNodes,
          response.nodeContentRevisions,
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
        set({ isLoading: false });
      }
    },

    switchCanvas: async (canvasId: string) => {
      const currentId = get().canvasId;
      if (canvasId === currentId) return;

      // Keep the outgoing Space authoritative and editable until saving succeeds.
      await drainPendingSaves();
      set({ isLoading: true, canvasNotFound: false });

      // Cancel all pending preprocessing timers
      preprocessQueue.cancelAll();

      // Reset state for clean slate. `viewport` is cleared so the new
      // canvas's restore effect either applies its own saved viewport
      // or, for older canvases without one, runs a one-shot fitView.
      set({
        pendingInlineEditNodeId: null,
        pendingRevealNodeIds: [],
        collapsedFrameIds: new Set(),
        canvasNotFound: false,
        viewport: null,
      });
      useGesturePreviewStore.getState().resetCanvasScopedTransients();
      // Load the new canvas
      await get().loadCanvas(canvasId);
    },

    tryRename: async (kind, id, nextName) => {
      if (
        !(kind === 'canvas'
          ? selectCanManageCanvas(get())
          : selectCanWriteCanvas(get()))
      )
        return false;
      // One editor at a time: another page is editing this node's body or
      // title. Checked here so every rename surface is covered.
      if (kind === 'node' && !canStartEditing(id)) return false;
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
          // The title has its own endpoint; it is not part of the Space's
          // structure. Other pages learn it from the sync stream.
          const renamed = await renameSpace(canvasId, {
            title: trimmed,
            expectedTitle: previous,
          });
          if (get().canvasId === canvasId && renamed.title)
            set({ canvasTitle: renamed.title });
          return true;
        } catch (err) {
          if (get().canvasId !== canvasId) return false;
          if (
            err instanceof ApiError &&
            (err.status === 403 || err.code === 'SPACE_TITLE_CHANGED')
          ) {
            set({ canvasTitle: previous });
            if (err.status === 403) void get().refreshCanvasAccess();
            return false;
          }
          if (err instanceof ApiError && err.code === 'CANVAS_TITLE_CONFLICT') {
            set({ canvasTitle: previous });
            toast(
              `Canvas name "${trimmed}" is already in use. Choose a different name.`,
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
      const currentPendingInkIntentLabel = (
        target.data as Record<string, unknown> | undefined
      )?.['pendingInkIntentLabel'];
      if (normalize(currentLabel) === normalize(trimmed)) {
        // An explicit no-op rename still claims the label for the user and
        // prevents a delayed inferred Ink intent from replacing it.
        if (currentLabel !== trimmed || currentPendingInkIntentLabel === true) {
          get().updateNodeData(id, {
            label: trimmed,
            labelSource: 'user',
            pendingInkIntentLabel: false,
          });
          try {
            await nodeContentQueue.flushNow(canvasId, id, { source: 'user' });
          } catch {
            return false;
          }
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
      get().updateNodeData(id, {
        label: trimmed,
        labelSource: 'user',
        pendingInkIntentLabel: false,
      });
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
              // Strip the optimistic `labelSource: 'user'` first so we
              // can restore the original provenance exactly — including
              // the "was previously absent" case (omit the key entirely
              // rather than leaving a literal `undefined` value behind).
              const {
                labelSource: _omitted,
                pendingInkIntentLabel: _pendingOmitted,
                ...rest
              } = (n.data ?? {}) as Record<string, unknown>;
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
                  ...(currentPendingInkIntentLabel !== undefined
                    ? {
                        pendingInkIntentLabel: currentPendingInkIntentLabel,
                      }
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

    flushCanvasEvents: async (canvasId = get().canvasId) => {
      await canvasEvents.flush(canvasId);
    },

    onNodeDragStart: (event, _draggedNode, draggedNodes) => {
      useGesturePreviewStore.getState().clearStructuredDropPreview();
      // Snapshot the true pre-drag positions before any intermediate
      // position updates are applied by ReactFlow.
      get().beginGesture('SET_NODE_GEOMETRY');
      // A height correction landing mid-drag would move geometry under
      // the user's hand. Hold them until the gesture settles.
      suspendHeightCommits('node-drag');

      // Record the pre-drag positions of the dragged nodes so
      // `onNodeDragStop` can tell whether the gesture actually moved
      // anything (and thus has to be sent) even when the resolver
      // emits no command.
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
        nestedFrameEntryAllowed: event.metaKey || event.ctrlKey,
      });
    },

    onNodeResizeStart: () => {
      get().beginGesture('SET_NODE_GEOMETRY');
      suspendHeightCommits('node-resize');
    },

    closePointerGesture: () => {
      submitGestureTicks(get().edges);
    },

    onNodeDrag: (_event, draggedNode, draggedNodes) => {
      // Capture the cursor's screen position now (before the rAF) so the
      // structured-frame drop indicator can be placed at the actual
      // pointer, not where the dragged node settled.
      const pointerScreen = getDragPointerPosition(_event);
      const pendingDrop =
        useGesturePreviewStore.getState().structuredDropPreview;
      const pointer = pointerScreen
        ? get().rfInstance?.screenToFlowPosition(pointerScreen)
        : undefined;
      if (
        pendingDrop?.masonry?.gap &&
        pointer &&
        !isPointInTrackGap(pendingDrop.masonry.gap, pointer)
      ) {
        useGesturePreviewStore.getState().clearStructuredDropPreview();
      }

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
        const allowNestedFrameEntry = isNestedFrameEntryAllowed();

        const liveNodes = nodes.map((node) => {
          const live =
            node.id === draggedNode.id
              ? draggedNode
              : draggedNodes.find((dragged) => dragged.id === node.id);
          return live
            ? mergeLiveDragGeometry(node as NestableNode, live)
            : (node as NestableNode);
        });

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
                allowNestedFrameEntry,
              });
          if (targetFrameId) {
            if (
              originalNode.parentId &&
              originalNode.parentId !== targetFrameId
            ) {
              let leaving = leavingByFrame.get(originalNode.parentId);
              if (!leaving) {
                leaving = new Set();
                leavingByFrame.set(originalNode.parentId, leaving);
              }
              leaving.add(dn.id);
            }
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

        let projectedSourceNodes = liveNodes;
        for (const leavingIds of leavingByFrame.values()) {
          for (const leavingId of leavingIds) {
            projectedSourceNodes = projectNodeOutOfFrame(
              projectedSourceNodes,
              leavingId,
            );
          }
        }
        let projectedGestureNodes = projectAffectedFrameGeometry(
          projectedSourceNodes,
          leavingByFrame.keys(),
          edges,
        ).nodes;
        const liveById = new Map(liveNodes.map((node) => [node.id, node]));
        const publishGeometryProjection = (projection: NestableNode[]) => {
          const geometryPreviews = projection.flatMap((node) => {
            const current = liveById.get(node.id);
            if (!current) return [];
            if (draggedIds.has(node.id)) {
              const position = compensateDetachedDragPosition(
                current,
                projection,
              );
              return position ? [{ ...node, position }] : [];
            }
            const currentSize = getNodeSize(current);
            const nextSize = getNodeSize(node);
            const changed =
              current.position.x !== node.position.x ||
              current.position.y !== node.position.y ||
              currentSize.width !== nextSize.width ||
              currentSize.height !== nextSize.height;
            return changed ? [node] : [];
          });
          useGesturePreviewStore
            .getState()
            .setNodeGeometryPreviews(geometryPreviews);
        };

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
        const publishFrameIntentPreviews = (projection: NestableNode[]) => {
          const aligned = previews.map((preview) => {
            const frame = projection.find(
              (node) => node.id === preview.frameId,
            );
            const position = getFrameAbsolutePosition(
              projection,
              preview.frameId,
            );
            if (!frame || !position) return preview;
            const size = getNodeSize(frame);
            return {
              ...preview,
              position,
              width: size.width,
              height: size.height,
            };
          });
          useGesturePreviewStore.getState().setFrameFitPreviews(aligned);
        };

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
              allowNestedFrameEntry,
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

        if (enteringFrameId && targetFrame && !gridCfg) {
          projectedGestureNodes = projectNodeIntoFrame(
            projectedGestureNodes,
            draggedNode.id,
            enteringFrameId,
          );
          projectedGestureNodes = projectAffectedFrameGeometry(
            projectedGestureNodes,
            [enteringFrameId],
            edges,
          ).nodes;
        }

        const currentTargetFrameAbs = targetFrameId
          ? getFrameAbsolutePosition(liveNodes, targetFrameId)
          : null;
        const projectedTargetFrameAbs = targetFrameId
          ? getFrameAbsolutePosition(projectedGestureNodes, targetFrameId)
          : currentTargetFrameAbs;

        for (const frameId of previewFrameIds) {
          const frameNode = projectedGestureNodes.find(
            (node) => node.id === frameId,
          );
          if (getFrameSizing(frameNode) !== 'hug') continue;
          const position = getFrameAbsolutePosition(
            projectedGestureNodes,
            frameId,
          );
          if (!frameNode || !position) continue;
          const leaving = leavingByFrame.get(frameId);
          const entering = enteringByFrame.get(frameId);
          const size = getNodeSize(frameNode);
          const role: FrameFitPreviewRole =
            leaving && !entering ? 'source' : 'target';
          previews.push({
            frameId,
            position,
            width: size.width,
            height: size.height,
            role,
          });
        }

        // ── Structured-frame drop indicator ──────────────────────────
        // Mirror what NODE_DRAG_STOP will decide, live: if the primary
        // dragged node is hovering a column / row / grid frame, show
        // where it would land. Free frames have no tracks → no
        // indicator.
        if (targetFrameId && targetFrame && gridCfg) {
          const frameAbs =
            getFrameAbsolutePosition(projectedGestureNodes, targetFrameId) ??
            projectedTargetFrameAbs;
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
            projectedGestureNodes,
            draggedNode.id,
          );
          const projectedDragged = projectedGestureNodes.find(
            (node) => node.id === draggedNode.id,
          );
          const draggedSize = projectedDragged
            ? getNodeSize(projectedDragged)
            : liveDragged
              ? getNodeSize(liveDragged)
              : null;
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

          const draggedNodeIds = [
            draggedNode.id,
            ...draggedNodes
              .filter((node) => node.id !== draggedNode.id)
              .map((node) => node.id),
          ];
          const gridGroup = leavingByFrame.has(targetFrameId)
            ? null
            : getGridDragGroup(nodes, targetFrameId, draggedNodeIds);
          const lastPreview =
            useGesturePreviewStore.getState().structuredDropPreview;
          const previousDrop =
            lastPreview?.draggedNodeIds?.join(',') === draggedNodeIds.join(',')
              ? lastPreview
              : null;
          const masonry: StructuredDropPreview['masonry'] = framePoint
            ? gridCfg.axis === 'grid'
              ? resolveGridDrop(
                  projectedGestureNodes,
                  targetFrameId,
                  framePoint,
                  {
                    edges,
                    zoom: get().rfInstance?.getZoom() ?? 1,
                    allowInsert:
                      (draggedNodes.length === 1 || !!gridGroup) &&
                      !!pointerFlow,
                    insertAxis: gridGroup ? 'row' : undefined,
                    previous:
                      previousDrop?.frameId === targetFrameId
                        ? previousDrop.masonry
                        : undefined,
                  },
                )
              : resolveMasonryDrop(
                  projectedGestureNodes,
                  targetFrameId,
                  gridCfg.axis,
                  framePoint,
                  {
                    edges,
                    zoom: get().rfInstance?.getZoom() ?? 1,
                    allowInsert: draggedNodes.length === 1 && !!pointerFlow,
                    previous:
                      previousDrop?.frameId === targetFrameId
                        ? previousDrop.masonry?.target
                        : undefined,
                  },
                )
            : undefined;
          const rowTarget = masonry?.rowTarget;
          const count = resolveFrameTrackCount(
            projectedGestureNodes,
            targetFrameId,
          );
          const requests =
            gridGroup && masonry && rowTarget
              ? gridDragRequests(
                  gridGroup,
                  draggedNode.id,
                  { target: masonry.target, rowTarget },
                  count,
                )
              : undefined;
          const zone = framePoint
            ? describeStructuredDropZone(
                projectedGestureNodes,
                targetFrameId,
                framePoint,
                gridCfg.axis,
                count,
                draggedRect,
                { edges, target: masonry?.target, rowTarget, requests },
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
              nodeId: draggedNode.id,
              draggedNodeIds,
              frameId: targetFrameId,
              kind: zone.kind,
              x: frameAbs.x + zone.x,
              y: frameAbs.y + zone.y,
              width: zone.width,
              height: zone.height,
              placements: zone.placements?.map(toAbsoluteRect),
              ...(masonry
                ? {
                    masonry: {
                      target: masonry.target,
                      ...(rowTarget ? { rowTarget } : {}),
                      gap: masonry.gap ? toAbsoluteRect(masonry.gap) : null,
                    },
                  }
                : {}),
              context: {
                ...zone.context,
                tracks: zone.context.tracks.map(toAbsoluteRect),
                rows: zone.context.rows.map(toAbsoluteRect),
              },
            });
            if (!masonry?.gap && getFrameSizing(targetFrame) === 'hug') {
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
            }
            if (!masonry?.gap) {
              projectedGestureNodes = projectStructuredTargetGeometry({
                nodes: projectedGestureNodes,
                targetFrameId,
                zone,
                edges,
              });
            }
            publishGeometryProjection(projectedGestureNodes);
            publishFrameIntentPreviews(projectedGestureNodes);
            // Solver owns the slot here → suppress free-alignment guides.
            setSnapStructuredSuppressed(true);
          } else {
            useGesturePreviewStore.getState().clearStructuredDropPreview();
            setSnapStructuredSuppressed(false);
            publishGeometryProjection(projectedGestureNodes);
            publishFrameIntentPreviews(projectedGestureNodes);
          }
        } else {
          useGesturePreviewStore.getState().clearStructuredDropPreview();
          setSnapStructuredSuppressed(false);
          publishGeometryProjection(projectedGestureNodes);
          publishFrameIntentPreviews(projectedGestureNodes);
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
      const lastDrop = useGesturePreviewStore.getState().structuredDropPreview;
      useGesturePreviewStore.getState().clearFrameFitPreview();
      useGesturePreviewStore.getState().clearStructuredDropPreview();
      // Withdraw the peer slide-aside. Purely visual — the nodes never
      // moved — so the resolver below already classifies the release
      // against the same geometry the preview was derived from, and the
      // peers snap to their committed positions in the same tick the
      // authoritative `SET_NODE_GEOMETRY` lands.
      useGesturePreviewStore.getState().clearNodeGeometryPreviews();

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
      const allowNestedFrameEntry =
        consumeLastNestedFrameEntryAllowed() || isNestedFrameEntryAllowed();

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
      // Touch end uses changedTouches because touches is empty at release.
      const pointerScreen = getDragPointerPosition(_event);
      const pointerFlowPosition = pointerScreen
        ? get().rfInstance?.screenToFlowPosition(pointerScreen)
        : undefined;

      get().dispatchUiIntent({
        type: 'NODE_DRAG_STOP',
        draggedNodeIds: [
          _node.id,
          ...draggedNodes.filter((n) => n.id !== _node.id).map((n) => n.id),
        ],
        pointerFlowPosition,
        zoom: get().rfInstance?.getZoom() ?? 1,
        masonryDrop:
          lastDrop?.masonry &&
          ((lastDrop.masonry.target.kind !== 'insert-new' &&
            lastDrop.masonry.rowTarget?.kind !== 'insert-new') ||
            (pointerFlowPosition &&
              lastDrop.masonry.gap &&
              isPointInTrackGap(lastDrop.masonry.gap, pointerFlowPosition)))
            ? {
                nodeId: lastDrop.nodeId,
                frameId: lastDrop.frameId,
                target: lastDrop.masonry.target,
                rowTarget: lastDrop.masonry.rowTarget,
                draggedNodeIds: lastDrop.draggedNodeIds,
              }
            : undefined,
        bypassReparent,
        allowNestedFrameEntry,
        cachedDecisions,
      });

      // A plain free-node move yields no command: the final position is
      // already in the store from the live `_setStateNoAutosave` ticks. The
      // drop is then sent as the `SET_NODE_GEOMETRY` those ticks amount to.
      // When the resolver did emit commands, `executeCommands` has already
      // sent the ticks ahead of them and this finds nothing left.
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
          // Free moves may apply no command, bypassing executeCommands and
          // its routing effects. Reconcile against final geometry before the
          // drop is sent; frames can move un-dragged edge endpoints
          // and unconnected nodes can change another edge's obstacle path.
          const edges = get().edges;
          const routed = applySharedPostEffects({
            nodes: liveNodes,
            edges,
            requiresEdgeReroute: true,
          });
          if (routed.edges !== edges) {
            get()._setStateNoAutosave({ edges: routed.edges });
          }
          submitGestureTicks(edges);
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
      endSyncGesture();
    },

    cancelActiveNodeDrag: () => {
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
        _dragPreviewRafId = null;
      }
      const preview = useGesturePreviewStore.getState();
      preview.clearFrameFitPreview();
      preview.clearStructuredDropPreview();
      preview.clearNodeGeometryPreviews();

      const startPositions = _dragStartPositions;
      _dragStartPositions = null;
      if (startPositions) {
        // Where the node was when the drag began — or where another page
        // has put it since, which the drag kept back: its position and,
        // with it, the parent that position is relative to.
        const baseline = new Map(
          (syncGestureBaseline ?? []).map((node) => [node.id, node]),
        );
        let reparented = false;
        const nodes = get().nodes.map((node) => {
          const start = startPositions.get(node.id);
          if (!start) return node;
          const server = baseline.get(node.id);
          if (!server) {
            return {
              ...node,
              position: { x: start.x, y: start.y },
              dragging: false,
            };
          }
          const placed = applyUnits(
            node as unknown as UnitNode,
            server as unknown as UnitNode,
            PLACEMENT_UNITS,
          ) as unknown as Node;
          reparented ||= placed.parentId !== node.parentId;
          return {
            ...placed,
            position: { x: server.position.x, y: server.position.y },
            dragging: false,
          };
        });
        get()._setStateNoAutosave({
          nodes: reparented
            ? (normalizeTreeOrder(nodes as NestableNode[]) as Node[])
            : nodes,
        });
      }

      endSnapSession();
      endSyncGesture();
      canvasHistoryManager.rollbackGestureSnapshot();
      set({
        canUndo: canvasHistoryManager.canUndo,
        canRedo: canvasHistoryManager.canRedo,
      });
      resumeHeightCommits('node-drag');
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
      useGesturePreviewStore.getState().clearNodeGeometryPreviews();
      _dragStartPositions = null;
      endSyncGesture();
      endSnapSession();
    },

    updateResizePreview: resizePreviewController.updateResizePreview,

    endResizePreview: resizePreviewController.endResizePreview,

    onNodesChange: (changes) => {
      // Only process RF-internal change types (position, selection, dimensions).
      // Deletions must go through dispatch({ type: 'DELETE_NODES' }).
      // Additions must go through dispatch({ type: 'ADD_NODES' }).
      const currentById = new Map(get().nodes.map((node) => [node.id, node]));
      const internalChanges = changes.filter((change) => {
        if (change.type === 'remove' || change.type === 'add') return false;
        if (
          change.type !== 'dimensions' ||
          change.resizing !== undefined ||
          isSnapSessionActive()
        )
          return true;
        const node = currentById.get(change.id);
        return (
          node?.type !== 'frame' ||
          typeof node.style?.width !== 'number' ||
          typeof node.style?.height !== 'number' ||
          node.measured?.width !== node.style.width ||
          node.measured?.height !== node.style.height
        );
      });
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

      // Frame boxes are engine-owned, not content measurements. During CSS
      // size transitions (notably undo/redo), ResizeObserver reports interim
      // pixels that must not become inputs to ancestor layout or the next drag.
      const measuredFrameIds = new Set(
        snappedChanges.flatMap((change) =>
          change.type === 'dimensions' && !change.resizing ? [change.id] : [],
        ),
      );
      nextNodes = nextNodes.map((node) => {
        if (node.type !== 'frame' || !measuredFrameIds.has(node.id))
          return node;
        const { width, height } = node.style ?? {};
        if (typeof width !== 'number' || typeof height !== 'number')
          return node;
        return { ...node, measured: { ...node.measured, width, height } };
      });

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
        const resizingNode = nextNodes.find(
          (node) => node.id === resizeCtx.nodeId,
        );
        const parentOrigin = resizingNode?.parentId
          ? getFrameAbsolutePosition(nextNodes, resizingNode.parentId)
          : undefined;
        const localPosition = {
          x:
            snappedRect.local.x +
            resizeCtx.parentOffset.x -
            (parentOrigin?.x ?? 0),
          y:
            snappedRect.local.y +
            resizeCtx.parentOffset.y -
            (parentOrigin?.y ?? 0),
        };
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
        nextNodes = nextNodes.map((n) => {
          if (n.id !== resizeCtx.nodeId) return n;
          const contentOwnsHeight =
            (resizeCtx.mode === 'width' || resizeCtx.mode === 'scale') &&
            isAlwaysAutoHeightNodeType(n.type ?? '');
          const { height: _staleHeight, ...styleWithoutHeight } = n.style ?? {};
          return {
            ...n,
            position: localPosition,
            style: {
              ...(contentOwnsHeight ? styleWithoutHeight : n.style),
              width: snappedRect.size.width,
              ...(!contentOwnsHeight && { height: snappedRect.size.height }),
            },
            // `getNodeSize` resolves `measured` before `style`, and the
            // ResizeObserver only refreshes it a frame or two after the DOM
            // has already resized. Keep authored axes in lockstep, but let
            // Text/Question report their reflowed renderer-owned height.
            measured: {
              ...n.measured,
              width: snappedRect.size.width,
              ...(!contentOwnsHeight && { height: snappedRect.size.height }),
            },
          };
        });
      }

      // ── Frame relayout on measured-size changes ────────────────────
      // Measurements are already available: publish them with the final
      // Frame layout, rather than painting stale positions for two more frames.
      let frameGeometryChanged = false;
      if (!resizeCtx && !isSnapSessionActive()) {
        let framesToRelayout: Set<string> | undefined;
        for (const c of sanitized) {
          if (c.type !== 'dimensions') continue;
          if (c.resizing) continue; // live tick of a resize session
          const child = nextNodes.find((n) => n.id === c.id);
          if (child?.type === 'frame') continue;
          if (!child?.parentId) continue;
          const previous = currentById.get(child.id)?.measured;
          if (
            c.dimensions &&
            previous?.width === c.dimensions.width &&
            previous?.height === c.dimensions.height
          )
            continue;
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
          const projected = projectAffectedFrameGeometry(
            nextNodes,
            framesToRelayout,
            get().edges,
          ).nodes;
          frameGeometryChanged = projected !== nextNodes;
          nextNodes = projected;
        }
      }

      // Frame geometry derived from what the renderer measured is this
      // page's own layout; RF-only gesture ticks stay transient too. What
      // reaches the server is the measured box itself (below), around which
      // it lays the same Frames out.
      const beforeMeasure = { nodes: get().nodes, edges: get().edges };
      if (frameGeometryChanged) set({ nodes: nextNodes });
      else get()._setStateNoAutosave({ nodes: nextNodes });
      if (!resizeCtx && !isSnapSessionActive()) {
        const measuredIds = sanitized.flatMap((change) =>
          change.type === 'dimensions' && !change.resizing && change.dimensions
            ? [change.id]
            : [],
        );
        if (measuredIds.length > 0) {
          reportMeasuredSizes(
            measuredIds,
            frameGeometryChanged
              ? {
                  prev: beforeMeasure,
                  next: { nodes: get().nodes, edges: get().edges },
                }
              : undefined,
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
        // commands above). Selection is transient UI state.
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

    deleteNodes: (nodeIds, edgeIds) => {
      get().dispatchUiIntent({ type: 'DELETE_NODES', nodeIds, edgeIds });
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
      const { nodes, canvasId } = get();
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
      void pageLifecycle
        .run('updating', async () => {
          const measurements = await measureMissingAutoHeights(
            mode === 'auto' ? items.map((item) => item.nodeId) : [],
            get,
          );

          // Never replay captured geometry after an async measurement if a
          // resize or navigation superseded the toggle. The measurement key
          // also guards APPLY_MEASURED_HEIGHT, but cannot undo a stale resize.
          const live = get();
          if (live.canvasId !== canvasId) return;
          const currentItems = items.filter((item) => {
            const before = nodes.find((node) => node.id === item.nodeId);
            const after = live.nodes.find((node) => node.id === item.nodeId);
            return (
              before &&
              after?.type === 'note' &&
              autoHeightContentWidth(before) === autoHeightContentWidth(after)
            );
          });
          if (currentItems.length === 0) return;

          // SET_NODE_GEOMETRY uses snapshot:'caller'; open a gesture so the
          // batch is captured as one undo entry without warnings. The
          // measurement rides the same batch, so undo restores the pinned
          // height in one step.
          get().beginGesture('SET_NODE_GEOMETRY');
          get().executeCommands(
            [
              {
                type: 'SET_NODE_GEOMETRY',
                items: currentItems.map((item) => ({
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
        })
        .catch((error: unknown) => {
          console.error('[canvas] Could not update Note sizing:', error);
          toast(error instanceof Error ? error.message : String(error), {
            tone: 'danger',
          });
        });
    },

    applyMeasuredHeights: (items) => {
      if (items.length === 0) return;
      // A measurement is derived, not authored: it is applied here at once
      // and reported to the server separately (see `reportMeasuredHeights`).
      const prev = { nodes: get().nodes, edges: get().edges };
      get().executeCommands(
        [{ type: 'APPLY_MEASURED_HEIGHT', items }],
        'system',
      );
      const next = { nodes: get().nodes, edges: get().edges };
      if (next.nodes === prev.nodes) return;
      reportMeasuredHeights(
        items.map((item) => item.nodeId),
        { prev, next },
      );
    },

    updateNodeData: (nodeId, patch) => {
      get().dispatchUiIntent({ type: 'UPDATE_NODE_DATA', nodeId, patch });
    },

    patchNodeSilent: (nodeId, patch) => {
      if (!nodeId) return;
      const before = { nodes: get().nodes, edges: get().edges };
      const nodes = before.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        return {
          ...n,
          data: {
            ...(n.data ?? {}),
            ...patch,
          },
        };
      });
      // During a pointer gesture the closing batch sends the patch along
      // with everything else the gesture changed.
      if (syncGestureBaseline !== null && get().canvasId) {
        set({ nodes });
        return;
      }
      // Structure fields go to the server as the commands that reproduce
      // them. Content fields have their own save, and read-model hints are
      // only shown: a patch that carries nothing else sends nothing.
      const commands = get().canvasId
        ? commandsReproducing(get().canvasId, before, {
            nodes,
            edges: before.edges,
          })
        : null;
      set({ nodes });
      if (!commands || commands.length === 0) return;
      browserSync.submit({
        canvasId: get().canvasId,
        commands,
        prev: syncView(before.nodes, before.edges),
        next: syncView(get().nodes, get().edges),
      });
    },

    selectNodes: (ids, multiSelect = false) => {
      const state = get();
      const workspace = useWorkspaceStore.getState();
      if (state.canvasId === workspace.worldCanvasId) {
        const visible = new Set(
          state.nodes
            .filter((node) =>
              isVisibleWorldNode(
                node,
                state.canvasId,
                workspace.worldCanvasId,
                workspace.spaceSummaries,
              ),
            )
            .map((node) => node.id),
        );
        ids = ids.filter((id) => visible.has(id));
      }
      get().dispatchUiIntent({
        type: 'SELECT_NODES',
        nodeIds: ids,
        mode: multiSelect ? 'toggle' : 'replace',
      });
    },

    reorderNodes: (
      activeId: string | string[],
      overId: string,
      position?: 'before' | 'after',
    ) => {
      get().dispatchUiIntent({
        type: 'REORDER_NODES_RELATIVE',
        nodeIds: typeof activeId === 'string' ? [activeId] : activeId,
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
      if (selectIsNodeOpen(usePreviewWorkspaceStore.getState(), nodeId)) return;
      const { ingestionByNodeId } = get();
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
        // What the gesture's live ticks change is sent by its closing batch.
        syncGestureBaseline = nodes;
      }
    },

    beginNodeDataGesture: () => {
      // Bracket a burst of live `updateNodeData` ticks into ONE undo entry.
      // `MERGE_NODE_DATA` self-snapshots ('yes') and so never consumes the
      // flag, hence the explicit `endNodeDataGesture` counterpart below.
      const { nodes, edges } = get();
      armGestureSnapshot(nodes, edges);
      // Every tick of this burst is its own command batch.
      endSyncGesture();
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
        type: 'MOVE_NODES_INTO_FRAME',
        nodeIds: Array.isArray(nodeId) ? nodeId : [nodeId],
        frameId,
        reorderTarget,
      });
    },

    moveNodeOutOfFrame: (nodeId, reorderTarget) => {
      get().dispatchUiIntent({
        type: 'MOVE_NODES_OUT_OF_FRAME',
        nodeIds: Array.isArray(nodeId) ? nodeId : [nodeId],
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

      for (const id of includePdfNotes(nodes, selectedIds)) selectedIds.add(id);
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
      const topology = stripLegacyPortalTopology(
        clipboardNodes,
        clipboardEdges ?? [],
      );
      clipboardNodes = topology.nodes;
      clipboardEdges = topology.edges;
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
          (data.bindingState === 'bound' ||
            status === 'done' ||
            status === 'error' ||
            status === 'running');
        if (hasConversation) {
          const dstThreadId = createId('thread');
          forkTasks.push({ srcThreadId: threadId, dstThreadId });
          prepared.push({
            ...node,
            data: {
              ...data,
              threadId: dstThreadId,
              status: undefined,
              errorMessage: undefined,
              bindingState: undefined,
              invocationToken: undefined,
              viewed: undefined,
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

        for (const t of forkTasks) {
          const fork = agentApi
            .forkThread(
              t.srcThreadId,
              t.dstThreadId,
              sourceCanvasId,
              dstCanvasId,
            )
            .catch((err) => {
              console.warn('[paste] Failed to fork question conversation', err);
              toast('Failed to copy a conversation', { tone: 'danger' });
              throw err;
            })
            .finally(() => clearPending(t.dstThreadId));
          questionForks.set(`${dstCanvasId}\0${t.dstThreadId}`, fork);
          void fork.catch(() => undefined);
        }
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
          return markdownArtifactFields({
            ...data,
            type: node.type ?? data.type,
          }).some((field) => {
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
        runForks();
        dispatch(clipboardNodes);
        return;
      }

      void pageLifecycle
        .run('importing', async () => {
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
              const data = {
                ...((node.data ?? {}) as Record<string, unknown>),
              };
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

              for (const field of markdownArtifactFields({
                ...data,
                type: node.type ?? data.type,
              })) {
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
          runForks();
          dispatch(remapped);
        })
        .catch((error: unknown) => {
          console.error('[paste] Could not finish cross-Space paste:', error);
          toast(error instanceof Error ? error.message : String(error), {
            tone: 'danger',
          });
        });
    },

    canUndo: false,
    canRedo: false,

    undo: async () => {
      restoreFromHistory('undo');
    },

    redo: async () => {
      restoreFromHistory('redo');
    },
  })),
);

// Observe topology rather than individual entry points, including reused tabs
// in another split group. Still-visible editors and ordinary focus changes stay open.
usePreviewWorkspaceStore.subscribe((next, previous) => {
  if (next.workspace !== previous.workspace) {
    settleDepartingPreviewEditors(previous.workspace, next.workspace);
  }
});
usePanelStore.subscribe((next, previous) => {
  if (next.isRightCollapsed && !previous.isRightCollapsed) {
    settleDepartingPreviewEditors(
      usePreviewWorkspaceStore.getState().workspace,
    );
  }
});

export default useCanvasStore;

/** Local mode retains its one-owner behavior; unknown Bubble access stays read-only. */
export function selectCanWriteCanvas(
  state: Pick<RFState, 'canvasId' | 'canvasAccess'>,
): boolean {
  return state.canvasAccess?.canvasId === state.canvasId
    ? state.canvasAccess.write
    : useIdentityStore.getState().identity?.provider !== 'bubble';
}

export function selectCanManageCanvas(
  state: Pick<RFState, 'canvasId' | 'canvasAccess'>,
): boolean {
  return state.canvasAccess?.canvasId === state.canvasId
    ? state.canvasAccess.manage
    : useIdentityStore.getState().identity?.provider !== 'bubble';
}
