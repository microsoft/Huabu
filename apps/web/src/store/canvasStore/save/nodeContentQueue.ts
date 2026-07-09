/**
 * Per-node content save queue.
 *
 * Edits to a node's markdown sidecar (content / label / src / summary /
 * keywords / provenance) are persisted via a dedicated per-node endpoint
 * (`PUT /api/canvas/:canvasId/nodes/:nodeId/content`) that never bumps
 * the canvas-level `version` counter. This decouples editor typing from
 * viewport drags / structure autosaves so the two flows can never
 * collide on the optimistic-concurrency check.
 *
 * Each node gets:
 *   - a debounced timer (via {@link createPerKeyDebouncer}) so trailing
 *     keystrokes coalesce into one PUT;
 *   - a serialized in-flight chain (this module's own `inflight` map)
 *     so a node can have at most one PUT in flight at a time. The next
 *     flush always reads the store at the moment it actually runs, so
 *     a queue of pending bodies never builds up — trailing edits
 *     collapse into a single later PUT.
 *
 * See `docs/node-content-api-split.md`.
 */

import {
  CanvasConflictError,
  NodeDuplicateFilesError,
  putNodeContent,
} from '@/api/canvas';
import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';

import {
  MD_BACKED_NODE_TYPES,
  NODE_CONTENT_KEYS,
  TEXT_BEARING_NODE_TYPES,
} from './nodeContentFields';
import { createPerKeyDebouncer } from './perKeyDebouncer';

import type { PutNodeContentRequest } from '@sediment/shared';
import type { Node } from '@xyflow/react';

/**
 * Slice fields the queue reads at fire time. Kept structural (not
 * `RFState`) so this module is free of store-type coupling and
 * import cycles.
 */
