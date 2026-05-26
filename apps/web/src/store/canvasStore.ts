import { ARTIFACT_DATA_FIELDS } from '@sediment/shared';
import {
  COMMAND_META,
  applySharedPostEffectsFromWriteResult,
  executeCanvasCommands,
  computeFrameFit,
  getAbsolutePosition as getFrameAbsolutePosition,
  wouldUnframe,
  wouldAutoFrame,
  getNodeSize,
  type AlignDirection,
  type FrameFitResult,
  type NestableNode,
} from '@sediment/shared/canvas-engine';
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

import { runWebPostEffects } from '@/handler/canvasCommand/postEffects.web';
import {
  resolveUiIntent,
  type AddNodeInput,
  type CanvasUiIntent,
  type UiResolverState,
} from '@/handler/canvasCommand/uiIntent';
import { pushAction } from '@/handler/canvasCommand/utils';
import {
  applySnap,
  beginSnapSession,
  endSnapSession,
  getResizeContext,
  getResizeSnappedRect,
  isSnapSessionActive,
  isSnapSessionDragEndCommit,
  isSnapSessionResizeEndCommit,
} from '@/handler/snap/snapSession';

import { canvasHistoryManager } from './canvasHistoryManager';
import { createCanvasEventBuffer } from './canvasStore/save/eventBuffer';
import { NODE_CONTENT_KEYS } from './canvasStore/save/nodeContentFields';
import { createNodeContentQueue } from './canvasStore/save/nodeContentQueue';
import { createPreprocessQueue } from './canvasStore/save/preprocessQueue';
import { shouldScheduleStructureSave } from './canvasStore/save/structureDirtyDetector';
import { createStructureScheduler } from './canvasStore/save/structureScheduler';
import { createUnloadFlush } from './canvasStore/save/unloadFlush';
import { useGesturePreviewStore } from './gesturePreviewStore';
import { useToolStore } from './toolStore';
import { getCanvas, putCanvas } from '../api';
import { cloneArtifactToCanvas } from '../api/artifact';
import { CanvasConflictError } from '../api/canvas';
import { toast } from '../components/Common/Toast';
import { seedNoteFixedHeight } from '../components/Nodes/note/autoHeight';
import { getNoteFixedHeight } from '../components/Nodes/note/heightMemory';
import { copyToClipboard } from '../utils/io/clipboard';

import type { NodeIngestionInfo } from '@/handler/canvasCommand/preprocess';
import type {
  AgentChatContext,
  CanvasCommand,
  CanvasCommandType,
  CanvasExecution,
  CanvasExecutionSource,
  CanvasNodeType,
  CanvasViewport,
  IntentContext,
  RecentAction,
  WireCanvasNode,
  WireSelectionNode,
} from '@sediment/shared';

const AUTOSAVE_DEBOUNCE_MS = 1000;
const PREPROCESS_DEBOUNCE_MS = 1000;
const NODE_CONTENT_DEBOUNCE_MS = 500;

// ─── Viewport sessionStorage ──────────────────────────────────────────────
//
// Pan + zoom is a per-tab view preference, not canvas data: persisting it
// server-side forced every tab/device on the same canvas to share one
// view and turned each `onMoveEnd` into a structure PUT that bumped
// `version` (and could collide with the agent). We store it in
// `sessionStorage` keyed by canvasId so each tab keeps its own scroll
// position across refreshes without touching the server.

const viewportStorageKey = (canvasId: string) =>
  `sediment.viewport.${canvasId}`;

function readViewportFromSession(canvasId: string): CanvasViewport | null {
  if (!canvasId) return null;
  try {
    const raw = sessionStorage.getItem(viewportStorageKey(canvasId));
    if (!raw) return null;
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
    // Private mode / quota / corrupt entry — fall back to fitView.
  }
  return null;
}

