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
  MD_BACKED_NODE_TYPES,
  NODE_CONTENT_KEYS,
  TEXT_BEARING_NODE_TYPES,
} from './nodeContentFields';
import { createPerKeyDebouncer } from './perKeyDebouncer';

import type { PutNodeContentRequest } from '@sediment/shared';
import type { Node } from '@xyflow/react';

import { CanvasConflictError, putNodeContent } from '@/api/canvas';

/**
 * Slice fields the queue reads at fire time. Kept structural (not
 * `RFState`) so this module is free of store-type coupling and
 * import cycles.
 */
export type NodeContentQueueState = {
  canvasId: string;
  nodes: readonly Node[];
  _setStateNoAutosave: (partial: { nodes: Node[] }) => void;
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
   */
  flushNow(canvasId: string, nodeId: string): Promise<void>;

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
   * Serialize per-node PUTs: chain each new flush onto any pending
   * one so the server never sees two writes for the same node in
   * flight at once. Always exposes the latest in-flight promise via
   * the `inflight` map so `flushNow` / `flushAll` can `await` it.
   */
  function serializedFlush(
    canvasId: string,
    nodeId: string,
    kOpts?: { keepalive?: boolean },
  ): Promise<void> {
    const prev = inflight.get(nodeId) ?? Promise.resolve();
    const next = prev
      // Detach from prev's rejection so a previous 409 doesn't poison
      // the chain — tryRename has already handled that error via its
      // own await.
      .catch(() => undefined)
      .then(() => performSave(canvasId, nodeId, kOpts));
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
      serializedFlush(canvasId, nodeId).catch((err) => {
        // Conflicts are surfaced via `tryRename`'s own await path;
        // only log non-conflict errors here so the fire-and-forget
        // rejection doesn't escape into the runtime as unhandled.
        if (!(err instanceof CanvasConflictError)) {
          console.error('Node content save failed:', err);
        }
      });
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

    flushNow(canvasId, nodeId) {
      debouncer.cancel(nodeId);
      return serializedFlush(canvasId, nodeId);
    },

    async flushAll() {
      const canvasId = opts.getState().canvasId;
      const pendingIds = debouncer.cancelAll();
      for (const nodeId of pendingIds) {
        void serializedFlush(canvasId, nodeId).catch(() => undefined);
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
        void serializedFlush(canvasId, nodeId, { keepalive: true }).catch(
          () => undefined,
        );
      }
    },
  };
}
