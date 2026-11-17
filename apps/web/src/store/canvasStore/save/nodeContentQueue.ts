// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-node content save queue.
 *
 * Edits to a node's markdown sidecar (content / label / src / summary /
 * keywords / provenance) are persisted via a dedicated per-node endpoint
 * (`PUT /api/canvas/:canvasId/nodes/:nodeId/content`) that never bumps
 * the canvas-level `version` counter. This decouples editor typing from
 * structure edits, which are sent as command batches, so the two flows can
 * never collide on a concurrency check.
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
 * **What the revision covers.** `expectRev` is the revision of the node's
 * body (`content`, `src`) and nothing else. Custom properties (`properties`,
 * `propertyDisplayKeys`) are independent small items: they are sent as a
 * per-key patch without a revision, either by themselves
 * ({@link NodeContentQueue.commitProperties}, and a store change of
 * properties alone) or beside a body in one request, where the server
 * applies them whatever becomes of the body. A property save never moves the
 * body's baseline, and a body save never carries a property nobody changed
 * here.
 *
 * See `docs/architecture/canvas-realtime-sync.md` (Node content between
 * pages).
 */

import deepEqual from 'fast-deep-equal';

import {
  CONTENT_REVISION_KEYS,
  nodeRevisionOf,
  mergeNodeProperties,
} from '@huabu/shared/canvas-engine';

import { ApiError } from '@/api/_client';
import {
  CanvasConflictError,
  getNodeContent,
  NodeDuplicateFilesError,
  putNodeContent,
} from '@/api/canvas';
import { dismissToast, toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import { copyToClipboard } from '@/utils/io/clipboard';
import {
  saveErrorsHandledByCaller,
  showSaveErrorRecovery,
} from '@/utils/saveErrorFeedback';

import {
  MD_BACKED_NODE_TYPES,
  NODE_CONTENT_KEYS,
  SERVER_DERIVED_SIDECAR_NODE_TYPES,
  TEXT_BEARING_NODE_TYPES,
  withContentPatch,
} from './nodeContentFields';
import { createPerKeyDebouncer } from './perKeyDebouncer';

import type {
  GetNodeContentResponse,
  PutNodeContentRequest,
  PutNodeContentResponse,
  NodeProperties,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

/**
 * Revision of an empty node ({@link nodeRevisionOf} over no authored
 * content). A brand-new node the client is creating sends this as its
 * `expectRev` baseline, so the create only succeeds while no `.md` exists
 * yet on the server — closing the create-race window.
 */
const REV_EMPTY = nodeRevisionOf({});

/** A custom-property edit: the keys it sets or removes, and the display order. */
type PropertyEdit = Pick<
  PutNodeContentRequest,
  'properties' | 'propertyDisplayKeys'
>;

/**
 * The sidecar fields that hold a node's custom properties. No revision
 * covers them and they are saved per key; every other content field belongs
 * to the body's save.
 */
const PROPERTY_FIELDS: ReadonlySet<string> = new Set([
  'properties',
  'propertyDisplayKeys',
]);

/** The keys of a property bag whose value differs between `before` and `after`. */
function changedPropertyKeys(before: unknown, after: unknown): string[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) =>
      Object.hasOwn(a, key) !== Object.hasOwn(b, key) ||
      !deepEqual(a[key], b[key]),
  );
}

/** Set `key` on a property bag or patch, also when it is named like a prototype member. */
function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Compute a node's content revision (the CAS baseline) from its data. */
function revOfNode(node: Node): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  return nodeRevisionOf({
    ...data,
    type: node.type,
    ...(typeof data['content'] === 'string'
      ? { content: data['content'] as string }
      : {}),
    ...(typeof data['src'] === 'string' ? { src: data['src'] as string } : {}),
  });
}

/** JSON-shaped values compared by content, ignoring object key order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        key in b &&
        sameValue(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

/**
 * The sidecar fields of `data` that differ from what the server returned.
 * A field the response leaves out is left alone, an absent label equals
 * `null`, and a body is only taken by a node that carries one.
 *
 * A PDF's extracted text is not such a body: a load leaves it out (the page
 * renders the file, see `SERVER_DERIVED_SIDECAR_NODE_TYPES`), so a fetch
 * does not bring it in either. A page that holds no body for a PDF then
 * copies, cuts and restores it without one, and the server derives the text
 * again; a page that does hold one (it preprocessed the PDF itself) keeps it
 * current.
 */
function remoteContentPatch(
  nodeType: string,
  data: Record<string, unknown>,
  res: GetNodeContentResponse,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (
    ((TEXT_BEARING_NODE_TYPES.has(nodeType) &&
      !SERVER_DERIVED_SIDECAR_NODE_TYPES.has(nodeType)) ||
      typeof data['content'] === 'string') &&
    data['content'] !== res.content
  )
    patch['content'] = res.content;
  if ((data['label'] ?? null) !== res.label) patch['label'] = res.label;
  for (const key of [
    'labelSource',
    'src',
    'summary',
    'keywords',
    'provenance',
  ] as const) {
    const remote = res[key];
    if (remote !== undefined && !sameValue(data[key], remote))
      patch[key] = remote;
  }
  // The response always carries the node's whole property bag and display
  // order, so their absence means the other page removed the last of them:
  // the key is named with `undefined` and removed by the caller.
  for (const key of ['properties', 'propertyDisplayKeys'] as const) {
    const remote = res[key];
    if (
      remote === undefined
        ? data[key] !== undefined
        : !sameValue(data[key], remote)
    )
      patch[key] = remote;
  }
  if (data['contentMissing'] === true) patch['contentMissing'] = false;
  return patch;
}

/**
 * Whether `node` shows exactly the body the server returned: the same
 * revision, or no difference in any field the revision covers
 * (`CONTENT_REVISION_KEYS`: `content`, `src`) that a save of the node would
 * carry (a PDF's extracted text is part of its revision but is not sent by a
 * page that does not hold it). Compared as a save sends them; anything else,
 * one character included, is a difference. Custom properties are not part of
 * it: they have no revision and cannot be in conflict.
 */
function showsServerContent(node: Node, res: GetNodeContentResponse): boolean {
  if (res.contentMissing) return false;
  if (res.rev === revOfNode(node)) return true;
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (
    TEXT_BEARING_NODE_TYPES.has(node.type ?? '') &&
    typeof data['content'] === 'string' &&
    data['content'] !== res.content
  )
    return false;
  return !(typeof data['src'] === 'string' && data['src'] !== res.src);
}

/** What {@link NodeContentQueue.adoptRemoteContent} did with a node. */
export type RemoteContentOutcome =
  /** The node now shows the server's content. */
  | 'applied'
  /** The node already showed it; only the baseline revision moved. */
  | 'unchanged'
  /**
   * This page has its own unsaved body for the node: the text, title and
   * baseline were not touched. Custom properties the page has not changed
   * itself were taken from the server.
   */
  | 'kept-local'
  /** The node, its sidecar or the Space is not there (any more). */
  | 'absent'
  /** The content could not be fetched. */
  | 'failed';

/**
 * Slice fields the queue reads at fire time. Kept structural (not
 * `RFState`) so this module is free of store-type coupling and
 * import cycles.
 */
export type NodeContentQueueState = {
  canvasId: string;
  isLoading: boolean;
  nodes: readonly Node[];
  _setStateRaw: (partial: { nodes: Node[] }) => void;
  patchNodeSilent: (nodeId: string, patch: Record<string, unknown>) => void;
};

/**
 * Public shape returned by {@link createNodeContentQueue}.
 */