function writeViewportToSession(
  canvasId: string,
  viewport: CanvasViewport,
): void {
  if (!canvasId) return;
  try {
    sessionStorage.setItem(
      viewportStorageKey(canvasId),
      JSON.stringify(viewport),
    );
  } catch {
    // Ignore: viewport is a UX nicety, never block the user on it.
  }
}

// ─── Per-node content flush ────────────────────────────────────────────────
//
// Markdown sidecar persistence (debounced per-node PUT + serialized
// in-flight chain) lives in `./canvasStore/save/nodeContentQueue.ts`.
// The factory call is in the module-scope singletons section below;
// `stripNodeContentForStructurePut` is the only piece that stays here
// because it's only used inside the `saveCanvas` action body.

/**
 * Remove every {@link NODE_CONTENT_KEYS} member from each node's
 * `data` before sending a structure PUT — those fields live in the
 * `.md` sidecar now and are persisted exclusively via the per-node
 * content endpoint. Structure-only fields (`id`, `type`, geometry,
 * `parentId`, custom data) are preserved verbatim. Returns the
 * original `node` reference when nothing was stripped so the array
 * stays identity-stable for downstream diffing.
 */
function stripNodeContentForStructurePut(nodes: readonly Node[]): Node[] {
  return nodes.map((node) => {
    const data = node.data;
    if (!data) return node;
    let mutated = false;
    const slim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (NODE_CONTENT_KEYS.has(k)) {
        mutated = true;
        continue;
      }
      slim[k] = v;
    }
    return mutated ? { ...node, data: slim } : node;
  });
}

// ── Spatial data ──────────────────────────────────────────────
//
// The frontend no longer normalises spatial data for the LLM.
// `/api/agent` resolves the anchor node's neighbourhood server-side
// from `canvas.json` (see `apps/server/src/modules/agent/
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
  isLoading: boolean;
  canvasNotFound: boolean;
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

  expandedNodeId: string | null;
  expandMode: 'replace' | 'split';
  openExpanded: (nodeId: string) => void;
  closeExpanded: () => void;
  setExpandMode: (mode: 'replace' | 'split') => void;

  collapsedFrameIds: Set<string>;
  toggleFrameCollapse: (frameId: string) => void;
  isFrameCollapsed: (frameId: string) => boolean;

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onNodeDragStart: OnNodeDrag;
  onNodeDrag: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;
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
  deleteNodes: (nodeIds: string[]) => void;
  disconnectEdges: (edgeIds: string[]) => void;
  setNodeGeometry: (
    items: Array<{
      nodeId: string;
      // `height` is optional: pass undefined to clear an explicit height
      // and revert the node to content-driven auto-sizing.
      size?: { width: number; height?: number };
      position?: { x: number; y: number };
    }>,
  ) => void;
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
  /** Take a pre-resize snapshot so the final SET_NODE_GEOMETRY can be undone. */
  onNodeResizeStart: () => void;
  rfInstance: ReactFlowInstance | null;
  setRfInstance: (instance: ReactFlowInstance | null) => void;

  /**
   * Current pan + zoom of the React Flow viewport.
   *
   * `null` means "no saved viewport yet" — on initial load that triggers a
   * one-shot `fitView`. After the user pans or zooms, `onMoveEnd` writes
   * the new viewport here through {@link setViewport}, which also
   * mirrors it into `sessionStorage` (per-tab, per-canvas) so a refresh
   * lands back at the same view without going through the server.
   */
  viewport: CanvasViewport | null;
  /**
   * Record a new viewport. Called from `<ReactFlow onMoveEnd>` after the
   * user finishes panning/zooming. Writes to `sessionStorage` directly;
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

  /** Align selected nodes along an axis. */
  alignSelectedNodes: (direction: AlignDirection) => void;
  /** Spread apart overlapping selected nodes (frame children stay in their frame). */
  spreadSelectedNodes: () => void;

  /** Auto-layout: whether new nodes are automatically placed. */
  autoLayoutEnabled: boolean;
  toggleAutoLayout: () => void;

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

  loadCanvas: (canvasId?: string) => Promise<void>;
  switchCanvas: (canvasId: string) => Promise<void>;
  /**
   * Persist the canvas structure (geometry, parenthood, edges).
   * Pass `{ keepalive: true }` from the `beforeunload` flush so the
   * request survives the page close. Per-node content (markdown,
   * label, src, summary, …) is stripped before sending — it rides
   * the per-node content PUT, not this one. Viewport is intentionally
   * excluded: it lives in `sessionStorage` per tab.
   */
  saveCanvas: (options?: { keepalive?: boolean }) => Promise<void>;

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

  actionHistory: RecentAction[];
  /** @internal Execute a batch of shared CanvasCommands. Do not call from outside the store. */
  executeCommands: (
    commands: CanvasCommand[],
    source?: CanvasExecutionSource,
  ) => void;
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
 * Module-scoped per-node preprocessing queue. Each store mutation
 * that affects a markdown-backed node schedules a debounced
 * `preprocessNode` POST through this queue.
 */
