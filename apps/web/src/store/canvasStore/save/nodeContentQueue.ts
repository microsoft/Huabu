// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Per-node content save queue.
 *
 * Edits to a node's markdown sidecar (content / label / src / summary /
 * keywords / provenance) are persisted via a dedicated per-node endpoint
 * (`PUT /api/canvas/:canvasId/nodes/:nodeId/content`). Phase 4 commits do
 * advance the shared canvas version, while content and structure retain
 * independent CAS baselines (`expectRev` and `expectStructureRevision`).
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

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  CanvasConflictError,
  deleteNode,
  getNodeContent,
  NodeDuplicateFilesError,
  putNodeContent,
} from '@/api/canvas';
import { toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import { copyToClipboard } from '@/utils/io/clipboard';

import {
  MD_BACKED_NODE_TYPES,
  NODE_CONTENT_KEYS,
  TEXT_BEARING_NODE_TYPES,
} from './nodeContentFields';
import { createPerKeyDebouncer } from './perKeyDebouncer';
import { canvasSyncTabId } from '../../canvasCommitSync';

import type {
  CanvasCommitEvent,
  GetNodeContentResponse,
  MutationAck,
  NodeUiProjection,
  PutNodeContentRequest,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

/**
 * Revision of an empty node ({@link nodeRevisionOf} over no authored
 * content). A brand-new node the client is creating sends this as its
 * `expectRev` baseline, so the create only succeeds while no `.md` exists
 * yet on the server — closing the create-race window.
 */
const REV_EMPTY = nodeRevisionOf({});

/** Compute a node's content revision (the CAS baseline) from its data. */
function revOfNode(node: Node): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  return nodeRevisionOf({
    ...(typeof data['content'] === 'string'
      ? { content: data['content'] as string }
      : {}),
    ...(typeof data['src'] === 'string' ? { src: data['src'] as string } : {}),
  });
}

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

type AggregateNodeCreateSnapshot = {
  nodeId: string;
  generation: number;
  nodeType: string;
  /** Sidecar-owned data exactly as captured for the structure request. */
  sentData: Readonly<Record<string, unknown>>;
};

/**
 * Opaque capture of uncommitted markdown-backed nodes included in one
 * structure PUT. The store uses `nodeIds` to retain their sidecar-owned
 * fields in that request, then returns the same attempt when the response
 * arrives so edits made while the request was in flight can be detected.
 */
export type AggregateNodeCreateAttempt = {
  nodeIds: readonly string[];
  /** @internal Queue-owned snapshots; callers must pass these back unchanged. */
  snapshots: readonly AggregateNodeCreateSnapshot[];
};

export type NodeBaselineRebaseTicket = Readonly<{
  nodeId: string;
  generation: number;
}>;

/**
 * Public shape returned by {@link createNodeContentQueue}.
 */
export type NodeContentQueue = {
  /**
   * Diff `prevNodes` against `nextNodes` and schedule a per-node
   * content save for every markdown-backed node whose content keys
   * actually changed. New nodes are held for the aggregate structure
   * create (their `.md` and topology must appear atomically); deleted
   * nodes are ignored — the DELETE endpoint handles unlink and a stale
   * debounced timer for a deleted node no-ops on the request builder.
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
   * Node ids with un-persisted content edits — pending debounced saves,
   * baseline rebases, plus in-flight PUTs. Used by the sync applier to
   * protect a node the user is mid-editing from an incoming agent write.
   */
  pendingNodeIds(): string[];

  /**
   * Seed (or refresh) the optimistic-concurrency baseline revision for
   * each given node from its current authored content. Called with the
   * authoritative server state so content and its baseline are updated
   * together (never through separate channels): on `loadCanvas` for every
   * loaded node, and on `applyDeltasFromAgent` for the nodes an agent
   * write actually applied. This is what keeps a subsequent user edit
   * from a false `NODE_CONTENT_CONFLICT` after an agent write that was
   * already reflected in the user's view.
   */
  seedBaselines(nodes: readonly Node[]): void;

  /**
   * Replace queue bookkeeping with one authoritative full-canvas snapshot.
   * Unlike `seedBaselines`, this also prunes nodes from previously visited
   * canvases so module-lifetime maps do not grow without bound.
   */
  replaceBaselines(nodes: readonly Node[]): void;

  /** Pause a dirty node before asynchronously resolving a remote CAS rev. */
  beginBaselineRebase(nodeId: string): NodeBaselineRebaseTicket;

  /**
   * After older in-flight writes settle, adopt the remote rev and immediately
   * retry the preserved local body on top of it.
   */
  completeBaselineRebase(
    canvasId: string,
    ticket: NodeBaselineRebaseTicket,
    rev: string,
  ): Promise<void>;

  /** Cancel an unresolved rebase without disturbing a newer generation. */
  cancelBaselineRebase(ticket: NodeBaselineRebaseTicket): void;

  /**
   * A remote delete lost to a local dirty editor. Hold that node for the next
   * aggregate structure commit so its topology and sidecar are recreated
   * atomically instead of issuing a standalone PUT against a tombstone.
   * Returns true only when a new aggregate recreation was armed.
   */
  markAggregateRecreate(nodeId: string): boolean;

  /** True while the node's topology and initial sidecar are not committed. */
  isAggregateCreatePending(nodeId: string): boolean;

  /** Capture pending creates that will ride the next structure PUT. */
  beginAggregateCreateCommit(
    nodes: readonly Node[],
  ): AggregateNodeCreateAttempt;

  /**
   * Adopt the server-authored revisions/projections for a successful
   * structure PUT and immediately flush any content edit made after the
   * request snapshot. Returns the node ids whose creates became durable.
   */
  completeAggregateCreateCommit(
    canvasId: string,
    attempt: AggregateNodeCreateAttempt,
    commit?: CanvasCommitEvent,
  ): Promise<string[]>;
};

function sidecarDataOf(node: Node): Record<string, unknown> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const sidecar: Record<string, unknown> = {};
  for (const key of NODE_CONTENT_KEYS) {
    const value = data[key];
    // Match JSON.stringify(request): an explicit `undefined` is absent on
    // the wire and must compare equal to an omitted optional property.
    if (value !== undefined) sidecar[key] = value;
  }
  return sidecar;
}