export type NodeContentQueueState = {
  canvasId: string;
  nodes: readonly Node[];
  _setStateNoAutosave: (partial: { nodes: Node[] }) => void;
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

/**
 * Public shape returned by {@link createNodeContentQueue}.
 */
export type NodeContentQueue = {
  /**
   * Diff `prevNodes` against `nextNodes` and schedule a per-node
   * content save for every markdown-backed node whose content keys
   * actually changed. New nodes always schedule (their `.md` does not
   * exist yet); deleted nodes are ignored — the DELETE endpoint
   * handles unlink and a stale debounced timer for a deleted node
   * no-ops on the request builder returning `null`.
   */
  scheduleChanges(
    canvasId: string,
    prevNodes: readonly Node[],
    nextNodes: readonly Node[],
  ): void;

  /**
   * Force an immediate flush of `nodeId`'s pending content save and
   * return a promise that resolves after the server PUT settles.
   * Awaits any previously in-flight write so the latest label is the
   * one tested for collision on the server.
   *
   * Used by `tryRename('node')` so the caller can observe (and react
   * to) a `NODE_LABEL_CONFLICT` instead of waiting on a fire-and-
   * forget debounced save.
   *
   * `source` controls failure UX inside the queue:
   * - `'user'` (default for `flushNow`): user kicked off this flush
   *   directly (e.g. clicked rename / blurred a label input). On a
   *   non-409 failure the queue still reverts the label, but also
   *   pops a toast so the user sees their action didn't stick.
   * - `'auto'`: the flush was triggered by debounced autosave / agent
   *   edits / canvas-switch flush. Same revert, but only
   *   `console.error` — no toast spam for changes the user didn't
   *   explicitly request.
   */
  flushNow(
    canvasId: string,
    nodeId: string,
    opts?: { source?: 'user' | 'auto' },
  ): Promise<void>;

  /**
   * Promote every pending debounced content save into an immediate
   * flush, then wait for every in-flight PUT (including the new ones)
   * to settle. Used by `switchCanvas` alongside the structure-save
   * flush so canvas switches do not orphan editor edits.
   */
  flushAll(): Promise<void>;

  /**
   * `beforeunload` best-effort flush of pending content saves via
   * `keepalive` so the trailing tail of editor edits is not lost when
   * the user closes the tab. Mirrors the canvas-event buffer's
   * `flushAllKeepalive` pattern.
   */
  flushAllKeepalive(): void;

  /**
   * Drop the once-per-node duplicate-toast guard so a future
   * recurrence re-alerts. Called when the duplicate is resolved
   * *outside* a successful save — i.e. the node's Refresh button
   * confirmed the on-disk collision is gone. Without this, the guard
   * set during the first refusal would suppress the toast for a
   * second duplicate created later in the same session.
   */
  clearDuplicateGuard(nodeId: string): void;

  /**
   * Node ids with un-persisted content edits — pending debounced saves
   * plus in-flight PUTs. Used by the sync applier to protect a node the
   * user is mid-editing from an incoming agent write.
   */
  pendingNodeIds(): string[];
};

/**
 * Build a {@link NodeContentQueue}.
 *
 * @param opts.delayMs - debounce delay
 * @param opts.getState - lazy getter for the store slice fields the
 *   queue needs. Re-invoked on every fire so HMR / store swaps Just
 *   Work.
 */
export function createNodeContentQueue(opts: {
  delayMs: number;
  getState: () => NodeContentQueueState;
}): NodeContentQueue {
  const debouncer = createPerKeyDebouncer<string>(opts.delayMs);
  const inflight = new Map<string, Promise<void>>();
  /**
   * Last `(label, labelSource)` the server confirmed it persisted for
   * each nodeId. Used by {@link handleSaveFailure} to revert an
   * optimistic rename back to the last-known-good name when a PUT
   * fails. Brand-new nodes have no entry until their first PUT
   * succeeds, so a first-write failure cannot be reverted (we toast
   * without rolling back the user's typing).
   *
   * Keyed by nodeId alone: node ids are workspace-unique UUIDs, so a
   * canvas switch can't introduce a collision.
   */
  const lastSuccessful = new Map<
    string,
    { label: string | null; labelSource: string | undefined }
  >();

  /**
   * Node ids for which we have already shown the persistent
   * "duplicate files on disk" toast. Autosave retries while the
   * duplicate persists would otherwise pop a fresh toast on every
   * keystroke; we toast once and clear the flag on the next
   * successful write (so a recurrence later in the session re-alerts).
   */
  const duplicateToasted = new Set<string>();

  /**
   * Build the `PutNodeContentRequest` body for `nodeId` from the
   * latest store snapshot. Returns `null` when the node has gone
   * away (e.g. deleted between debounce-schedule and flush) or its
   * type is not markdown-backed.
   */
  function buildRequest(nodeId: string): PutNodeContentRequest | null {
    const node = opts.getState().nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!MD_BACKED_NODE_TYPES.has(nodeType)) return null;

    const data = (node.data ?? {}) as Record<string, unknown>;
    const body: PutNodeContentRequest = { nodeType };

    if (TEXT_BEARING_NODE_TYPES.has(nodeType)) {
      const content = data['content'];
      if (typeof content === 'string') body.content = content;
    }

    const label = data['label'];
    if (typeof label === 'string') body.label = label;
    else if (label === null) body.label = null;

    const labelSource = data['labelSource'];
    if (
      labelSource === 'user' ||
      labelSource === 'auto' ||
      labelSource === 'agent'
    ) {
      body.labelSource = labelSource;
    }

    const src = data['src'];
    if (typeof src === 'string') body.src = src;

    const summary = data['summary'];
    if (typeof summary === 'string') body.summary = summary;

    const keywords = data['keywords'];
    if (
      Array.isArray(keywords) &&
      keywords.every((k) => typeof k === 'string')
    ) {
      body.keywords = keywords as string[];
    }

    if ('provenance' in data) {
      body.provenance = data['provenance'];
    }

    return body;
  }

  /**
   * Execute a single per-node content PUT. Reads the store at call
   * time so trailing edits collapse into one body. On success,
   * mirrors the server-resolved label back into the store (for agent
   * auto-dedupe suffixes) without scheduling another autosave
   * round-trip.
   *
   * Throws `CanvasConflictError` on `NODE_LABEL_CONFLICT` so
   * `tryRename`'s awaited path can revert the optimistic label and
   * alert.
   */
  async function performSave(
    canvasId: string,
    nodeId: string,
    kOpts?: { keepalive?: boolean },
  ): Promise<void> {
    const body = buildRequest(nodeId);
    if (!body) return;
    const response = await putNodeContent(canvasId, nodeId, body, kOpts);
    // A write that succeeded means any prior duplicate has been
    // resolved — drop the once-per-node toast guard so a future
    // recurrence alerts again, and clear the node's duplicate banner
    // (it was only set transiently by `notifyDuplicate`, never
    // persisted) so editing re-enables without a reload.
    if (duplicateToasted.delete(nodeId)) {
      opts.getState().patchNodeSilent(nodeId, {
        contentDuplicate: false,
        duplicateFiles: [],
      });
    }
    // Record the label the server actually persisted so a later
    // failure can revert to it. Capture `labelSource` from the body
    // we just sent — it's the provenance attached to that label
    // server-side.
    lastSuccessful.set(nodeId, {
      label: response.label,
      labelSource:
        typeof body.labelSource === 'string' ? body.labelSource : undefined,
    });
    // Only patch when the resolved label actually differs from what's
    // in the store right now — avoids spurious re-renders when the
    // server echoes back exactly what we sent.
    const state = opts.getState();
    const currentNode = state.nodes.find((n) => n.id === nodeId);
    if (!currentNode) return;
    const currentLabel =
      typeof currentNode.data?.['label'] === 'string'
        ? (currentNode.data['label'] as string)
        : null;
    if (response.label !== null && response.label !== currentLabel) {
      state._setStateNoAutosave({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: { ...(n.data ?? {}), label: response.label },
              }
            : n,
        ),
      });
    }
  }

  /**
   * Wrap {@link performSave} with the standard failure routing:
   * `CanvasConflictError` (409) is re-thrown immediately so
   * `tryRename`'s awaited path can revert the optimistic label and
   * surface the conflict. All other errors are handed to
   * {@link handleSaveFailure} (which reverts a stale rename and, for
   * user-initiated flushes, toasts) and then re-thrown so callers
   * can still observe the failure.
   *
   * `source` is forwarded to {@link handleSaveFailure} so it can
   * decide whether to toast (user-initiated) or just log
   * (background autosave / agent edits).
   */
  async function performSaveSafely(
    canvasId: string,
    nodeId: string,
    source: 'user' | 'auto',
    kOpts?: { keepalive?: boolean },
  ): Promise<void> {
    try {
      await performSave(canvasId, nodeId, kOpts);
    } catch (err) {
      if (err instanceof NodeDuplicateFilesError) {
        notifyDuplicate(nodeId, err);
        throw err;
      }
      if (err instanceof CanvasConflictError) throw err;
      handleSaveFailure(canvasId, nodeId, source, err);
      throw err;
    }
  }

  /**
   * Surface a duplicate-sidecar refusal. Unlike ordinary save
   * failures this is an unresolved on-disk state (two `.md` files
   * claim the same node id) that the user must fix in their file
   * manager. The node's duplicate flags are patched on *every*
   * refusal so the NodeWrapper's full-cover banner always reflects
   * the current on-disk state — even a repeat refusal whose toast was
   * already shown. Gating the patch behind {@link duplicateToasted}
   * (as the toast is) would miss a *second* duplicate raised after
   * the first was resolved via the node's Refresh button, which
   * clears the banner but not the toast guard, leaving the node
   * silently uneditable.
   *
   * The flags are transient client hints (never persisted);
   * `performSave` clears them on the next successful write. The toast
   * itself is rate-limited to once per node (until the duplicate is
   * resolved) so autosave retries don't spam.
   */
  function notifyDuplicate(nodeId: string, err: NodeDuplicateFilesError): void {
    opts.getState().patchNodeSilent(nodeId, {
      contentDuplicate: true,
      duplicateFiles: err.duplicateFiles,
    });
    if (duplicateToasted.has(nodeId)) return;
    duplicateToasted.add(nodeId);
    toast(err.message, { tone: 'danger', duration: 0, dismissible: true });
    console.error('Node write refused — duplicate files on disk:', nodeId, err);
  }

  /**
   * Final failure handler invoked after a non-conflict error. Always
   * reverts the label to the last-persisted value when the failing
   * PUT was changing the label (state-consistency win, no matter who
   * triggered the flush).
   *
   * `source` decides the user-visible UX:
   * - `'user'` → toast (the user expects feedback because they just
   *   clicked rename / typed in the label input).
   * - `'auto'` → only `console.error`; the silent revert is feedback
   *   enough for background edits and keeps the canvas from spamming
   *   toasts during heavy agent activity.
   *
   * Callers guarantee the canvas hasn't been swapped out from under
   * us by draining the queue on every canvas exit: `switchCanvas`
   * awaits `flushAll()` before changing `state.canvasId`, and
   * `CanvasPage` fires `flushPendingNodeContent()` on unmount. So
   * by the time a failure lands here, `state.canvasId` and the
   * captured `canvasId` are still the same canvas — no need to
   * branch on a mismatch. `canvasId` stays in the signature so
   * `performSaveSafely` can keep forwarding it for future
   * per-canvas logging without churning every call site.
   */
  function handleSaveFailure(
    canvasId: string,
    nodeId: string,
    source: 'user' | 'auto',
    err: unknown,
  ): void {
    void canvasId;
    const state = opts.getState();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return; // node was deleted mid-flight — nothing to do

    const data = (node.data ?? {}) as Record<string, unknown>;
    const currentLabel =
      typeof data['label'] === 'string' ? (data['label'] as string) : null;
    const lastGood = lastSuccessful.get(nodeId);

    // Rename failure: we have a previously-persisted label AND the
    // store's label drifted away from it. Roll back the label only —
    // preserve content / src / summary so the user's other edits
    // survive. labelSource is restored to whatever was attached to
    // the last successful PUT (or stripped entirely if none).
    if (lastGood && lastGood.label !== currentLabel) {
      state._setStateNoAutosave({
        nodes: state.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const { labelSource: _omitted, ...rest } = (n.data ?? {}) as Record<
            string,
            unknown
          >;
          return {
            ...n,
            data: {
              ...rest,
              label: lastGood.label,
              ...(lastGood.labelSource !== undefined
                ? { labelSource: lastGood.labelSource }
                : {}),
            },
          };
        }),
      });
      const displayName = lastGood.label ?? i18n.t('errors.previousName');
      if (source === 'user') {
        toast(i18n.t('errors.nodeRenameReverted', { name: displayName }), {
          tone: 'danger',
        });
      }
      console.error('Node rename failed; reverted:', nodeId, err);
      return;
    }

    // Content-only failure (or first-ever write with no last-good
    // anchor to revert to): toast (user path) or log (auto path); the
    // in-store body is left alone so the user's typing isn't lost.
    if (source === 'user') {
      toast(i18n.t('errors.nodeChangesMayNotPersist'), { tone: 'danger' });
    }
    console.error('Node content save failed:', nodeId, err);
  }

  /**
   * Serialize per-node PUTs: chain each new flush onto any pending
   * one so the server never sees two writes for the same node in
   * flight at once. Always exposes the latest in-flight promise via
   * the `inflight` map so `flushNow` / `flushAll` can `await` it.
   */
  function serializedFlush(
    canvasId: string,
    nodeId: string,
    source: 'user' | 'auto',
    kOpts?: { keepalive?: boolean },
  ): Promise<void> {
    const prev = inflight.get(nodeId) ?? Promise.resolve();
    const next = prev
      // Detach from prev's rejection so a previous 409 doesn't poison
      // the chain — tryRename has already handled that error via its
      // own await.
      .catch(() => undefined)
      .then(() => performSaveSafely(canvasId, nodeId, source, kOpts));
    inflight.set(nodeId, next);
    // `.finally()` returns a new promise that re-rejects when `next`
    // rejects. The outer caller (`schedule` / `flushNow` / `flushAll`)
    // attaches its own `.catch` to `next` itself, but this cleanup
    // chain is a separate promise — without the trailing `.catch` it
    // would fire `window.onunhandledrejection` on every 409 / 5xx.
    void next
      .finally(() => {
        if (inflight.get(nodeId) === next) {
          inflight.delete(nodeId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * Schedule a debounced content save for `nodeId`. Coalesces rapid
   * patches into a single PUT after the debounce window. The
   * captured `canvasId` makes mid-debounce canvas switches safe —
   * the timer always targets the canvas the edit was made on, even
   * if the user has since navigated away.
   */
  function schedule(canvasId: string, nodeId: string): void {
    if (!canvasId || !nodeId) return;
    debouncer.schedule(nodeId, () => {
      // Conflicts are surfaced via `tryRename`'s own await path; other
      // failures are handled (toast + optional label-revert) by
      // {@link handleSaveFailure} inside `performSaveSafely`. Just
      // swallow here to keep the fire-and-forget rejection from
      // escaping into the runtime.
      serializedFlush(canvasId, nodeId, 'auto').catch(() => undefined);
    });
  }

  return {
    scheduleChanges(canvasId, prevNodes, nextNodes) {
      if (!canvasId || prevNodes === nextNodes) return;
      const prevById = new Map(prevNodes.map((n) => [n.id, n]));
      for (const next of nextNodes) {
        const nodeType = typeof next.type === 'string' ? next.type : '';
        if (!MD_BACKED_NODE_TYPES.has(nodeType)) continue;
        const before = prevById.get(next.id);
        if (!before) {
          // Brand new node — its `.md` does not exist yet.
          schedule(canvasId, next.id);
          continue;
        }
        if (before.data === next.data) continue;
        const beforeData = (before.data ?? {}) as Record<string, unknown>;
        const afterData = (next.data ?? {}) as Record<string, unknown>;
        for (const key of NODE_CONTENT_KEYS) {
          if (beforeData[key] !== afterData[key]) {
            schedule(canvasId, next.id);
            break;
          }
        }
      }
    },

    flushNow(canvasId, nodeId, flushOpts) {
      debouncer.cancel(nodeId);
      // Default to `'user'` so explicit `flushNow` callers
      // (`tryRename`, blur-on-input handlers) get user-facing toasts
      // on failure. Background callers that still want to flush
      // synchronously can opt into `'auto'`.
      const source = flushOpts?.source ?? 'user';
      return serializedFlush(canvasId, nodeId, source);
    },

    async flushAll() {
      const canvasId = opts.getState().canvasId;
      const pendingIds = debouncer.cancelAll();
      for (const nodeId of pendingIds) {
        void serializedFlush(canvasId, nodeId, 'auto').catch(() => undefined);
      }
      await Promise.all(
        Array.from(inflight.values()).map((p) => p.catch(() => undefined)),
      );
    },

    flushAllKeepalive() {
      const canvasId = opts.getState().canvasId;
      const pendingIds = debouncer.cancelAll();
      for (const nodeId of pendingIds) {
        // Fire-and-forget keepalive PUT — browser caps these at ~64 KB
        // per request, which is plenty for a single node's markdown.
        void serializedFlush(canvasId, nodeId, 'auto', {
          keepalive: true,
        }).catch(() => undefined);
      }
    },

    clearDuplicateGuard(nodeId) {
      duplicateToasted.delete(nodeId);
    },

    pendingNodeIds() {
      // Debounced-but-not-yet-fired saves plus in-flight PUTs: both mean
      // the node holds a local edit the server hasn't acknowledged.
      return Array.from(
        new Set([...debouncer.pendingKeys(), ...inflight.keys()]),
      );
    },
  };
}