export type NodeContentQueue = {
  /**
   * Save a custom-property edit now, as a per-key patch without a revision,
   * and publish it locally only when the server has answered. Independent of
   * the node's body: it is sent while a body is unsaved, in flight or frozen
   * by a conflict, and moves no baseline. Rejects when the save fails; the
   * store is then as it was and the caller reports it.
   */
  commitProperties(
    canvasId: string,
    nodeId: string,
    patch: Pick<PutNodeContentRequest, 'properties' | 'propertyDisplayKeys'>,
  ): Promise<void>;
  /**
   * Seed nodes whose CREATE_NODES command is being persisted by the
   * server, and suppress the redundant "new node" sidecar PUT. A real edit
   * after the optimistic insertion still schedules normally.
   */
  prepareServerCreatedNodes(nodes: readonly Node[]): void;
  /** Hold resurrected sidecars until the matching topology is acknowledged. */
  holdRestoredNodes(canvasId: string, nodes: readonly Node[]): void;
  restoreTokens(): ReadonlyMap<string, object>;
  acknowledgeRestores(
    canvasId: string,
    tokens: ReadonlyMap<string, object>,
  ): void;
  hasRestore(nodeId: string): boolean;
  hasPendingRestoredContent(nodeId?: string): boolean;
  waitForIdle(): Promise<void>;
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
  flushAllForSubmission(canvasId: string): Promise<void>;
  /** Requeue retained transient or label-collision failures once per save attempt. */
  retryFailedSaves(canvasId: string): void;
  /** Stop new writes and restore releases until discard settles; returns resume. */
  suspendCanvas(canvasId: string): () => void;
  /** Forget explicitly discarded edits after issued writes have settled. */
  discardCanvas(canvasId: string): void;

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
   * Drop ALL per-node bookkeeping for a node that no longer exists
   * (deleted / removed from the canvas). Cancels any pending debounce
   * and clears its entries in every per-node map/set — the CAS
   * baseline, the frozen/conflict guards, the save-error and duplicate
   * toast guards, and the last-good rename anchor — so a long session
   * of create/delete churn does not leak memory keyed by dead node ids.
   * Idempotent: forgetting an unknown node is a no-op. An in-flight PUT
   * is left to settle on its own (its `inflight` entry self-clears);
   * `buildRequest` already returns `null` for a node gone from the store.
   */
  forgetNode(nodeId: string): void;

  /**
   * Node ids with un-persisted content edits — pending debounced saves
   * plus in-flight PUTs. Used by the sync applier to protect a node the
   * user is mid-editing from an incoming agent write.
   */
  pendingNodeIds(): string[];
  /**
   * Nodes of `canvasId` whose content exists only on this page: everything
   * {@link pendingNodeIds} names, and the nodes whose last save failed.
   */
  unsavedNodeIds(canvasId: string): string[];
  pendingFields(nodeId: string): ReadonlySet<string>;
  /**
   * The custom-property keys of `nodeId` this page changed and has not
   * saved. An update keeps those as they are here and shows every other
   * property it changed.
   */
  pendingPropertyKeys(nodeId: string): ReadonlySet<string>;
  /**
   * Properties an update brought for `nodeId` were put into the store by
   * the caller. A property edit of the node that is on the wire is followed
   * by one fetch, so the page ends with what the server holds.
   */
  remotePropertiesShown(nodeId: string): void;
  /**
   * Settles when the save of `nodeId` now on the wire (and those chained
   * behind it) has been answered. `true` when nothing else is waiting for
   * the node — no queued field, no debounce, no held restore — so a caller
   * that only wants "the Server has what this page shows" need not send
   * another save.
   */
  whenInFlightSaved(nodeId: string): {
    onlyInFlight: boolean;
    done: Promise<void>;
  };
  /** Whether a content edit has not reached the Server: queued, in flight or failed. */
  hasUnsavedContent(canvasId: string): boolean;

  /**
   * Move the save baseline of each given node: the revision its next
   * body save quotes as `expectRev`. **Nothing else**: a failed save stays
   * recorded with its Retry toast, and a node frozen by a content conflict
   * stays frozen. Called whenever the page learns the server's current
   * revision of a node — a load, an update that changed the node's content
   * and was applied, and an update whose content change was withheld
   * because the user is editing the node (the baseline moves, the text
   * stays).
   *
   * `revisions` are the server's (`nodeContentRevisions` of a load or an
   * update). A node it does not name is hashed from `node` — a load from a
   * server that sends none; callers on the update path pass only nodes the
   * server named.
   */
  setBaselines(
    nodes: readonly Node[],
    revisions?: Readonly<Record<string, string>>,
  ): void;

  /**
   * The page shows the server's content of these nodes and holds nothing
   * unsaved for them — a load, or an update applied to a node with no local
   * edit. Forget what was recorded about their saves: the failure record
   * and its toast, the once-per-node toast guards, and a conflict freeze,
   * since nothing is left to retry or to choose between.
   *
   * Never called for a node that still shows content of its own: a failure
   * record is otherwise cleared only by a successful save, and a freeze only
   * by the user's choice or by the identical-content rule.
   */
  clearUnsavedStatus(nodeIds: readonly string[]): void;

  /**
   * An update carried the server's new content for `nodeId` while this page
   * kept its own unsaved content. When the node is frozen by a content
   * conflict the user has not answered, the conflict stays theirs to answer:
   * the node stays frozen with its toast, and only the revision **Keep
   * mine** would overwrite moves on to `rev`, the revision the server stored
   * with that update. Without one nothing moves. Returns whether the node is
   * frozen; a node that is not is left to {@link setBaselines}.
   */
  rebaseConflict(nodeId: string, rev: string | undefined): boolean;

  /**
   * An update carried the server's content for `node` while it is frozen by
   * a content conflict, stored under revision `rev`. When this page's own
   * content has that revision there is nothing left to choose between: the
   * conflict and its toast are dismissed without a word, `rev` becomes the
   * baseline, and the text and caret stay as they are. Returns whether that
   * happened; `false` leaves the node frozen (see {@link rebaseConflict}),
   * as does an update that brought no revision.
   */
  settleConflictIfIdentical(node: Node, rev: string | undefined): boolean;

  /**
   * Another page saved `nodeId`'s sidecar: fetch it and show it, together
   * with its revision as the new baseline, so this page's next save of the
   * node descends from what it now shows.
   *
   * A node with a body this page has not saved yet (queued, in flight,
   * failed, conflicted or held for a restore) keeps its text, title and
   * baseline, so the existing `NODE_CONTENT_CONFLICT` choice still decides
   * it. Its custom properties are fetched and shown all the same — they do
   * not overlap the unsaved body — except a property this page has itself
   * changed and not saved. The whole node is fetched once that save has been
   * acknowledged. The store is written
   * through `_setStateRaw`: no save, undo entry or preprocessing run
   * follows on this page.
   */
  adoptRemoteContent(
    canvasId: string,
    nodeId: string,
  ): Promise<RemoteContentOutcome>;
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
  waitForCreation?: (canvasId: string, nodeId: string) => Promise<void>;
  /**
   * A failed save of `nodeId` is about to be tried again. When what
   * `waitForCreation` waits for has itself failed (the batch that brings the
   * node back), send that again first; otherwise do nothing.
   */
  retryCreation?: (canvasId: string, nodeId: string) => void;
  onRestoredContentPersisted?: (canvasId: string, nodeId: string) => void;
  /** A node's content save was acknowledged and nothing more is pending for it. */
  onContentPersisted?: (canvasId: string, nodeId: string) => void;
  /** Sent with every save so this page can recognise its own `invalidate`. */
  pageId?: string;
  /** Another page's content was put into the store for `nodeId`. */
  onRemoteContentAdopted?: (
    canvasId: string,
    nodeId: string,
    patch: Readonly<Record<string, unknown>>,
  ) => void;
  onPropertiesSaved?: (
    nodeId: string,
    patch: Pick<PutNodeContentRequest, 'properties' | 'propertyDisplayKeys'>,
  ) => void;
}): NodeContentQueue {
  const debouncer = createPerKeyDebouncer<string>(opts.delayMs);
  const suspendedCanvases = new Set<string>();
  const inflight = new Map<string, Promise<void>>();
  const restores = new Map<string, { canvasId: string; token: object }>();
  const restoredContent = new Map<string, string>();
  const generations = new Map<string, object>();
  const failures = new Map<string, { canvasId: string; error: unknown }>();
  const failureToasts = new Map<string, string>();
  const pendingFailureRecovery = new Map<string, () => void>();
  function dismissFailureToast(nodeId: string): void {
    pendingFailureRecovery.get(nodeId)?.();
    pendingFailureRecovery.delete(nodeId);
    const id = failureToasts.get(nodeId);
    if (id) dismissToast(id);
    failureToasts.delete(nodeId);
  }
  function showFailureRecovery(nodeId: string, show: () => void): void {
    const canvasId = opts.getState().canvasId;
    const cancel = showSaveErrorRecovery(() => {
      pendingFailureRecovery.delete(nodeId);
      if (opts.getState().canvasId === canvasId) show();
    });
    if (cancel) pendingFailureRecovery.set(nodeId, cancel);
  }
  const pendingFields = new Map<string, Map<string, { removed?: boolean }>>();
  /**
   * The custom-property keys of each node that a store change set, changed
   * or removed and that have not been saved, each with the token of its
   * latest change. They are what a save sends as `properties`: the key's
   * value now, or `null` when it is gone. A node has an entry only together
   * with a `properties` entry in {@link pendingFields}.
   */
  const pendingPropertyKeys = new Map<string, Map<string, object>>();
  /**
   * {@link NodeContentQueue.commitProperties} saves under way, one chain per
   * node. Not unsaved content of the node: the edit is not in the store
   * until it is answered, and the body's lane ({@link inflight}) does not
   * wait for it.
   */
  const propertySaves = new Map<string, Promise<void>>();
  /** Nodes whose properties arrived from the server while such a save was under way. */
  const remoteDuringPropertySave = new Set<string>();
  /** The node whose acknowledged property edit is being put into the store. */
  let publishingProperties: string | undefined;
  const suppressNextNewNodeSave = new Set<string>();
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
   * Optimistic-concurrency baseline: the {@link nodeRevision} each node's
   * last server-agreed content had. Seeded on load / agent-sync (via
   * {@link setBaselines}) and updated to the server-returned rev after
   * every successful write, so content and its baseline always move
   * together. A node with no entry sends {@link REV_EMPTY} (treated as
   * "I believe this is a fresh create").
   */
  const baselineRev = new Map<string, string>();
  const baselineGeneration = new Map<string, object>();

  /**
   * Node ids for which the persistent `NODE_CONTENT_CONFLICT` toast is
   * registered (visible or deferred). Rate-limits it to once per node (autosave
   * would otherwise re-pop it on every keystroke while the node stays
   * blocked). Cleared on a successful write, when the conflict is answered,
   * and by {@link NodeContentQueue.clearUnsavedStatus}.
   */
  const contentConflictToasted = new Set<string>();

  /**
   * Nodes frozen after a `NODE_CONTENT_CONFLICT`, mapped to the on-disk
   * revision we collided with. While a node is frozen {@link buildRequest}
   * returns `null`, so NO write path — debounced autosave, `flushNow`, or
   * the `beforeunload` keepalive — can PUT it. This is what makes the
   * "Load latest" (reload) resolution safe: reloading can never leak our
   * stale in-app version onto disk and clobber the newer server content.
   * The stored rev lets "Keep mine" re-baseline and force the overwrite.
   * Cleared by the user's choice (Keep mine, Load latest), by the
   * identical-content rule, and when the page's copy is replaced by the
   * server's ({@link NodeContentQueue.clearUnsavedStatus}, a load). An
   * update that arrives meanwhile never clears it: a frozen node counts as
   * having unsaved content ({@link NodeContentQueue.pendingNodeIds}), an
   * update that carries new server content for it only moves the stored rev
   * ({@link NodeContentQueue.rebaseConflict}), and moving a baseline
   * ({@link NodeContentQueue.setBaselines}) does not touch it.
   */
  const frozen = new Map<string, string>();

  /**
   * Node ids for which we have registered the persistent
   * "duplicate files on disk" toast. Autosave retries while the
   * duplicate persists would otherwise pop a fresh toast on every
   * keystroke; we toast once and clear the flag on the next
   * successful write (so a recurrence later in the session re-alerts).
   */
  const duplicateToasted = new Set<string>();

  /**
   * Node ids for which we have already shown the persistent save-failed
   * toast. Unlike a `NODE_CONTENT_CONFLICT` (a benign concurrency race,
   * handled separately) this is a genuine write failure (500 / IO / Drive
   * lock) where the body AND any rename silently did not land. We surface
   * it even for background (`auto`) saves so the user isn't left unaware
   * their last edit wasn't persisted — but throttle to once per node until
   * a save succeeds (or the user clicks Retry) so a repeatedly-failing
   * autosave can't spam. Cleared on the next successful write.
   */
  const saveErrorToasted = new Set<string>();

  /**
   * The custom-property part of a save of `nodeId`: the keys a store change
   * touched and that are not saved yet, each with its value now (`null` when
   * it is gone), and the display order when that changed. A restored node
   * sends its whole bag, since its sidecar starts absent. Keys nobody
   * changed here are never sent, so another writer's keys are never
   * overwritten or removed by this page.
   */
  function propertyPatchOf(
    nodeId: string,
    data: Record<string, unknown>,
    requestFields: ReadonlySet<string> | undefined,
  ): PropertyEdit {
    const patch: PropertyEdit = {};
    const local = data['properties'] as NodeProperties | undefined;
    if (restoredContent.has(nodeId)) {
      if (local !== undefined) patch.properties = { ...local };
      if (data['propertyDisplayKeys'] !== undefined)
        patch.propertyDisplayKeys = data['propertyDisplayKeys'] as string[];
      return patch;
    }
    if (requestFields?.has('properties')) {
      const keys = [...(pendingPropertyKeys.get(nodeId)?.keys() ?? [])];
      if (keys.length > 0) {
        patch.properties = {};
        for (const key of keys)
          setOwn(
            patch.properties,
            key,
            local && Object.hasOwn(local, key) ? local[key] : null,
          );
      }
    }
    // An order that was removed is sent as the empty one; a node that
    // never had one sends nothing.
    if (
      requestFields?.has('propertyDisplayKeys') &&
      (data['propertyDisplayKeys'] !== undefined ||
        pendingFields.get(nodeId)?.get('propertyDisplayKeys')?.removed)
    )
      patch.propertyDisplayKeys =
        (data['propertyDisplayKeys'] as string[] | undefined) ?? [];
    return patch;
  }

  /**
   * Build the `PutNodeContentRequest` body for `nodeId` from the
   * latest store snapshot. Returns `null` when the node has gone
   * away (e.g. deleted between debounce-schedule and flush) or its
   * type is not markdown-backed.
   *
   * `propertyOnly` says the request carries custom properties and nothing
   * else — no body, no title and no `expectRev`: when properties are all
   * that is unsaved, and for a node frozen by a body conflict, whose
   * properties are saved while the body waits for the user's choice.
   */
  function buildRequest(
    nodeId: string,
    requestFields: ReadonlySet<string> | undefined,
  ): { body: PutNodeContentRequest; propertyOnly: boolean } | null {
    const node = opts.getState().nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!MD_BACKED_NODE_TYPES.has(nodeType)) return null;

    // Held until the batch that brings the node back is acknowledged.
    if (restores.has(nodeId)) return null;

    const data = (node.data ?? {}) as Record<string, unknown>;
    if (data['contentMissing'] === true) return null;
    const restored = restoredContent.has(nodeId);
    const propertyPatch = propertyPatchOf(nodeId, data, requestFields);
    const hasPropertyPatch =
      propertyPatch.properties !== undefined ||
      propertyPatch.propertyDisplayKeys !== undefined;

    // Frozen after a content conflict: refuse every write path for the body
    // until the user resolves it, so neither a debounced autosave nor the
    // unload keepalive can clobber the newer server content. Properties are
    // not part of that conflict and go out by themselves.
    const frozenBody = frozen.has(nodeId);
    if (frozenBody && !hasPropertyPatch) return null;
    const onlyPropertiesRequested =
      (requestFields?.size ?? 0) > 0 &&
      [...(requestFields ?? [])].every((key) => PROPERTY_FIELDS.has(key));
    // A node this page has not saved yet (no baseline) is sent whole.
    const propertyOnly =
      !restored &&
      (frozenBody || (onlyPropertiesRequested && baselineRev.has(nodeId)));

    const partialQuestionWrite = nodeType === 'question' && !restored;
    if (partialQuestionWrite && !requestFields?.size) return null;
    const includes = (key: string) =>
      !propertyOnly &&
      (!partialQuestionWrite || requestFields?.has(key) === true);
    const body: PutNodeContentRequest = { nodeType };

    if (TEXT_BEARING_NODE_TYPES.has(nodeType) && includes('content')) {
      const content = data['content'];
      if (typeof content === 'string') body.content = content;
    }

    const label = data['label'];
    if (includes('label')) {
      if (typeof label === 'string') body.label = label;
      else if (label === null) body.label = null;
    }

    const labelSource = data['labelSource'];
    if (
      includes('labelSource') &&
      (labelSource === 'user' ||
        labelSource === 'auto' ||
        labelSource === 'agent')
    ) {
      body.labelSource = labelSource;
    }

    const src = data['src'];
    if (includes('src') && typeof src === 'string') body.src = src;

    const summary = data['summary'];
    if (includes('summary') && typeof summary === 'string')
      body.summary = summary;

    const keywords = data['keywords'];
    if (
      includes('keywords') &&
      Array.isArray(keywords) &&
      keywords.every((k) => typeof k === 'string')
    ) {
      body.keywords = keywords as string[];
    }

    if (includes('provenance') && 'provenance' in data) {
      body.provenance = data['provenance'];
    }
    // The per-key property patch. The server applies it to the properties
    // it holds, whatever revision the request quotes.
    Object.assign(body, propertyPatch);

    // Optimistic-concurrency baseline of the body. A node we've loaded /
    // synced has a seeded rev; a brand-new node (no entry) sends the
    // empty-content rev so its create only lands while no `.md` exists yet
    // on the server. The web sends this uniformly for every md-backed node
    // whose request carries more than properties; the server applies rev-CAS
    // for authored bodies; derived body-only edits remain last-write-wins —
    // `bodyOwnership` in the preprocessing profiles is the single source
    // of truth, so the client need not know the classification.
    if (!propertyOnly) body.expectRev = baselineRev.get(nodeId) ?? REV_EMPTY;
    if (opts.pageId) body.pageId = opts.pageId;

    return { body, propertyOnly };
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
  ): Promise<boolean> {
    if (
      opts.getState().canvasId !== canvasId ||
      suspendedCanvases.has(canvasId)
    )
      return false;
    const generation = generations.get(nodeId);
    await opts.waitForCreation?.(canvasId, nodeId);
    if (
      opts.getState().canvasId !== canvasId ||
      generations.get(nodeId) !== generation
    )
      return false;
    let identicalSettled = false;
    while (true) {
      if (suspendedCanvases.has(canvasId)) return false;
      const requested = new Map(pendingFields.get(nodeId));
      const request = buildRequest(nodeId, new Set(requested.keys()));
      if (!request) return false;
      const { body, propertyOnly } = request;
      // A request of properties alone settles those fields and no others.
      if (propertyOnly) {
        for (const key of [...requested.keys()])
          if (!PROPERTY_FIELDS.has(key)) requested.delete(key);
      }
      const sentPropertyKeys = new Map(
        body.properties ? pendingPropertyKeys.get(nodeId) : undefined,
      );
      /** The property fields of this request are on the server. */
      const settleProperties = (): void => {
        const pendingKeys = pendingPropertyKeys.get(nodeId);
        for (const [key, token] of sentPropertyKeys) {
          if (pendingKeys?.get(key) === token) pendingKeys.delete(key);
        }
        if (pendingKeys?.size === 0) pendingPropertyKeys.delete(nodeId);
        const livePending = pendingFields.get(nodeId);
        for (const key of PROPERTY_FIELDS) {
          const token = requested.get(key);
          if (!token || livePending?.get(key) !== token) continue;
          // A key changed again while the request was on the wire.
          if (key === 'properties' && pendingPropertyKeys.has(nodeId)) continue;
          livePending.delete(key);
        }
        if (livePending?.size === 0) pendingFields.delete(nodeId);
      };
      const sentNode = opts.getState().nodes.find((node) => node.id === nodeId);
      const baselineAtRequest = baselineGeneration.get(nodeId);
      let response: PutNodeContentResponse;
      try {
        response = await putNodeContent(canvasId, nodeId, body, kOpts);
      } catch (error) {
        if (
          error instanceof CanvasConflictError &&
          error.code === 'NODE_CONTENT_CONFLICT'
        ) {
          // The body was refused; the property patch beside it was written.
          if (error.propertiesApplied) settleProperties();
          if (baselineGeneration.get(nodeId) !== baselineAtRequest) {
            continue;
          } else if (
            !propertyOnly &&
            !identicalSettled &&
            !kOpts?.keepalive &&
            sentNode &&
            (await serverHoldsSameContent(
              canvasId,
              nodeId,
              generation,
              sentNode,
              error.currentRev,
            ))
          ) {
            // The server already holds exactly this content: nothing was
            // overwritten and nothing would be. Its revision is the
            // baseline now; send once more so the fields the revision does
            // not cover (title, summary) are saved too.
            identicalSettled = true;
            continue;
          }
        }
        throw error;
      }
      if (
        opts.getState().canvasId !== canvasId ||
        generations.get(nodeId) !== generation ||
        !opts.getState().nodes.some((node) => node.id === nodeId)
      )
        return false;
      if (propertyOnly) {
        // Properties have no baseline: the body's revision, its failure
        // record and a conflict freeze are as they were. The answer names
        // the revision of the body the server holds, which is not
        // necessarily the body this page shows.
        settleProperties();
        if (!frozen.has(nodeId)) {
          failures.delete(nodeId);
          dismissFailureToast(nodeId);
          saveErrorToasted.delete(nodeId);
          if (pendingFields.get(nodeId)?.size) schedule(canvasId, nodeId);
          else opts.onContentPersisted?.(canvasId, nodeId);
        }
        return true;
      }
      if (baselineGeneration.get(nodeId) !== baselineAtRequest) continue;
      settleProperties();

      // Content and its baseline update together: record the rev the server
      // actually persisted so the next edit's `expectRev` is fresh (and a
      // rapid follow-up edit doesn't 409 against our own just-committed
      // write). Also clear any content-conflict toast guard — a success
      // means the node is no longer blocked.
      baselineRev.set(nodeId, response.rev);
      baselineGeneration.set(nodeId, {});
      const livePending = pendingFields.get(nodeId);
      for (const [key, token] of requested) {
        if (PROPERTY_FIELDS.has(key)) continue;
        if (livePending?.get(key) === token) livePending.delete(key);
      }
      if (livePending?.size === 0) pendingFields.delete(nodeId);
      const completedRestore = restoredContent.delete(nodeId);
      failures.delete(nodeId);
      dismissFailureToast(nodeId);
      contentConflictToasted.delete(nodeId);
      saveErrorToasted.delete(nodeId);
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
      if (!currentNode) return false;
      const currentLabel =
        typeof currentNode.data?.['label'] === 'string'
          ? (currentNode.data['label'] as string)
          : null;
      if (response.label !== null && response.label !== currentLabel) {
        state._setStateRaw({
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
      if (pendingFields.get(nodeId)?.size) schedule(canvasId, nodeId);
      else opts.onContentPersisted?.(canvasId, nodeId);
      if (completedRestore && !suspendedCanvases.has(canvasId))
        opts.onRestoredContentPersisted?.(canvasId, nodeId);
      return true;
    }
  }

  /**
   * Surface a `NODE_CONTENT_CONFLICT`: the node's content changed on the
   * server since we loaded it (another tab / device / agent, or a
   * Google-Drive-synced newer copy), so our write was refused to avoid
   * clobbering the newer content. The user's in-editor text is left
   * untouched.
   *
   * The node is **frozen** ({@link buildRequest} now returns `null` for
   * it), so no further write path — debounced autosave, `flushNow`, or
   * the `beforeunload` keepalive — can PUT it. That is what makes the
   * "Load latest" refresh genuinely safe: while frozen we can never leak
   * our stale version onto disk.
   *
   * The user gets a real two-way choice:
   *   - **Keep mine** — re-baseline to the on-disk rev and force the
   *     overwrite (deliberately replaces the server's version with ours).
   *   - **Load latest** — copy our in-app text to the clipboard as a
   *     safety net, then refetch just this node's server state and adopt
   *     it in place (no full page reload). Our unsaved in-app edit is
   *     discarded, but recoverable from the clipboard.
   */
  function handleContentConflict(nodeId: string, currentRev: string): void {
    // Freeze regardless of the once-per-node toast guard, so a repeat
    // conflict can't leave the node writable.
    frozen.set(nodeId, currentRev);
    if (contentConflictToasted.has(nodeId)) return;
    contentConflictToasted.add(nodeId);
    const state = opts.getState();
    const node = state.nodes.find((n) => n.id === nodeId);
    const label =
      node && typeof node.data?.['label'] === 'string'
        ? (node.data['label'] as string)
        : i18n.t('node.untitled');
    const generation = generations.get(nodeId);
    dismissFailureToast(nodeId);
    showFailureRecovery(nodeId, () => {
      const toastId = toast(i18n.t('node.contentConflict', { label }), {
        tone: 'danger',
        duration: 0,
        secondaryAction: {
          label: i18n.t('node.contentConflictKeepMine'),
          onClick: () => {
            if (generations.get(nodeId) !== generation) return;
            void resolveKeepMine(nodeId);
          },
        },
        action: {
          label: i18n.t('node.contentConflictLoadLatest'),
          onClick: () => {
            if (generations.get(nodeId) !== generation) return;
            void resolveLoadLatest(nodeId);
          },
        },
      });
      failureToasts.set(nodeId, toastId);
    });
    console.warn('[node-content] write refused (stale content):', nodeId);
  }

  /**
   * Resolve a content conflict by keeping the local version: adopt the
   * on-disk rev we collided with as the new baseline, unfreeze, and force
   * an immediate write so our content deliberately overwrites the other
   * change. If the disk moved again in the meantime the write re-conflicts
   * and re-freezes (correct — the user can decide again).
   */
  async function resolveKeepMine(nodeId: string): Promise<void> {
    const currentRev = frozen.get(nodeId);
    if (currentRev !== undefined) baselineRev.set(nodeId, currentRev);
    frozen.delete(nodeId);
    contentConflictToasted.delete(nodeId);
    const canvasId = opts.getState().canvasId;
    if (!canvasId) return;
    await serializedFlush(canvasId, nodeId, 'user').catch(() => undefined);
  }

  /**
   * Resolve a content conflict by discarding the local version and
   * adopting the server's — without a full page reload. Copies our
   * in-app text to the clipboard as a safety net, refetches just this
   * node's persisted sidecar, and swaps it into the store in place.
   *
   * The refreshed content is written through `_setStateRaw`, so
   * adopting it cannot schedule a redundant PUT back; the node is then
   * re-baselined to the returned server rev and unfrozen so the next
   * user edit is checked against the version we just adopted. The open
   * editor picks up the new `data.content` via its external-update
   * reconcile (`setMarkdown`), exactly like an agent/realtime write.
   *
   * If the refetch fails the node stays **frozen** (still safe — a stale
   * version can never leak onto disk) and the user is asked to retry.
   */
  async function resolveLoadLatest(nodeId: string): Promise<void> {
    const state = opts.getState();
    const canvasId = state.canvasId;
    const cur = state.nodes.find((n) => n.id === nodeId);
    const localText =
      cur && typeof cur.data?.['content'] === 'string'
        ? (cur.data['content'] as string)
        : '';
    // Safety net first: preserve the discarded edit on the clipboard
    // before we overwrite it with the server's version.
    if (localText) await copyToClipboard(localText).catch(() => undefined);
    if (!canvasId) return;

    const res = await getNodeContent(canvasId, nodeId);
    if (!res) {
      // Keep the node frozen (still safe) and let the user retry.
      toast(i18n.t('node.contentConflictLoadFailed'), {
        tone: 'danger',
        duration: 0,
      });
      return;
    }

    // Overlay only the content-owned keys; UI / geometry fields stay
    // untouched. `_setStateRaw` skips the content diff so adopting
    // the server state never schedules a PUT back onto disk.
    const nextNodes = opts.getState().nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            data: {
              ...(n.data ?? {}),
              content: res.content,
              label: res.label,
              labelSource: res.labelSource,
              src: res.src,
              summary: res.summary,
              keywords: res.keywords,
              properties: res.properties,
              propertyDisplayKeys: res.propertyDisplayKeys,
              contentMissing: res.contentMissing ?? false,
              artifactMissing: res.artifactMissing ?? false,
              contentDuplicate: res.contentDuplicate ?? false,
              duplicateFiles: res.duplicateFiles ?? [],
            },
          }
        : n,
    );
    opts.getState()._setStateRaw({ nodes: nextNodes });

    // Re-baseline to the server rev and unfreeze so editing resumes.
    baselineRev.set(nodeId, res.rev);
    lastSuccessful.set(nodeId, {
      label: res.label,
      labelSource: res.labelSource,
    });
    frozen.delete(nodeId);
    contentConflictToasted.delete(nodeId);
    toast(i18n.t('node.contentConflictLoaded'), { tone: 'success' });
    restoredContent.delete(nodeId);
    failures.delete(nodeId);
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
    const generation = generations.get(nodeId);
    try {
      if (opts.getState().canvasId !== canvasId) {
        throw new Error(`Content save Canvas changed: ${canvasId}`);
      }
      await performSave(canvasId, nodeId, kOpts);
    } catch (err) {
      if (
        opts.getState().canvasId !== canvasId ||
        generations.get(nodeId) !== generation
      )
        return;
      // A node frozen by a body conflict only sends its properties. When
      // that fails, the conflict and its toast stay the record of the node:
      // the properties are still queued and go out with the next save.
      if (
        frozen.has(nodeId) &&
        !(
          err instanceof CanvasConflictError &&
          err.code === 'NODE_CONTENT_CONFLICT'
        )
      ) {
        console.error('Node property save failed:', nodeId, err);
        throw err;
      }
      failures.set(nodeId, { canvasId, error: err });
      if (err instanceof NodeDuplicateFilesError) {
        notifyDuplicate(nodeId, err);
        throw err;
      }
      if (err instanceof CanvasConflictError) {
        // A content-revision conflict is NOT a rename collision: the
        // node changed on the server since we loaded it (another tab /
        // device / agent, or a Drive-synced newer copy). Do NOT revert
        // or retry — keep the user's text and stop writing so we never
        // clobber the newer server content. Surface a one-per-node
        // "reload to get the latest" prompt; the baseline stays stale so
        // further autosaves keep being refused until the user reloads.
        if (err.code === 'NODE_CONTENT_CONFLICT') {
          handleContentConflict(nodeId, err.currentRev ?? REV_EMPTY);
          return;
        }
        throw err;
      }
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
    dismissFailureToast(nodeId);
    showFailureRecovery(nodeId, () => {
      failureToasts.set(
        nodeId,
        toast(err.message, { tone: 'danger', duration: 0, dismissible: true }),
      );
    });
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
    const state = opts.getState();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return; // node was deleted mid-flight — nothing to do

    const data = (node.data ?? {}) as Record<string, unknown>;
    const currentLabel =
      typeof data['label'] === 'string' ? (data['label'] as string) : null;
    const lastGood = lastSuccessful.get(nodeId);
    const permissionDenied = err instanceof ApiError && err.status === 403;
    const failureMessage = (name: string) =>
      permissionDenied
        ? i18n.t('errors.spaceSaveAccessDenied')
        : i18n.t('errors.nodeSaveFailed', { name });

    // Rename failure: we have a previously-persisted label AND the
    // store's label drifted away from it. Roll back the label only —
    // preserve content / src / summary so the user's other edits
    // survive. labelSource is restored to whatever was attached to
    // the last successful PUT (or stripped entirely if none).
    if (lastGood && lastGood.label !== currentLabel) {
      state._setStateRaw({
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
      surfaceSaveError(
        canvasId,
        nodeId,
        failureMessage(lastGood.label ?? i18n.t('node.untitled')),
        source,
        !permissionDenied,
      );
      console.error('Node rename failed; reverted:', nodeId, err);
      return;
    }

    // Content-only failure (or first-ever write with no last-good
    // anchor to revert to): toast (user path) or log (auto path); the
    // in-store body is left alone so the user's typing isn't lost.
    surfaceSaveError(
      canvasId,
      nodeId,
      failureMessage(currentLabel || i18n.t('node.untitled')),
      source,
      !permissionDenied,
    );
    console.error('Node content save failed:', nodeId, err);
  }

  /**
   * Surface a genuine (non-conflict) save failure with a persistent,
   * dismissible toast carrying a **Retry** action. The in-store body /
   * label are still intact after a failure, so Retry simply re-flushes the
   * node's pending content (as a user-initiated write). Background (`auto`)
   * failures are throttled to once per node (see {@link saveErrorToasted});
   * user-initiated failures always toast since the user expects feedback.
   */
  function surfaceSaveError(
    canvasId: string,
    nodeId: string,
    message: string,
    source: 'user' | 'auto',
    retryable = true,
  ): void {
    if (saveErrorsHandledByCaller()) return;
    if (source === 'auto' && saveErrorToasted.has(nodeId)) return;
    saveErrorToasted.add(nodeId);
    const generation = generations.get(nodeId);
    dismissFailureToast(nodeId);
    const toastId = toast(message, {
      tone: 'danger',
      duration: 0,
      dismissible: true,
      action: retryable
        ? {
            label: i18n.t('messages.retry'),
            onClick: () => {
              if (generations.get(nodeId) !== generation) return;
              // Allow a later failure to re-alert, then re-attempt the write.
              saveErrorToasted.delete(nodeId);
              // A node whose restoring batch failed is sent again first;
              // the save below waits for it. (A body still held for a
              // restore is not written by the flush; its release does that.)
              opts.retryCreation?.(canvasId, nodeId);
              void serializedFlush(canvasId, nodeId, 'user').catch(
                () => undefined,
              );
            },
          }
        : undefined,
    });
    failureToasts.set(nodeId, toastId);
  }

  /** Nodes another page saved while this page held unsaved content for them. */
  const remoteWhileUnsaved = new Set<string>();
  /** Fetches under way, and whether another save arrived meanwhile. */
  const remoteFetches = new Map<
    string,
    { again: boolean; done: Promise<RemoteContentOutcome> }
  >();

  /** Content of `nodeId` the server has not acknowledged from this page. */
  function hasUnsavedLocalContent(nodeId: string): boolean {
    return (
      inflight.has(nodeId) ||
      pendingFields.has(nodeId) ||
      restoredContent.has(nodeId) ||
      restores.has(nodeId) ||
      frozen.has(nodeId) ||
      failures.has(nodeId) ||
      debouncer.pendingKeys().includes(nodeId)
    );
  }

  /**
   * Show the server's content of `nodeId` and take its revision as the
   * baseline, in one step. `patch` is what differs from the node's data.
   * Returns whether the node changed.
   */
  function installRemoteContent(
    canvasId: string,
    nodeId: string,
    res: GetNodeContentResponse,
    patch: Record<string, unknown>,
  ): boolean {
    const state = opts.getState();
    const changed = Object.keys(patch).length > 0;
    if (changed) {
      state._setStateRaw({
        nodes: state.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: withContentPatch(n.data, patch) } : n,
        ),
      });
    }
    // Content and its baseline move together, as on every other path.
    baselineRev.set(nodeId, res.rev);
    baselineGeneration.set(nodeId, {});
    lastSuccessful.set(nodeId, {
      label: res.label,
      labelSource: res.labelSource,
    });
    if (propertySaves.has(nodeId)) remoteDuringPropertySave.add(nodeId);
    if (changed) opts.onRemoteContentAdopted?.(canvasId, nodeId, patch);
    return changed;
  }

  /**
   * Show the server's custom properties of a node whose body this page
   * keeps: its text, title and baseline are not touched. A property key this
   * page changed and has not saved keeps the value it has here, and so does
   * the display order when this page changed that. Returns whether the node
   * changed.
   */
  function installRemoteProperties(
    canvasId: string,
    nodeId: string,
    res: GetNodeContentResponse,
  ): boolean {
    if (res.contentMissing) return false;
    const state = opts.getState();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const local = data['properties'] as NodeProperties | undefined;
    const patch: Record<string, unknown> = {};

    let properties = res.properties;
    const unsavedKeys = pendingPropertyKeys.get(nodeId);
    if (unsavedKeys?.size) {
      const merged: NodeProperties = { ...res.properties };
      for (const key of unsavedKeys.keys()) {
        if (local && Object.hasOwn(local, key)) setOwn(merged, key, local[key]);
        else delete merged[key];
      }
      properties =
        Object.keys(merged).length > 0 || local !== undefined
          ? merged
          : undefined;
    }
    if (!sameValue(local, properties)) patch['properties'] = properties;
    if (
      !pendingFields.get(nodeId)?.has('propertyDisplayKeys') &&
      !sameValue(data['propertyDisplayKeys'], res.propertyDisplayKeys)
    )
      patch['propertyDisplayKeys'] = res.propertyDisplayKeys;

    if (propertySaves.has(nodeId)) remoteDuringPropertySave.add(nodeId);
    if (Object.keys(patch).length === 0) return false;
    state._setStateRaw({
      nodes: state.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: withContentPatch(n.data, patch) } : n,
      ),
    });
    opts.onRemoteContentAdopted?.(canvasId, nodeId, patch);
    return true;
  }

  /** Take `rev` as the baseline of a node whose content equals the server's. */
  function adoptIdenticalBaseline(nodeId: string, rev: string): void {
    baselineRev.set(nodeId, rev);
    baselineGeneration.set(nodeId, {});
  }

  /**
   * A save of `sent` was refused as stale. Whether the server nevertheless
   * holds exactly that content (two writers arrived at the same text): by
   * the revision the refusal names, or else by fetching the node. When it
   * does, its revision is taken as the baseline and `true` is returned; the
   * node is not frozen and nobody is told.
   */
  async function serverHoldsSameContent(
    canvasId: string,
    nodeId: string,
    generation: object | undefined,
    sent: Node,
    currentRev: string | undefined,
  ): Promise<boolean> {
    if (currentRev !== undefined && currentRev === revOfNode(sent)) {
      adoptIdenticalBaseline(nodeId, currentRev);
      return true;
    }
    let res: GetNodeContentResponse | null;
    try {
      res = await getNodeContent(canvasId, nodeId);
    } catch {
      return false;
    }
    const state = opts.getState();
    const live = state.nodes.find((n) => n.id === nodeId);
    if (
      !res ||
      !live ||
      state.canvasId !== canvasId ||
      suspendedCanvases.has(canvasId) ||
      generations.get(nodeId) !== generation ||
      !showsServerContent(live, res)
    )
      return false;
    adoptIdenticalBaseline(nodeId, res.rev);
    return true;
  }

  /**
   * End the freeze of a node whose content turned out to equal the
   * server's: no toast, the server's revision as the baseline, the text
   * untouched. Fields the revision does not cover that are still unsaved (a
   * title, a summary, a property) go out with the next save, which is
   * scheduled here.
   */
  function settleIdenticalConflict(
    canvasId: string,
    nodeId: string,
    rev: string,
  ): void {
    frozen.delete(nodeId);
    contentConflictToasted.delete(nodeId);
    dismissFailureToast(nodeId);
    failures.delete(nodeId);
    adoptIdenticalBaseline(nodeId, rev);
    // What the revision covers is on the server as this page shows it.
    const pending = pendingFields.get(nodeId);
    for (const key of CONTENT_REVISION_KEYS) pending?.delete(key);
    if (pending?.size) {
      schedule(canvasId, nodeId);
    } else {
      pendingFields.delete(nodeId);
      debouncer.cancel(nodeId);
      opts.onContentPersisted?.(canvasId, nodeId);
    }
  }

  /** Checks of a frozen node against the server under way. */
  const frozenChecks = new Map<string, Promise<RemoteContentOutcome>>();

  /**
   * Another page saved a node that is frozen here. Fetch it: identical
   * content settles the conflict; anything else leaves the node frozen and
   * moves the revision **Keep mine** will overwrite on to the fetched one.
   */
  function checkFrozenAgainstServer(
    canvasId: string,
    nodeId: string,
  ): Promise<RemoteContentOutcome> {
    const running = frozenChecks.get(nodeId);
    if (running) return running;
    const generation = generations.get(nodeId);
    const check = (async (): Promise<RemoteContentOutcome> => {
      const res = await getNodeContent(canvasId, nodeId);
      const state = opts.getState();
      const node = state.nodes.find((n) => n.id === nodeId);
      if (
        !node ||
        state.canvasId !== canvasId ||
        suspendedCanvases.has(canvasId) ||
        generations.get(nodeId) !== generation
      )
        return 'absent';
      if (!frozen.has(nodeId) || !res || res.contentMissing)
        return 'kept-local';
      // The conflict is about the body. The other save's properties are
      // shown whichever way it ends.
      installRemoteProperties(canvasId, nodeId, res);
      if (inflight.has(nodeId) || !showsServerContent(node, res)) {
        frozen.set(nodeId, res.rev);
        return 'kept-local';
      }
      settleIdenticalConflict(canvasId, nodeId, res.rev);
      return 'unchanged';
    })()
      .catch((error: unknown): RemoteContentOutcome => {
        console.error('[node-content] conflict check failed:', nodeId, error);
        return 'kept-local';
      })
      .finally(() => {
        if (frozenChecks.get(nodeId) === check) frozenChecks.delete(nodeId);
      });
    frozenChecks.set(nodeId, check);
    return check;
  }

  async function fetchRemoteContent(
    canvasId: string,
    nodeId: string,
    entry: { again: boolean },
  ): Promise<RemoteContentOutcome> {
    for (;;) {
      entry.again = false;
      const generation = generations.get(nodeId);
      const res = await getNodeContent(canvasId, nodeId);
      const state = opts.getState();
      if (state.canvasId !== canvasId || suspendedCanvases.has(canvasId))
        return 'absent';
      const node = state.nodes.find((n) => n.id === nodeId);
      if (!node || generations.get(nodeId) !== generation) return 'absent';
      if (hasUnsavedLocalContent(nodeId)) {
        // This page has a body of its own for the node (also when the
        // person started typing while the fetch was under way): the text
        // stays, and the whole node is fetched after its save. The other
        // save's properties do not overlap it and are shown now.
        remoteWhileUnsaved.add(nodeId);
        if (res) installRemoteProperties(canvasId, nodeId, res);
        if (entry.again) continue;
        return 'kept-local';
      }
      if (!res) {
        if (entry.again) continue;
        return 'failed';
      }
      // A sidecar that is gone belongs to a deletion; the structure update
      // removes the node, and an absent body is never adopted as an empty one.
      if (res.contentMissing) {
        if (entry.again) continue;
        return 'absent';
      }
      const data = (node.data ?? {}) as Record<string, unknown>;
      const patch = remoteContentPatch(node.type ?? '', data, res);
      const changed = installRemoteContent(canvasId, nodeId, res, patch);
      if (entry.again) continue;
      return changed ? 'applied' : 'unchanged';
    }
  }

  function adoptRemoteContent(
    canvasId: string,
    nodeId: string,
  ): Promise<RemoteContentOutcome> {
    const state = opts.getState();
    if (
      !canvasId ||
      state.canvasId !== canvasId ||
      suspendedCanvases.has(canvasId)
    )
      return Promise.resolve('absent');
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || !MD_BACKED_NODE_TYPES.has(node.type ?? ''))
      return Promise.resolve('absent');
    if (hasUnsavedLocalContent(nodeId)) {
      remoteWhileUnsaved.add(nodeId);
      // A conflict the user has not answered is over when the other save
      // left exactly the text this page shows.
      if (frozen.has(nodeId) && !inflight.has(nodeId))
        return checkFrozenAgainstServer(canvasId, nodeId);
      // Otherwise the fetch below brings the other save's properties only.
    }
    const running = remoteFetches.get(nodeId);
    if (running) {
      // One fetch per node at a time; a save that lands during it is read
      // by one more fetch, however many arrive.
      running.again = true;
      return running.done;
    }
    const entry = {
      again: false,
      done: Promise.resolve<RemoteContentOutcome>('absent'),
    };
    entry.done = fetchRemoteContent(canvasId, nodeId, entry)
      .catch((error: unknown): RemoteContentOutcome => {
        console.error('[node-content] remote refresh failed:', nodeId, error);
        return 'failed';
      })
      .finally(() => {
        if (remoteFetches.get(nodeId) === entry) remoteFetches.delete(nodeId);
      });
    remoteFetches.set(nodeId, entry);
    return entry.done;
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
    if (!generations.has(nodeId)) generations.set(nodeId, {});
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
        // Another page saved this node while ours was unsaved. Once the
        // server has taken ours, pick up what that save left besides it.
        if (
          remoteWhileUnsaved.has(nodeId) &&
          !hasUnsavedLocalContent(nodeId) &&
          remoteWhileUnsaved.delete(nodeId)
        )
          void adoptRemoteContent(canvasId, nodeId);
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * One {@link NodeContentQueue.commitProperties} save: the edit's keys and
   * display order, sent by themselves without a revision, and put into the
   * store once the server has answered. Throws when it was not saved.
   */
  async function performPropertySave(
    canvasId: string,
    nodeId: string,
    edit: PropertyEdit,
  ): Promise<void> {
    const unavailable = (): boolean => {
      const state = opts.getState();
      const node = state.nodes.find((item) => item.id === nodeId);
      return (
        state.canvasId !== canvasId ||
        !node ||
        state.isLoading ||
        suspendedCanvases.has(canvasId) ||
        restores.has(nodeId) ||
        node.data.contentMissing === true ||
        !MD_BACKED_NODE_TYPES.has(node.type ?? '')
      );
    };
    if (unavailable())
      throw new Error('Node is not available for property editing');
    const generation = generations.get(nodeId);
    await opts.waitForCreation?.(canvasId, nodeId);
    // A node this page created and has not saved yet has no sidecar to
    // patch: its first save, which is still queued, goes out before the
    // edit, and the edit is not made when that fails. (A patch that created
    // the sidecar itself would leave an empty body there, and the first
    // save would then be refused as a create race.)
    const unsavedCreation = (): boolean =>
      !baselineRev.has(nodeId) && pendingFields.has(nodeId);
    if (unsavedCreation() && !unavailable()) {
      debouncer.cancel(nodeId);
      await serializedFlush(canvasId, nodeId, 'auto').catch(() => undefined);
    }
    if (
      unavailable() ||
      generations.get(nodeId) !== generation ||
      unsavedCreation()
    )
      throw new Error('Property edit was not saved');

    const sent = opts.getState().nodes.find((node) => node.id === nodeId);
    const body: PutNodeContentRequest = {
      nodeType: sent?.type ?? '',
      ...(edit.properties ? { properties: edit.properties } : {}),
      ...(edit.propertyDisplayKeys
        ? { propertyDisplayKeys: edit.propertyDisplayKeys }
        : {}),
      ...(opts.pageId ? { pageId: opts.pageId } : {}),
    };
    try {
      // The answer names the revision of the body the server holds. It is
      // not a baseline: this page may show another body.
      await putNodeContent(canvasId, nodeId, body);
    } catch (error) {
      if (
        error instanceof NodeDuplicateFilesError &&
        opts.getState().canvasId === canvasId &&
        generations.get(nodeId) === generation
      )
        notifyDuplicate(nodeId, error);
      throw error;
    }

    const state = opts.getState();
    const live = state.nodes.find((node) => node.id === nodeId);
    if (
      state.canvasId !== canvasId ||
      generations.get(nodeId) !== generation ||
      !live
    )
      throw new Error('Property edit was not saved');
    // Publish the keys this page has not changed again meanwhile.
    const previous = sent?.data.properties as NodeProperties | undefined;
    const current = live.data.properties as NodeProperties | undefined;
    const patch: PropertyEdit = {};
    if (edit.properties)
      patch.properties = Object.fromEntries(
        Object.entries(edit.properties).filter(([key]) =>
          deepEqual(current?.[key], previous?.[key]),
        ),
      );
    if (
      edit.propertyDisplayKeys &&
      deepEqual(live.data.propertyDisplayKeys, sent?.data.propertyDisplayKeys)
    )
      patch.propertyDisplayKeys = edit.propertyDisplayKeys;
    // The store change below is the acknowledged edit, not a new one: it
    // must not be queued as unsaved properties.
    publishingProperties = nodeId;
    try {
      if (opts.onPropertiesSaved) opts.onPropertiesSaved(nodeId, patch);
      else
        state._setStateRaw({
          nodes: state.nodes.map((node) =>
            node.id !== nodeId
              ? node
              : {
                  ...node,
                  data: {
                    ...node.data,
                    ...(patch.properties
                      ? {
                          properties: mergeNodeProperties(
                            current,
                            patch.properties,
                          ),
                        }
                      : {}),
                    ...(patch.propertyDisplayKeys
                      ? { propertyDisplayKeys: patch.propertyDisplayKeys }
                      : {}),
                  },
                },
          ),
        });
    } finally {
      publishingProperties = undefined;
    }
  }

  /**
   * Chain a property save behind the node's earlier ones, so two edits of
   * one key from this page reach the server in the order they were made.
   * The body's lane ({@link serializedFlush}) is separate.
   */
  function serializedPropertySave(
    canvasId: string,
    nodeId: string,
    edit: PropertyEdit,
  ): Promise<void> {
    if (!generations.has(nodeId)) generations.set(nodeId, {});
    const prev = propertySaves.get(nodeId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => performPropertySave(canvasId, nodeId, edit));
    propertySaves.set(nodeId, next);
    void next
      .finally(() => {
        if (propertySaves.get(nodeId) !== next) return;
        propertySaves.delete(nodeId);
        // Properties fetched while the save was under way may predate it or
        // follow it. Read the node once more: what the server holds is what
        // the last writer of each key left.
        if (remoteDuringPropertySave.delete(nodeId))
          void adoptRemoteContent(canvasId, nodeId);
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
    if (!canvasId || !nodeId || suspendedCanvases.has(canvasId)) return;
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
    commitProperties(canvasId, nodeId, patch) {
      return serializedPropertySave(canvasId, nodeId, patch);
    },
    prepareServerCreatedNodes(nodes) {
      for (const node of nodes) {
        if (!MD_BACKED_NODE_TYPES.has(node.type ?? '')) continue;
        suppressNextNewNodeSave.add(node.id);
        baselineRev.set(node.id, revOfNode(node));
        baselineGeneration.set(node.id, {});
      }
    },

    holdRestoredNodes(canvasId, nodes) {
      for (const node of nodes) {
        if (!MD_BACKED_NODE_TYPES.has(node.type ?? '')) continue;
        const token = {};
        generations.set(node.id, token);
        restores.set(node.id, { canvasId, token });
        restoredContent.set(node.id, canvasId);
        debouncer.cancel(node.id);
      }
    },

    restoreTokens() {
      return new Map(
        [...restores]
          .filter(([, entry]) => entry.canvasId === opts.getState().canvasId)
          .map(([id, entry]) => [id, entry.token]),
      );
    },

    acknowledgeRestores(canvasId, tokens) {
      if (
        opts.getState().canvasId !== canvasId ||
        suspendedCanvases.has(canvasId)
      )
        return;
      for (const [id, token] of tokens) {
        const entry = restores.get(id);
        if (entry?.canvasId !== canvasId || entry.token !== token) continue;
        const node = opts.getState().nodes.find((n) => n.id === id);
        if (!node) continue;
        restores.delete(id);
        // The deletion has settled. Only this resurrection starts from an
        // absent sidecar; ordinary edits retain their authoritative baseline.
        baselineRev.delete(id);
        frozen.delete(id);
        if (
          node.data?.contentMissing === true ||
          (TEXT_BEARING_NODE_TYPES.has(node.type ?? '') &&
            !SERVER_DERIVED_SIDECAR_NODE_TYPES.has(node.type ?? '') &&
            typeof node.data?.content !== 'string')
        ) {
          restoredContent.delete(id);
          opts.getState().patchNodeSilent(id, { contentMissing: true });
          continue;
        }
        debouncer.cancel(id);
        void serializedFlush(canvasId, id, 'auto').catch(() => undefined);
      }
    },

    hasRestore: (nodeId) => restores.has(nodeId),
    hasPendingRestoredContent: (nodeId) =>
      nodeId === undefined
        ? [...restoredContent.values()].includes(opts.getState().canvasId)
        : restoredContent.get(nodeId) === opts.getState().canvasId,

    async waitForIdle() {
      await Promise.all(
        [...inflight.values(), ...propertySaves.values()].map((p) =>
          p.catch(() => undefined),
        ),
      );
    },

    scheduleChanges(canvasId, prevNodes, nextNodes) {
      if (!canvasId || prevNodes === nextNodes) return;
      const prevById = new Map(prevNodes.map((n) => [n.id, n]));
      for (const next of nextNodes) {
        const nodeType = typeof next.type === 'string' ? next.type : '';
        if (!MD_BACKED_NODE_TYPES.has(nodeType)) continue;
        const before = prevById.get(next.id);
        if (!before) {
          if (suppressNextNewNodeSave.delete(next.id)) continue;
          // Brand new node — its `.md` does not exist yet.
          pendingFields.set(
            next.id,
            new Map([...NODE_CONTENT_KEYS].map((key) => [key, {}])),
          );
          const created = Object.keys(
            ((next.data ?? {}) as Record<string, unknown>)['properties'] ?? {},
          );
          if (created.length > 0)
            pendingPropertyKeys.set(
              next.id,
              new Map(created.map((key) => [key, {}])),
            );
          schedule(canvasId, next.id);
          continue;
        }
        if (before.data === next.data) continue;
        const beforeData = (before.data ?? {}) as Record<string, unknown>;
        const afterData = (next.data ?? {}) as Record<string, unknown>;
        for (const key of NODE_CONTENT_KEYS) {
          if (PROPERTY_FIELDS.has(key)) {
            // An acknowledged property edit being published is saved already.
            if (publishingProperties === next.id) continue;
            if (key === 'properties') {
              // Per key: only what changed here is unsaved, and only that
              // is sent.
              const changed = changedPropertyKeys(
                beforeData[key],
                afterData[key],
              );
              if (changed.length === 0) continue;
              const keys =
                pendingPropertyKeys.get(next.id) ?? new Map<string, object>();
              for (const changedKey of changed) keys.set(changedKey, {});
              pendingPropertyKeys.set(next.id, keys);
            } else if (deepEqual(beforeData[key], afterData[key])) continue;
          }
          if (beforeData[key] !== afterData[key]) {
            const fields =
              pendingFields.get(next.id) ??
              new Map<string, { removed?: boolean }>();
            fields.set(key, {
              removed:
                beforeData[key] !== undefined && afterData[key] === undefined,
            });
            pendingFields.set(next.id, fields);
            schedule(canvasId, next.id);
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

    retryFailedSaves(canvasId) {
      const state = opts.getState();
      if (state.canvasId !== canvasId || state.isLoading) return;
      const nodeIds = new Set(state.nodes.map((node) => node.id));
      const pendingIds = new Set(debouncer.pendingKeys());
      for (const [nodeId, failure] of failures) {
        if (
          failure.canvasId === canvasId &&
          nodeIds.has(nodeId) &&
          (!(failure.error instanceof CanvasConflictError) ||
            failure.error.code === 'NODE_LABEL_CONFLICT') &&
          !(failure.error instanceof NodeDuplicateFilesError) &&
          !inflight.has(nodeId) &&
          !pendingIds.has(nodeId)
        ) {
          opts.retryCreation?.(canvasId, nodeId);
          schedule(canvasId, nodeId);
        }
      }
    },

    async flushAll() {
      const canvasId = opts.getState().canvasId;
      const pendingIds = debouncer.cancelAll();
      for (const nodeId of pendingIds) {
        void serializedFlush(canvasId, nodeId, 'auto').catch(() => undefined);
      }
      await Promise.all(
        [...inflight.values(), ...propertySaves.values()].map((p) =>
          p.catch(() => undefined),
        ),
      );
    },

    async flushAllForSubmission(canvasId) {
      // Navigation drains the outgoing Space; never flush the new Space for it.
      while (opts.getState().canvasId === canvasId) {
        await this.flushAll();
        if (
          debouncer.pendingKeys().length === 0 &&
          inflight.size === 0 &&
          propertySaves.size === 0
        )
          break;
      }
      const state = opts.getState();
      const nodeIds =
        state.canvasId === canvasId && !state.isLoading
          ? new Set(state.nodes.map((node) => node.id))
          : undefined;
      const errors = Array.from(failures.entries())
        .filter(
          ([nodeId, failure]) =>
            failure.canvasId === canvasId && (!nodeIds || nodeIds.has(nodeId)),
        )
        .map(
          ([nodeId, failure]) =>
            new Error(`Content save failed: ${nodeId}`, {
              cause: failure.error,
            }),
        );
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `Content saves failed for Canvas ${canvasId}`,
        );
      }
    },

    discardCanvas(canvasId) {
      const state = opts.getState();
      const ids = new Set(
        state.canvasId === canvasId ? state.nodes.map((node) => node.id) : [],
      );
      for (const [id, failure] of failures) {
        if (failure.canvasId === canvasId) ids.add(id);
      }
      for (const [id, owner] of restoredContent) {
        if (owner === canvasId) ids.add(id);
      }
      for (const id of ids) this.forgetNode(id);
    },

    suspendCanvas(canvasId) {
      suspendedCanvases.add(canvasId);
      if (opts.getState().canvasId === canvasId) debouncer.cancelAll();
      return () => {
        suspendedCanvases.delete(canvasId);
      };
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
      if (failures.get(nodeId)?.error instanceof NodeDuplicateFilesError)
        dismissFailureToast(nodeId);
    },

    forgetNode(nodeId) {
      dismissFailureToast(nodeId);
      generations.delete(nodeId);
      restores.delete(nodeId);
      restoredContent.delete(nodeId);
      failures.delete(nodeId);
      debouncer.cancel(nodeId);
      baselineRev.delete(nodeId);
      baselineGeneration.delete(nodeId);
      pendingFields.delete(nodeId);
      pendingPropertyKeys.delete(nodeId);
      propertySaves.delete(nodeId);
      remoteDuringPropertySave.delete(nodeId);
      suppressNextNewNodeSave.delete(nodeId);
      frozen.delete(nodeId);
      contentConflictToasted.delete(nodeId);
      saveErrorToasted.delete(nodeId);
      duplicateToasted.delete(nodeId);
      lastSuccessful.delete(nodeId);
      remoteWhileUnsaved.delete(nodeId);
      frozenChecks.delete(nodeId);
    },

    adoptRemoteContent,

    setBaselines(nodes, revisions) {
      for (const node of nodes) {
        const nodeType = typeof node.type === 'string' ? node.type : '';
        if (!MD_BACKED_NODE_TYPES.has(nodeType)) continue;
        baselineRev.set(node.id, revisions?.[node.id] ?? revOfNode(node));
        baselineGeneration.set(node.id, {});
        // The update that moved the baseline may have brought properties.
        if (propertySaves.has(node.id)) remoteDuringPropertySave.add(node.id);
      }
    },

    clearUnsavedStatus(nodeIds) {
      for (const nodeId of nodeIds) {
        failures.delete(nodeId);
        dismissFailureToast(nodeId);
        saveErrorToasted.delete(nodeId);
        duplicateToasted.delete(nodeId);
        // The server's content replaced this page's: a conflict over it has
        // nothing left to choose between. Drop the toast guard and the
        // freeze so a later divergence alerts again and writes resume.
        contentConflictToasted.delete(nodeId);
        frozen.delete(nodeId);
      }
    },

    rebaseConflict(nodeId, rev) {
      if (!frozen.has(nodeId)) return false;
      if (rev !== undefined) frozen.set(nodeId, rev);
      return true;
    },

    settleConflictIfIdentical(node, rev) {
      if (rev === undefined) return false;
      if (!frozen.has(node.id) || inflight.has(node.id)) return false;
      const state = opts.getState();
      const local = state.nodes.find((n) => n.id === node.id);
      // This page's own content, hashed, against the server's revision.
      if (!local || revOfNode(local) !== rev) return false;
      settleIdenticalConflict(state.canvasId, node.id, rev);
      return true;
    },

    pendingNodeIds() {
      // Debounced-but-not-yet-fired saves plus in-flight PUTs: both mean
      // the node holds a local edit the server hasn't acknowledged. So does
      // a conflict the user has not answered, whatever else is recorded
      // for the node: its text must not be replaced or re-baselined.
      return Array.from(
        new Set([
          ...debouncer.pendingKeys(),
          ...inflight.keys(),
          ...pendingFields.keys(),
          ...frozen.keys(),
          ...[...restoredContent]
            .filter(([, canvasId]) => canvasId === opts.getState().canvasId)
            .map(([id]) => id),
        ]),
      );
    },

    unsavedNodeIds(canvasId) {
      return Array.from(
        new Set([
          ...(opts.getState().canvasId === canvasId
            ? this.pendingNodeIds()
            : []),
          ...[...failures]
            .filter(([, failure]) => failure.canvasId === canvasId)
            .map(([id]) => id),
        ]),
      );
    },

    pendingFields(nodeId) {
      if (restoredContent.has(nodeId)) return new Set(NODE_CONTENT_KEYS);
      return new Set(pendingFields.get(nodeId)?.keys());
    },

    pendingPropertyKeys(nodeId) {
      return new Set(pendingPropertyKeys.get(nodeId)?.keys());
    },

    remotePropertiesShown(nodeId) {
      if (propertySaves.has(nodeId)) remoteDuringPropertySave.add(nodeId);
    },

    whenInFlightSaved(nodeId) {
      const saves = [inflight.get(nodeId), propertySaves.get(nodeId)].filter(
        (save) => save !== undefined,
      );
      const running = saves.length > 0 ? Promise.all(saves) : undefined;
      return {
        onlyInFlight:
          running !== undefined &&
          !pendingFields.has(nodeId) &&
          !restoredContent.has(nodeId) &&
          !frozen.has(nodeId) &&
          !debouncer.pendingKeys().includes(nodeId),
        done: (running ?? Promise.resolve()).then(
          () => undefined,
          () => undefined,
        ),
      };
    },

    hasUnsavedContent(canvasId) {
      return (
        this.pendingNodeIds().length > 0 ||
        propertySaves.size > 0 ||
        [...failures.values()].some((failure) => failure.canvasId === canvasId)
      );
    },
  };
}