function wireValue(
  value: unknown,
): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.stringify(value) };
  } catch {
    // A cyclic provenance value would make the outgoing JSON fail too. Keep
    // the comparison conservative in that exceptional case.
    return { ok: false };
  }
}

function sidecarFieldEqual(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const aValue = a[key];
  const bValue = b[key];
  if (Object.is(aValue, bValue)) return true;
  const aWire = wireValue(aValue);
  const bWire = wireValue(bValue);
  return aWire.ok && bWire.ok && aWire.value === bWire.value;
}

function sidecarDataEqual(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  for (const key of NODE_CONTENT_KEYS) {
    if (!sidecarFieldEqual(a, b, key)) return false;
  }
  return true;
}

type AuthoritativeNodeContent = {
  type: string;
  data: Record<string, unknown>;
  rev: string;
  contentMissing?: boolean;
  artifactMissing?: boolean;
  contentDuplicate?: boolean;
  duplicateFiles?: string[];
};

function authorityFromProjection(
  projection: NodeUiProjection,
): AuthoritativeNodeContent {
  const data: Record<string, unknown> = {
    label: projection.label,
  };
  if (TEXT_BEARING_NODE_TYPES.has(projection.type)) {
    data['content'] = projection.content;
  }
  for (const key of [
    'labelSource',
    'src',
    'summary',
    'keywords',
    'provenance',
  ] as const) {
    const value = projection[key];
    if (value !== undefined) data[key] = value;
  }
  return {
    type: projection.type,
    data,
    rev: projection.rev,
    contentMissing: projection.contentMissing,
    artifactMissing: projection.artifactMissing,
    contentDuplicate: projection.contentDuplicate,
    duplicateFiles: projection.duplicateFiles,
  };
}

function authorityFromGet(
  response: GetNodeContentResponse,
  sentData: Readonly<Record<string, unknown>>,
): AuthoritativeNodeContent {
  const data: Record<string, unknown> = {
    label: response.label,
  };
  if (TEXT_BEARING_NODE_TYPES.has(response.type)) {
    data['content'] = response.content;
  }
  for (const key of ['labelSource', 'src', 'summary', 'keywords'] as const) {
    const value = response[key];
    if (value !== undefined) data[key] = value;
  }
  // The single-node GET predates provenance on its response contract. The
  // aggregate request did carry it, so retain that field as the best exact
  // fallback rather than manufacturing a redundant follow-up PUT.
  if (sentData['provenance'] !== undefined) {
    data['provenance'] = sentData['provenance'];
  }
  return {
    type: response.type,
    data,
    rev: response.rev,
    contentMissing: response.contentMissing,
    artifactMissing: response.artifactMissing,
    contentDuplicate: response.contentDuplicate,
    duplicateFiles: response.duplicateFiles,
  };
}