const preprocessQueue = createPreprocessQueue({
  delayMs: PREPROCESS_DEBOUNCE_MS,
  getState: () => useCanvasStore.getState(),
});

/**
 * Module-scoped per-node markdown sidecar save queue. Coalesces rapid
 * editor edits into one PUT per node and serializes in-flight writes
 * so the server never sees two PUTs for the same node concurrently.
 */
const nodeContentQueue = createNodeContentQueue({
  delayMs: NODE_CONTENT_DEBOUNCE_MS,
  getState: () => useCanvasStore.getState(),
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
        // content edits do NOT bump the canvas `version` — they ride
        // the per-node content PUT instead. See
        // `./canvasStore/save/structureDirtyDetector.ts`.
        if (shouldScheduleStructureSave(prev, next)) {
          structureScheduler.schedule();
        }
        // --- Per-node content diff ---
        // Independent of the structure autosave so editor edits flush
        // on their own (faster) debounce and never participate in the
        // canvas-level `version` counter.
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

// Sibling rAF handle for `updateResizePreview`. Same rationale as the
// drag-time handle: NodeResizer's onResize callback may fire well
// above 60 Hz on high-refresh displays, and computeFrameFit walks
// every node + descendant of the parent frame. Coalescing per-frame
// calls into a single rAF callback caps the work at one fit-pass per
// paint without dropping any user-visible state — the rAF callback
// re-reads the latest store snapshot when it actually runs.
let _resizePreviewRafId: number | null = null;

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
    isLoading: false,
    canvasNotFound: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,

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

    expandedNodeId: null,
    expandMode: 'split',
    openExpanded: (nodeId) =>
      get().dispatchUiIntent({ type: 'EXPAND_NODE', nodeId }),
    closeExpanded: () => set({ expandedNodeId: null }),
    setExpandMode: (mode) => set({ expandMode: mode }),

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

    // -----------------------------------------------------------------------
    // Action history & agent context
    // -----------------------------------------------------------------------

    actionHistory: [],

    // --- Internal: not exposed in the public CanvasStore interface ---

    /** Execute a batch of shared CanvasCommands. Source defaults to 'ui'. */
    executeCommands: (commands, source) => {
      const resolvedSource = source ?? 'ui';
      const execution: CanvasExecution = {
        source: resolvedSource,
        commands,
      };
      const state = {
        nodes: get().nodes,
        edges: get().edges,
        canvasId: get().canvasId,
        autoLayoutEnabled: get().autoLayoutEnabled,
      };

      const { writeResult, commandResults, pendingEffects } =
        executeCanvasCommands(execution, state, {
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
      if (hasCallerSnapshot && resolvedSource !== 'agent') {
        if (!canvasHistoryManager.gestureSnapshotTaken) {
          console.warn(
            '[canvasStore] snapshot:"caller" command executed without beginGesture():',
            commands.map((c) => c.type).join(', '),
          );
        }
        canvasHistoryManager.consumeGestureSnapshot();
      }

      // Take undo snapshot if needed (before committing new state).
      if (writeResult.snapshotNeeded) {
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
        source: resolvedSource,
        canvasId: state.canvasId,
        getNodes: () => get().nodes,
        setNodes: (nodes) => set({ nodes }),
        triggerPreprocessing: preprocessQueue.schedule,
      });
    },

    /** Resolve a web-only UiIntent and execute the resulting commands. */
    dispatchUiIntent: (intent) => {
      const uiState: UiResolverState = {
        nodes: get().nodes,
        edges: get().edges,
        autoLayoutEnabled: get().autoLayoutEnabled,
      };
      const execution = resolveUiIntent(intent, uiState);
      if (execution.commands.length > 0) {
        get().executeCommands(execution.commands);
      }
      // Apply UI-only state mutations (e.g. expand-overlay toggle) that
      // bypass the command pipeline.
      if (execution.expandedNodeId !== undefined) {
        set({ expandedNodeId: execution.expandedNodeId });
      }
      // Push trace from intent resolution to action history.
      if (execution.trace.length > 0) {
        let history = get().actionHistory;
        for (const action of execution.trace) {
          history = pushAction(history, action);
        }
        set({ actionHistory: history });
        // Mirror the trace into the outgoing event buffer so the server
        // builds up a long-window action log alongside the short
        // in-memory ring buffer.
        canvasEvents.bufferMany(get().canvasId, execution.trace);
      }
    },

    getAgentChatContext: (): AgentChatContext => {
      const { nodes } = get();
      const buildSelectedDetail = makeBuildSelectedDetail(nodes);
      return {
        selectedNodes: nodes.filter((n) => n.selected).map(buildSelectedDetail),
      };
    },

    getIntentContext: (): IntentContext => {
      const { nodes, edges, actionHistory } = get();
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
        recentActions: actionHistory,
        selectedNodes: nodes.filter((n) => n.selected).map(buildSelectedDetail),
      };
    },

    loadCanvas: async (canvasId?: string) => {
      set({ isLoading: true, canvasNotFound: false, versionConflict: false });
      try {
        const targetId = canvasId ?? get().canvasId;
        if (canvasId) {
          set({ canvasId: targetId });
        }
        const response = await getCanvas(targetId);
        if (!response) {
          console.warn('Canvas not found:', targetId);
          canvasHistoryManager.clear();
          set({
            isLoading: false,
            canvasNotFound: true,
            ingestionByNodeId: {},
          });
          return;
        }

        const state = response.state as {
          nodes?: Node[];
          edges?: Edge[];
          // Legacy field: older canvases still carry a server-side
          // viewport. Used only as a one-shot fallback when this tab
          // has no sessionStorage entry yet; the next structure PUT
          // strips it from `canvas.json` for good.
          viewport?: CanvasViewport;
        };
        canvasHistoryManager.clear();

        const loadedNodes = state.nodes ?? [];
        // Prefer this tab's sessionStorage; fall back to whatever the
        // server still has from before viewport was moved client-side.
        // A corrupt entry on either side falls through to `null`, which
        // Canvas.tsx interprets as "do a one-shot fitView".
        const sessionViewport = readViewportFromSession(targetId);
        const legacyServerViewport =
          state.viewport &&
          Number.isFinite(state.viewport.x) &&
          Number.isFinite(state.viewport.y) &&
          Number.isFinite(state.viewport.zoom) &&
          state.viewport.zoom > 0
            ? state.viewport
            : null;
        const loadedViewport = sessionViewport ?? legacyServerViewport;
        set({
          nodes: loadedNodes,
          edges: state.edges ?? [],
          viewport: loadedViewport,
          canvasTitle: response.title || 'Untitled',
          version: response.version,
          isLoading: false,
          ingestionByNodeId: {},
        });

        // Backfill: any node with an empty label gets re-queued so the
        // server can regenerate one. The server's preprocessing
        // dispatcher decides per node profile whether there's any
        // actual work to do, so we don't filter by type here.
        for (const node of loadedNodes) {
          const data = node.data as Record<string, unknown> | undefined;
          const label = typeof data?.label === 'string' ? data.label : '';
          if (label.trim().length > 0) continue;
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

      // Flip into the loading state *before* awaiting anything so the
      // shell shows `LoadingState` on the very next render instead of
      // briefly painting the previous canvas while the structure save
      // flush resolves. `loadCanvas` below will set `isLoading: true`
      // again (idempotent) once it starts the actual fetch.
      set({
        isLoading: true,
        canvasNotFound: false,
        versionConflict: false,
      });

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
        actionHistory: [],
        collapsedFrameIds: new Set(),
        canvasNotFound: false,
        viewport: null,
      });
      useToolStore.getState().resetForCanvasSwitch();
      useGesturePreviewStore.getState().clearFrameFitPreview();
      canvasHistoryManager.clear();

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
      if (isSaving) {
        set({ pendingSave: true });
        return;
      }

      set({ isSaving: true });
      let saveSucceeded = false;
      try {
        const { nodes, edges, version, canvasId, canvasTitle } = get();
        // Strip every per-node content / label / src / summary / etc.
        // field from the body. Those live in `nodes/<safe(label)>.md`
        // now and ride the per-node content PUT, so the structure PUT
        // body shrinks to pure geometry + parenthood.
        // Viewport is intentionally omitted: it's a per-tab UX state
        // mirrored into `sessionStorage`, not canvas data.
        const slimNodes = stripNodeContentForStructurePut(nodes);
        const response = await putCanvas(
          canvasId,
          {
            version,
            title: canvasTitle || 'Untitled',
            state: { nodes: slimNodes, edges },
          },
          { keepalive: options?.keepalive },
        );
        set({ version: response.version });
        saveSucceeded = true;
      } catch (error) {
        if (error instanceof CanvasConflictError) {
          if (error.code === 'CANVAS_VERSION_CONFLICT') {
            // Server is ahead of us (another tab / device / agent wrote
            // first). Stop the autosave loop and surface a persistent
            // toast so the user knows their edits aren't being saved.
            // `loadCanvas` clears the flag once the client re-syncs.
            if (!get().versionConflict) {
              set({ versionConflict: true });
              toast(
                "This canvas was modified elsewhere. Your recent edits won't be saved — please refresh the page to continue.",
                { variant: 'error', duration: 0 },
              );
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
            set({ canvasTitle: previous });
            return false;
          }
          return true;
        } catch (err) {
          if (
            err instanceof CanvasConflictError &&
            err.code === 'CANVAS_TITLE_CONFLICT'
          ) {
            set({ canvasTitle: previous });
            const target = err.conflictWith ?? trimmed;
            window.alert(
              `Canvas name "${target}" is already in use. Please choose a different name.`,
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
        window.alert(
          `Name "${trimmed}" is already used by another node on this canvas. Please choose a different name.`,
        );
        return false;
      }
      // Optimistic patch — the per-node content middleware schedules a
      // debounced PUT. We force-flush immediately so the user sees the
      // 409 alert at rename time rather than ~500 ms later.
      get().updateNodeData(id, { label: trimmed, labelSource: 'user' });
      try {
        await nodeContentQueue.flushNow(canvasId, id);
        return true;
      } catch (err) {
        if (
          err instanceof CanvasConflictError &&
          err.code === 'NODE_LABEL_CONFLICT'
        ) {
          // Revert the optimistic label and surface the same alert UX
          // the legacy structure-PUT path used. `_setStateNoAutosave`
          // skips both autosave scheduling and the content-diff hook
          // so reverting doesn't schedule another doomed PUT.
          get()._setStateNoAutosave({
            nodes: get().nodes.map((n) => {
              if (n.id !== id) return n;
              // Strip the optimistic `labelSource: 'user'` first so we
              // can restore the original provenance exactly — including
              // the "was previously absent" case (omit the key entirely
              // rather than leaving a literal `undefined` value behind).
              const { labelSource: _omitted, ...rest } = (n.data ??
                {}) as Record<string, unknown>;
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
          window.alert(
            `Name "${taken}" is already used by another node on this canvas. Please choose a different name.`,
          );
          return false;
        }
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
    },

    onNodeDrag: (_event, draggedNode, draggedNodes) => {
      const { autoLayoutEnabled } = get();

      // Frame auto-resize preview only applies when auto-layout is enabled.
      if (!autoLayoutEnabled) {
        useGesturePreviewStore.getState().clearFrameFitPreview();
        return;
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
        const { nodes } = get();

        const liveNodes = nodes.map((n) => {
          if (n.id === draggedNode.id)
            return { ...n, position: draggedNode.position };
          const live = draggedNodes.find((d) => d.id === n.id);
          if (live) return { ...n, position: live.position };
          return n;
        }) as NestableNode[];

        // Collect frame IDs that need a preview, and which dragged children
        // would leave each frame (so we exclude them from the fit preview).
        const leavingByFrame = new Map<string, Set<string>>();
        const enteringByFrame = new Map<
          string,
          { x: number; y: number; width: number; height: number }[]
        >();
        const previewFrameIds = new Set<string>();

        for (const dn of draggedNodes) {
          const originalNode = nodes.find((n) => n.id === dn.id);
          if (!originalNode) continue;
          // If the node is currently in a frame, check whether it would unframe.
          if (originalNode.parentId) {
            const parentId = originalNode.parentId;
            previewFrameIds.add(parentId);

            if (wouldUnframe(liveNodes, dn.id, { epsilon: 0, margin: 10 })) {
              let leaving = leavingByFrame.get(parentId);
              if (!leaving) {
                leaving = new Set();
                leavingByFrame.set(parentId, leaving);
              }
              leaving.add(dn.id);
            }
          }

          // Check if the node would enter a different frame (both root and cross-frame).
          // Only show a preview when the 50% overlap threshold is already met so the
          // preview is always consistent with the actual drop behaviour.
          const targetFrameId = wouldAutoFrame(liveNodes, dn.id, {
            threshold: 0.5,
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
        }

        // Compute fit previews for all affected frames and show them all
        // simultaneously — e.g. source frame shrinking + target frame expanding.
        const previews: FrameFitResult[] = [];

        for (const frameId of previewFrameIds) {
          const leaving = leavingByFrame.get(frameId);
          const entering = enteringByFrame.get(frameId);
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

          previews.push({
            frameId,
            position: { x: absX, y: absY },
            width: fit.width,
            height: fit.height,
          });
        }

        useGesturePreviewStore.getState().setFrameFitPreviews(previews);
      });
    },

    onNodeDragStop: (_event, _node, draggedNodes) => {
      // Cancel any pending preview computation — the drag is over.
      if (_dragPreviewRafId !== null) {
        cancelAnimationFrame(_dragPreviewRafId);
        _dragPreviewRafId = null;
      }
      useGesturePreviewStore.getState().clearFrameFitPreview();

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
      if (_resizePreviewRafId !== null) {
        cancelAnimationFrame(_resizePreviewRafId);
        _resizePreviewRafId = null;
      }
      useGesturePreviewStore.getState().clearFrameFitPreview();
      endSnapSession();
    },

    updateResizePreview: (nodeId: string) => {
      const { autoLayoutEnabled } = get();
      if (!autoLayoutEnabled) return;

      // Coalesce all per-frame onResize ticks into one fit-pass per
      // paint. Cancelling the prior rAF handle (rather than gating on
      // "already scheduled") means we always recompute against the
      // *latest* store snapshot — RF may have committed several
      // intermediate dim changes via applyNodeChanges between this
      // call and the rAF tick. See the sibling drag preview block
      // above for the same pattern.
      if (_resizePreviewRafId !== null) {
        cancelAnimationFrame(_resizePreviewRafId);
      }
      _resizePreviewRafId = requestAnimationFrame(() => {
        _resizePreviewRafId = null;

        const { nodes } = get();
        const node = (nodes as NestableNode[]).find((n) => n.id === nodeId);
        if (!node?.parentId) return;
        const frame = (nodes as NestableNode[]).find(
          (n) => n.id === node.parentId,
        );
        if (!frame || frame.type !== 'frame') return;

        const fit = computeFrameFit(nodes as NestableNode[], node.parentId);
        if (!fit) return;

        let absX = fit.position.x;
        let absY = fit.position.y;
        if (frame.parentId) {
          const parentAbsPos = getFrameAbsolutePosition(
            nodes as NestableNode[],
            frame.parentId,
          );
          if (parentAbsPos) {
            absX += parentAbsPos.x;
            absY += parentAbsPos.y;
          }
        }

        useGesturePreviewStore.getState().setFrameFitPreviews([
          {
            frameId: node.parentId,
            position: { x: absX, y: absY },
            width: fit.width,
            height: fit.height,
          },
        ]);
      });
    },

    endResizePreview: () => {
      if (_resizePreviewRafId !== null) {
        cancelAnimationFrame(_resizePreviewRafId);
        _resizePreviewRafId = null;
      }
      useGesturePreviewStore.getState().clearFrameFitPreview();
    },

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

      // Drag-end detection: if this batch contained the final
      // `dragging:false` commit for any node the snap session is
      // tracking, the gesture is done — end it *here* (not in
      // `onNodeDragStop`). Doing the cleanup at the consumption site
      // means correctness no longer depends on whether React Flow
      // fires `onNodeDragStop` before or after this final change:
      // the snap above already ran with a valid index, and the
      // redundant `endSnapSession` in `onNodeDragStop` is just an
      // idempotent safety net.
      if (isSnapSessionDragEndCommit(sanitized)) endSnapSession();
      // Same pattern for resize-end (`resizing:false` dimension
      // change for the tracked node). `NodeWrapper.handleResizeEnd`
      // calls `endSnapSession` defensively as well; the second call
      // here is a no-op since the function is idempotent.
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
      });
    },

    rfInstance: null,
    setRfInstance: (instance) => set({ rfInstance: instance }),

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
      // Mirror into sessionStorage so a refresh restores this tab's
      // pan + zoom without a server round-trip.
      writeViewportToSession(get().canvasId, viewport);
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

    deleteNodes: (nodeIds) => {
      get().dispatchUiIntent({ type: 'DELETE_NODES', nodeIds });
    },

    disconnectEdges: (edgeIds) => {
      get().dispatchUiIntent({ type: 'DISCONNECT_EDGE', edgeIds });
    },

    setNodeGeometry: (items) => {
      get().dispatchUiIntent({ type: 'RESIZE_NODE', items });
    },

    setNoteHeightMode: (nodeIds, mode) => {
      if (nodeIds.length === 0) return;
      const idSet = new Set(nodeIds);
      const { nodes } = get();
      const items: Array<{
        nodeId: string;
        size: { width: number; height?: number };
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
            size: { width: w, height: undefined },
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
      // SET_NODE_GEOMETRY uses snapshot:'caller'; open a gesture so the
      // batch is captured as one undo entry without warnings.
      //
      // Fixed → auto clears the explicit height; the new content height
      // is only known after the next render cycle (editor reflow +
      // ReactFlow ResizeObserver). The `SET_NODE_GEOMETRY` handler
      // detects the cleared height and emits a `deferredFitFrameIds`
      // post-effect, which `runWebPostEffects` schedules for double-rAF
      // refit — so this action doesn't need its own timing dance.
      get().beginGesture('SET_NODE_GEOMETRY');
      get().setNodeGeometry(items);
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
      if (COMMAND_META[commandType].snapshot === 'caller') {
        const { nodes, edges } = get();
        canvasHistoryManager.takeSnapshot(nodes, edges);
        canvasHistoryManager.markGestureSnapshot();
      }
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

    autoLayoutEnabled: true,
    toggleAutoLayout: () => {
      set({ autoLayoutEnabled: !get().autoLayoutEnabled });
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

      // Write serialized node + edge data to system clipboard. Edges are
      // optional; older paste handlers that only know `__sediment_nodes__`
      // will still produce valid results (just without the connections).
      // `__sediment_canvas_id__` lets cross-canvas paste recover the
      // source canvas — required since `data.src` now stores only the
      // bare artifact key, not a full canvas-scoped URL.
      const payload = JSON.stringify({
        __sediment_nodes__: cloned,
        __sediment_edges__: clonedEdges,
        __sediment_canvas_id__: get().canvasId,
      });
      // `copyToClipboard` guards against `navigator.clipboard` being
      // undefined (insecure contexts, older browsers) and falls back to
      // a hidden textarea + `document.execCommand('copy')`.
      void copyToClipboard(payload);
    },

    pasteNodes: (flowPosition, clipboardNodes, clipboardEdges, srcCanvasId) => {
      const dstCanvasId = get().canvasId;
      if (!dstCanvasId || clipboardNodes.length === 0) return;

      // Same-canvas pastes leave artifact keys as-is (the artifact is
      // already owned by this canvas). Cross-canvas pastes clone the
      // underlying file so the destination canvas owns its own copy —
      // otherwise deleting the source canvas would orphan the pasted
      // node. The set of fields that may carry an artifact key is the
      // shared `ARTIFACT_DATA_FIELDS` constant.
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
          return ARTIFACT_DATA_FIELDS.some((field) => {
            const v = data[field];
            return typeof v === 'string' && v.length > 0;
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
        return;
      }

      void (async () => {
        const remapped = await Promise.all(
          clipboardNodes.map(async (node) => {
            const data = { ...((node.data ?? {}) as Record<string, unknown>) };
            let mutated = false;
            for (const field of ARTIFACT_DATA_FIELDS) {
              const value = data[field];
              if (typeof value !== 'string' || value.length === 0) continue;
              // Skip non-key strings (e.g. data URLs, http(s) URLs). The
              // server-side clone only handles canvas-owned files.
              if (value.startsWith('data:') || /^https?:/i.test(value))
                continue;
              if (value.includes('/')) continue;
              try {
                const newKey = await cloneArtifactToCanvas(
                  srcCanvasId,
                  value,
                  dstCanvasId,
                );
                if (newKey && newKey !== value) {
                  data[field] = newKey;
                  mutated = true;
                }
              } catch (err) {
                // Best effort — fall back to the original key. The new
                // node will render with the missing-file placeholder
                // (artifactMissing flag from the server) so the user can
                // still remove it.
                console.warn(
                  '[paste] Failed to clone artifact for cross-canvas paste',
                  err,
                );
              }
            }
            return mutated ? { ...node, data } : node;
          }),
        );
        dispatch(remapped);
      })();
    },

    canUndo: false,
    canRedo: false,

    undo: () => {
      const { nodes, edges, canvasId, actionHistory } = get();
      const snapshot = canvasHistoryManager.undo(nodes, edges);
      if (!snapshot) return;

      const action: RecentAction = { action: 'canvas_undone' };
      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        actionHistory: pushAction(actionHistory, action),
      });
      canvasEvents.buffer(canvasId, action);

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        preprocessQueue.schedule,
      );
    },

    redo: () => {
      const { nodes, edges, canvasId, actionHistory } = get();
      const snapshot = canvasHistoryManager.redo(nodes, edges);
      if (!snapshot) return;

      const action: RecentAction = { action: 'canvas_redone' };
      set({
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        actionHistory: pushAction(actionHistory, action),
      });
      canvasEvents.buffer(canvasId, action);

      canvasHistoryManager.syncServerAfterRestore(
        canvasId,
        nodes,
        snapshot.nodes,
        preprocessQueue.schedule,
      );
    },
  })),
);

export default useCanvasStore;