function fallbackAuthority(
  snapshot: AggregateNodeCreateSnapshot,
): AuthoritativeNodeContent {
  const content = snapshot.sentData['content'];
  const src = snapshot.sentData['src'];
  return {
    type: snapshot.nodeType,
    data: { ...snapshot.sentData },
    rev: nodeRevisionOf({
      ...(typeof content === 'string' ? { content } : {}),
      ...(typeof src === 'string' ? { src } : {}),
    }),
  };
}

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
  onMutationCommit?: (canvasId: string, commit: CanvasCommitEvent) => void;
  onMutationAck?: (canvasId: string, ack: MutationAck) => void;
}): NodeContentQueue {
  const debouncer = createPerKeyDebouncer<string>(opts.delayMs);
  const inflight = new Map<string, Promise<void>>();
  let aggregateCreateGeneration = 0;
  /**
   * Markdown-backed nodes whose topology does not exist in the committed
   * Space yet. Their first sidecar write must be atomic with the structure
   * create, so every ordinary content flush is held until that commit ACKs.
   * The generation prevents a late ACK for create → delete → recreate with
   * the same id from adopting the replacement node.
   */
  const aggregateCreates = new Map<string, number>();
  /**
   * Creates deleted locally while their structure PUT is in flight. The first
   * DELETE can reach the server before the create and no-op, so the generation
   * is retained until that create ACK can issue a compensating aggregate
   * delete. A recreate receives a newer generation and supersedes the cleanup.
   */
  const cancelledAggregateCreates = new Map<string, number>();
  let baselineRebaseGeneration = 0;
  const baselineRebases = new Map<string, number>();
  let loadLatestGeneration = 0;
  const loadLatestTickets = new Map<string, number>();
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
   * {@link seedBaselines}) and updated to the server-returned rev after
   * every successful write, so content and its baseline always move
   * together. A node with no entry sends {@link REV_EMPTY} (treated as
   * "I believe this is a fresh create").
   */
  const baselineRev = new Map<string, string>();

  /**
   * Node ids for which the persistent `NODE_CONTENT_CONFLICT` toast is
   * already showing. Rate-limits the toast to once per node (autosave
   * would otherwise re-pop it on every keystroke while the node stays
   * blocked). Cleared on a successful write or a baseline reseed.
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
   * Cleared when the node is resolved (reseeded on load / agent-sync, or
   * a successful forced write).
   */
  const frozen = new Map<string, string>();

  /**
   * Node ids for which we have already shown the persistent
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
   * Writes that failed without persisting the current in-memory body. Keep
   * them visible to dirty arbitration even after the in-flight promise has
   * settled; otherwise a gap reload could immediately discard the edit that
   * the failure toast is asking the user to retry.
   */
  const failedSaves = new Set<string>();

  /**
   * Build the `PutNodeContentRequest` body for `nodeId` from the
   * latest store snapshot. Returns `null` when the node has gone
   * away (e.g. deleted between debounce-schedule and flush) or its
   * type is not markdown-backed.
   */
  function buildRequest(nodeId: string): PutNodeContentRequest | null {
    // A standalone node PUT before topology exists can create an orphaned
    // sidecar or fail preprocessing. Initial content rides the structure PUT
    // instead and this queue resumes only after its aggregate ACK.
    if (aggregateCreates.has(nodeId)) return null;
    if (baselineRebases.has(nodeId)) return null;
    const node = opts.getState().nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (!MD_BACKED_NODE_TYPES.has(nodeType)) return null;

    // Frozen after a content conflict: refuse every write path until the
    // user resolves it, so neither a debounced autosave nor the unload
    // keepalive can clobber the newer server content.
    if (frozen.has(nodeId)) return null;

    const data = (node.data ?? {}) as Record<string, unknown>;
    if (data['contentMissing'] === true) return null;
    const body: PutNodeContentRequest = {
      nodeType,
      originator: { source: 'ui', tabId: canvasSyncTabId },
    };

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

    // Optimistic-concurrency baseline. A node we've loaded / synced has a
    // seeded rev; a brand-new node (no entry) sends the empty-content rev
    // so its create only lands while no `.md` exists yet on the server.
    // The web sends this uniformly for every md-backed node; the server
    // applies the rev-CAS only for `authored` bodies (note / text /
    // question) and ignores it for `derived` (last-write-wins) types —
    // `bodyOwnership` in the preprocessing profiles is the single source
    // of truth, so the client need not know the classification.
    body.expectRev = baselineRev.get(nodeId) ?? REV_EMPTY;

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
    body: PutNodeContentRequest,
    kOpts?: { keepalive?: boolean },
  ): Promise<void> {
    const response = await putNodeContent(canvasId, nodeId, body, kOpts);
    if (response.commit) {
      opts.onMutationCommit?.(canvasId, response.commit);
    } else if (response.ack) {
      opts.onMutationAck?.(canvasId, response.ack);
    }
    // The node may have been remotely deleted while this request was in
    // flight. Its local editor now owns an aggregate recreation; an older
    // standalone PUT response must not install a pre-delete baseline or
    // canonical label over that recovery attempt.
    if (aggregateCreates.has(nodeId)) return;
    // Content and its baseline update together: record the rev the server
    // actually persisted so the next edit's `expectRev` is fresh (and a
    // rapid follow-up edit doesn't 409 against our own just-committed
    // write). Also clear any content-conflict toast guard — a success
    // means the node is no longer blocked.
    baselineRev.set(nodeId, response.rev);
    contentConflictToasted.delete(nodeId);
    saveErrorToasted.delete(nodeId);
    failedSaves.delete(nodeId);
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
    // Only patch when a canonical value actually differs from what's in the
    // store right now — avoids spurious re-renders when the server echoes the
    // request. `contentPreserved` is the narrow recovery path for an empty
    // PUT that the server refused to let clobber an existing body. Restore
    // that body only while the exact optimistic empty value we sent remains
    // current; an edit made while this request was in flight must win and is
    // serialized into the next PUT. The authoritative rev above is adopted in
    // either case so that follow-up write uses the correct CAS baseline.
    const state = opts.getState();
    const currentNode = state.nodes.find((n) => n.id === nodeId);
    if (!currentNode) return;
    const currentLabel =
      typeof currentNode.data?.['label'] === 'string'
        ? (currentNode.data['label'] as string)
        : null;
    const currentContent = currentNode.data?.['content'];
    const currentLabelSource = currentNode.data?.['labelSource'];
    const attemptedLabel =
      typeof body.label === 'string' || body.label === null
        ? body.label
        : undefined;
    const labelAttemptIsStillCurrent =
      attemptedLabel !== undefined &&
      currentLabel === attemptedLabel &&
      currentLabelSource === body.labelSource;
    const shouldRestorePreservedContent =
      response.contentPreserved === true &&
      typeof response.content === 'string' &&
      body.content === '' &&
      currentContent === body.content;
    const shouldPatchLabel =
      labelAttemptIsStillCurrent &&
      response.label !== null &&
      response.label !== currentLabel;
    if (shouldPatchLabel || shouldRestorePreservedContent) {
      state._setStateNoAutosave({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...(n.data ?? {}),
                  ...(shouldPatchLabel ? { label: response.label } : {}),
                  ...(shouldRestorePreservedContent
                    ? { content: response.content }
                    : {}),
                },
              }
            : n,
        ),
      });
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
    toast(i18n.t('node.contentConflict', { label }), {
      tone: 'danger',
      duration: 0,
      secondaryAction: {
        label: i18n.t('node.contentConflictKeepMine'),
        onClick: () => {
          void resolveKeepMine(nodeId);
        },
      },
      action: {
        label: i18n.t('node.contentConflictLoadLatest'),
        onClick: () => {
          void resolveLoadLatest(nodeId);
        },
      },
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
    loadLatestTickets.delete(nodeId);
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
   * The refreshed content is written through `_setStateNoAutosave`, so
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
    const frozenRevision = frozen.get(nodeId);
    if (!cur || frozenRevision === undefined) return;
    const capturedType = cur.type;
    const capturedData = sidecarDataOf(cur);
    const ticket = ++loadLatestGeneration;
    loadLatestTickets.set(nodeId, ticket);
    const localText =
      cur && typeof cur.data?.['content'] === 'string'
        ? (cur.data['content'] as string)
        : '';
    // Safety net first: preserve the discarded edit on the clipboard
    // before we overwrite it with the server's version.
    if (localText) await copyToClipboard(localText).catch(() => undefined);
    if (!canvasId) return;

    const res = await getNodeContent(canvasId, nodeId);
    const latestState = opts.getState();
    const latestNode = latestState.nodes.find((n) => n.id === nodeId);
    const requestIsCurrent =
      loadLatestTickets.get(nodeId) === ticket &&
      latestState.canvasId === canvasId &&
      frozen.get(nodeId) === frozenRevision &&
      latestNode !== undefined &&
      latestNode.type === capturedType &&
      sidecarDataEqual(sidecarDataOf(latestNode), capturedData);
    if (!requestIsCurrent) return;
    if (!res) {
      // Keep the node frozen (still safe) and let the user retry.
      toast(i18n.t('node.contentConflictLoadFailed'), {
        tone: 'danger',
        duration: 0,
      });
      return;
    }

    // Overlay only the content-owned keys; UI / geometry fields stay
    // untouched. `_setStateNoAutosave` skips the content diff so adopting
    // the server state never schedules a PUT back onto disk.
    const nextNodes = latestState.nodes.map((n) =>
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
              contentMissing: res.contentMissing ?? false,
              artifactMissing: res.artifactMissing ?? false,
              contentDuplicate: res.contentDuplicate ?? false,
              duplicateFiles: res.duplicateFiles ?? [],
            },
          }
        : n,
    );
    latestState._setStateNoAutosave({ nodes: nextNodes });

    // Re-baseline to the server rev and unfreeze so editing resumes.
    baselineRev.set(nodeId, res.rev);
    lastSuccessful.set(nodeId, {
      label: res.label,
      labelSource: res.labelSource,
    });
    frozen.delete(nodeId);
    contentConflictToasted.delete(nodeId);
    loadLatestTickets.delete(nodeId);
    toast(i18n.t('node.contentConflictLoaded'), { tone: 'success' });
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
    const body = buildRequest(nodeId);
    if (!body) return;
    try {
      await performSave(canvasId, nodeId, body, kOpts);
    } catch (err) {
      if (err instanceof NodeDuplicateFilesError) {
        failedSaves.add(nodeId);
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
          const currentState = opts.getState();
          const currentNode = currentState.nodes.find(
            (candidate) => candidate.id === nodeId,
          );
          if (
            currentState.canvasId !== canvasId ||
            !currentNode ||
            currentNode.type !== body.nodeType ||
            aggregateCreates.has(nodeId)
          ) {
            // The rejected request belongs to an incarnation that no longer
            // exists (or is already being recreated after a remote delete).
            // Do not resurrect a frozen entry/toast after `forgetNode`, and
            // do not block the aggregate recovery with an obsolete CAS.
            return;
          }
          handleContentConflict(nodeId, err.currentRev ?? REV_EMPTY);
          return;
        }
        failedSaves.add(nodeId);
        throw err;
      }
      failedSaves.add(nodeId);
      handleSaveFailure(canvasId, nodeId, source, err, body);
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
    attemptedBody: PutNodeContentRequest,
  ): void {
    const state = opts.getState();
    if (state.canvasId !== canvasId) return;
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return; // node was deleted mid-flight — nothing to do

    const data = (node.data ?? {}) as Record<string, unknown>;
    const currentLabel =
      typeof data['label'] === 'string' ? (data['label'] as string) : null;
    const lastGood = lastSuccessful.get(nodeId);
    const attemptedLabel =
      typeof attemptedBody.label === 'string' || attemptedBody.label === null
        ? attemptedBody.label
        : undefined;
    const currentLabelSource = data['labelSource'];
    const attemptedRenameIsStillCurrent =
      lastGood !== undefined &&
      attemptedLabel !== undefined &&
      attemptedLabel !== lastGood.label &&
      currentLabel === attemptedLabel &&
      currentLabelSource === attemptedBody.labelSource;

    // Rename failure: we have a previously-persisted label AND the
    // store's label drifted away from it. Roll back the label only —
    // preserve content / src / summary so the user's other edits
    // survive. labelSource is restored to whatever was attached to
    // the last successful PUT (or stripped entirely if none).
    if (lastGood && attemptedRenameIsStillCurrent) {
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
      surfaceSaveError(
        canvasId,
        nodeId,
        i18n.t('errors.nodeSaveFailed', {
          name: lastGood.label ?? i18n.t('node.untitled'),
        }),
        source,
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
      i18n.t('errors.nodeSaveFailed', {
        name: currentLabel || i18n.t('node.untitled'),
      }),
      source,
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
  ): void {
    if (source === 'auto' && saveErrorToasted.has(nodeId)) return;
    saveErrorToasted.add(nodeId);
    toast(message, {
      tone: 'danger',
      duration: 0,
      dismissible: true,
      action: {
        label: i18n.t('messages.retry'),
        onClick: () => {
          // Allow a later failure to re-alert, then re-attempt the write.
          saveErrorToasted.delete(nodeId);
          void serializedFlush(canvasId, nodeId, 'user').catch(() => undefined);
        },
      },
    });
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

  async function authoritativeCreateResult(
    canvasId: string,
    snapshot: AggregateNodeCreateSnapshot,
    commit: CanvasCommitEvent | undefined,
  ): Promise<AuthoritativeNodeContent | null> {
    const change = commit?.nodeChanges.find(
      (candidate) => candidate.nodeId === snapshot.nodeId,
    );
    if (change?.kind === 'delete') return null;
    if (change?.kind === 'inline') {
      return authorityFromProjection(change.projection);
    }

    // `invalidate` and ack-only legacy responses do not carry the exact
    // server-authored label/revision. Fetch the just-created sidecar so the
    // very next edit uses the server's CAS token (and adopts label dedupe).
    const fetched = await getNodeContent(canvasId, snapshot.nodeId).catch(
      () => null,
    );
    return fetched
      ? authorityFromGet(fetched, snapshot.sentData)
      : fallbackAuthority(snapshot);
  }

  async function settleAggregateCreate(
    canvasId: string,
    snapshot: AggregateNodeCreateSnapshot,
    commit: CanvasCommitEvent | undefined,
  ): Promise<boolean> {
    if (
      cancelledAggregateCreates.get(snapshot.nodeId) === snapshot.generation
    ) {
      const replacementGeneration = aggregateCreates.get(snapshot.nodeId);
      if (
        replacementGeneration !== undefined &&
        replacementGeneration !== snapshot.generation
      ) {
        cancelledAggregateCreates.delete(snapshot.nodeId);
        return false;
      }

      // The optimistic DELETE may have beaten this structure create to the
      // server and therefore deleted nothing. Now that create is durable,
      // await one aggregate DELETE so a closed tab cannot leave a ghost node.
      const response = await deleteNode(canvasId, snapshot.nodeId, {
        originator: { source: 'ui', tabId: canvasSyncTabId },
      });
      if (response?.commit) {
        opts.onMutationCommit?.(canvasId, response.commit);
      } else if (response?.ack) {
        opts.onMutationAck?.(canvasId, response.ack);
      }
      if (
        cancelledAggregateCreates.get(snapshot.nodeId) === snapshot.generation
      ) {
        cancelledAggregateCreates.delete(snapshot.nodeId);
      }
      return false;
    }

    if (aggregateCreates.get(snapshot.nodeId) !== snapshot.generation) {
      return false;
    }

    // A content PUT that was already in flight when a remote delete arrived
    // may settle after the aggregate recreation response. Drain it first so
    // its older acknowledgement cannot regress the recreated CAS baseline.
    const olderWrite = inflight.get(snapshot.nodeId);
    if (olderWrite) await olderWrite.catch(() => undefined);
    if (aggregateCreates.get(snapshot.nodeId) !== snapshot.generation) {
      return false;
    }

    const authority = await authoritativeCreateResult(
      canvasId,
      snapshot,
      commit,
    );

    // The GET fallback may have raced a local delete/recreate. Only the exact
    // generation captured by this structure request may consume its ACK.
    if (aggregateCreates.get(snapshot.nodeId) !== snapshot.generation) {
      return false;
    }
    const state = opts.getState();
    const current = state.nodes.find((node) => node.id === snapshot.nodeId);
    if (!current || !authority) {
      // A delete that landed before this ACK intentionally wins locally. Its
      // subsequent structural save removes the server-side aggregate again.
      aggregateCreates.delete(snapshot.nodeId);
      return false;
    }

    aggregateCreates.delete(snapshot.nodeId);
    baselineRev.set(snapshot.nodeId, authority.rev);
    frozen.delete(snapshot.nodeId);
    contentConflictToasted.delete(snapshot.nodeId);
    saveErrorToasted.delete(snapshot.nodeId);
    failedSaves.delete(snapshot.nodeId);
    duplicateToasted.delete(snapshot.nodeId);

    const serverLabel = authority.data['label'];
    const serverLabelSource = authority.data['labelSource'];
    lastSuccessful.set(snapshot.nodeId, {
      label: typeof serverLabel === 'string' ? serverLabel : null,
      labelSource:
        serverLabelSource === 'user' ||
        serverLabelSource === 'auto' ||
        serverLabelSource === 'agent'
          ? serverLabelSource
          : undefined,
    });

    // Merge the server projection field-by-field. A value still equal to the
    // request snapshot is untouched local state, so the server-normalized
    // value (notably an effective deduped label) wins. A value that changed
    // while the request was in flight is a follow-up edit and must survive.
    const currentData = sidecarDataOf(current);
    const nextData = { ...(current.data ?? {}) } as Record<string, unknown>;
    for (const key of NODE_CONTENT_KEYS) {
      if (!sidecarFieldEqual(currentData, snapshot.sentData, key)) continue;
      if (Object.prototype.hasOwnProperty.call(authority.data, key)) {
        nextData[key] = authority.data[key];
      } else {
        delete nextData[key];
      }
    }
    nextData['contentMissing'] = authority.contentMissing ?? false;
    nextData['artifactMissing'] = authority.artifactMissing ?? false;
    nextData['contentDuplicate'] = authority.contentDuplicate ?? false;
    nextData['duplicateFiles'] = authority.duplicateFiles ?? [];

    const nextNode: Node = {
      ...current,
      // A note/text conversion made while the structure request was in flight
      // is a newer local structural edit. Keep it; the already-scheduled
      // follow-up commit will persist that type transition.
      type: current.type === snapshot.nodeType ? authority.type : current.type,
      data: nextData,
    };
    state._setStateNoAutosave({
      nodes: state.nodes.map((node) =>
        node.id === snapshot.nodeId ? nextNode : node,
      ),
    });

    if (!sidecarDataEqual(sidecarDataOf(nextNode), authority.data)) {
      // The baseline is already the exact aggregate result. `performSave`
      // reads the latest store snapshot when this chained flush actually
      // runs, so additional keystrokes still coalesce into the same write.
      await serializedFlush(canvasId, snapshot.nodeId, 'auto').catch(
        () => undefined,
      );
    }
    return true;
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
          // Brand new node — hold every sidecar write until its topology and
          // initial content land together through the structure commit.
          if (!aggregateCreates.has(next.id)) {
            aggregateCreates.set(next.id, ++aggregateCreateGeneration);
          }
          debouncer.cancel(next.id);
          continue;
        }
        if (before.data === next.data) continue;
        const beforeData = (before.data ?? {}) as Record<string, unknown>;
        const afterData = (next.data ?? {}) as Record<string, unknown>;
        for (const key of NODE_CONTENT_KEYS) {
          if (beforeData[key] !== afterData[key]) {
            if (!aggregateCreates.has(next.id)) {
              schedule(canvasId, next.id);
            }
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

    forgetNode(nodeId) {
      debouncer.cancel(nodeId);
      const aggregateGeneration = aggregateCreates.get(nodeId);
      if (aggregateGeneration !== undefined) {
        cancelledAggregateCreates.set(nodeId, aggregateGeneration);
        aggregateCreates.delete(nodeId);
      }
      baselineRev.delete(nodeId);
      frozen.delete(nodeId);
      contentConflictToasted.delete(nodeId);
      saveErrorToasted.delete(nodeId);
      failedSaves.delete(nodeId);
      duplicateToasted.delete(nodeId);
      lastSuccessful.delete(nodeId);
      baselineRebases.delete(nodeId);
      loadLatestTickets.delete(nodeId);
    },

    seedBaselines(nodes) {
      for (const node of nodes) {
        const nodeType = typeof node.type === 'string' ? node.type : '';
        if (!MD_BACKED_NODE_TYPES.has(nodeType)) continue;
        aggregateCreates.delete(node.id);
        cancelledAggregateCreates.delete(node.id);
        baselineRebases.delete(node.id);
        loadLatestTickets.delete(node.id);
        baselineRev.set(node.id, revOfNode(node));
        // A fresh authoritative baseline means any prior conflict for this
        // node is resolved — drop the toast guard and unfreeze it so a
        // later divergence alerts again and writes resume.
        contentConflictToasted.delete(node.id);
        frozen.delete(node.id);
      }
    },

    replaceBaselines(nodes) {
      const retained = new Set(
        nodes
          .filter((node) =>
            MD_BACKED_NODE_TYPES.has(
              typeof node.type === 'string' ? node.type : '',
            ),
          )
          .map((node) => node.id),
      );
      const pruneMap = (map: Map<string, unknown>): void => {
        for (const key of map.keys()) {
          if (!retained.has(key)) map.delete(key);
        }
      };
      const pruneSet = (set: Set<string>): void => {
        for (const key of set) {
          if (!retained.has(key)) set.delete(key);
        }
      };
      pruneMap(baselineRev);
      pruneMap(lastSuccessful);
      pruneMap(frozen);
      pruneMap(baselineRebases);
      pruneMap(aggregateCreates);
      pruneMap(cancelledAggregateCreates);
      pruneMap(loadLatestTickets);
      pruneSet(contentConflictToasted);
      pruneSet(duplicateToasted);
      pruneSet(saveErrorToasted);
      // A full snapshot is an explicit authoritative replacement. Any
      // retained failed body was intentionally discarded by that load, while
      // entries from earlier canvases must not leak into the new one.
      failedSaves.clear();
      for (const nodeId of debouncer.pendingKeys()) {
        if (!retained.has(nodeId)) debouncer.cancel(nodeId);
      }
      this.seedBaselines(nodes);
    },

    beginBaselineRebase(nodeId) {
      debouncer.cancel(nodeId);
      const ticket = {
        nodeId,
        generation: ++baselineRebaseGeneration,
      };
      baselineRebases.set(nodeId, ticket.generation);
      return ticket;
    },

    completeBaselineRebase(canvasId, ticket, rev) {
      const previous = inflight.get(ticket.nodeId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          if (baselineRebases.get(ticket.nodeId) !== ticket.generation) return;
          baselineRebases.delete(ticket.nodeId);
          const node = opts
            .getState()
            .nodes.find((candidate) => candidate.id === ticket.nodeId);
          if (!node) return;
          baselineRev.set(ticket.nodeId, rev);
          contentConflictToasted.delete(ticket.nodeId);
          frozen.delete(ticket.nodeId);
          await performSaveSafely(canvasId, ticket.nodeId, 'auto');
        });
      inflight.set(ticket.nodeId, next);
      void next
        .finally(() => {
          if (inflight.get(ticket.nodeId) === next) {
            inflight.delete(ticket.nodeId);
          }
        })
        .catch(() => undefined);
      return next;
    },

    cancelBaselineRebase(ticket) {
      if (baselineRebases.get(ticket.nodeId) === ticket.generation) {
        baselineRebases.delete(ticket.nodeId);
      }
    },

    markAggregateRecreate(nodeId) {
      if (aggregateCreates.has(nodeId)) return false;
      debouncer.cancel(nodeId);
      baselineRebases.delete(nodeId);
      baselineRev.delete(nodeId);
      frozen.delete(nodeId);
      contentConflictToasted.delete(nodeId);
      loadLatestTickets.delete(nodeId);
      cancelledAggregateCreates.delete(nodeId);
      aggregateCreates.set(nodeId, ++aggregateCreateGeneration);
      return true;
    },

    pendingNodeIds() {
      // Aggregate creates, CAS rebases, debounced saves, and in-flight PUTs
      // all mean the node holds local content the server has not acknowledged.
      return Array.from(
        new Set([
          ...aggregateCreates.keys(),
          ...baselineRebases.keys(),
          ...frozen.keys(),
          ...failedSaves,
          ...debouncer.pendingKeys(),
          ...inflight.keys(),
        ]),
      );
    },

    isAggregateCreatePending(nodeId) {
      return aggregateCreates.has(nodeId);
    },

    beginAggregateCreateCommit(nodes) {
      const snapshots: AggregateNodeCreateSnapshot[] = [];
      for (const node of nodes) {
        const generation = aggregateCreates.get(node.id);
        if (generation === undefined) continue;
        const nodeType = typeof node.type === 'string' ? node.type : '';
        if (!MD_BACKED_NODE_TYPES.has(nodeType)) continue;
        snapshots.push({
          nodeId: node.id,
          generation,
          nodeType,
          sentData: { ...sidecarDataOf(node) },
        });
      }
      return {
        nodeIds: snapshots.map((snapshot) => snapshot.nodeId),
        snapshots,
      };
    },

    async completeAggregateCreateCommit(canvasId, attempt, commit) {
      const committedNodeIds: string[] = [];
      for (const snapshot of attempt.snapshots) {
        if (await settleAggregateCreate(canvasId, snapshot, commit)) {
          committedNodeIds.push(snapshot.nodeId);
        }
      }
      return committedNodeIds;
    },
  };
}
