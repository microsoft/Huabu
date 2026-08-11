// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stage 5 — Persist
 *
 * Writes canonical node content into the canvas store as
 * `<canvasId>/nodes/<nodeId>.md`. Skipped for node types that have no
 * `contentKind` (image, frame, video).
 *
 * Source identity is canvas-local: the persisted record is keyed by the
 * canvas node id rather than a global source id.
 */

import { getLogger } from '../../../utils/logger.js';
import { publishCanvasUpdate } from '../../canvas/canvas-sync.js';
import { getStructuredStore, withCanvasMutex } from '../../storage/index.js';

import type { CanvasStore, NodeContent } from '../../storage/canvas-store.js';
import type {
  BodyOwnership,
  NodeContentKind,
  NormalizeResult,
  PreprocessExecutionBaseline,
  PersistResult,
} from '../types.js';
import type {
  CanvasCommitEvent,
  ExecuteOriginator,
  MutationAck,
} from '@huabu/shared';

const log = getLogger('preprocessing.persist');

function mutationAckOf(event: CanvasCommitEvent): MutationAck {
  return {
    commitId: event.commitId,
    fromVersion: event.fromVersion,
    toVersion: event.toVersion,
    structureRevision: event.structureRevision,
    recordChanged: event.recordChanged,
  };
}

function publishPersistCommit(
  canvasId: string,
  event: CanvasCommitEvent,
): void {
  publishCanvasUpdate(canvasId, {
    type: 'update',
    data: {
      fromVersion: event.fromVersion,
      toVersion: event.toVersion,
      deltas: event.structureDeltas,
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
      ...(event.originator.threadId
        ? { threadId: event.originator.threadId }
        : {}),
      commit: event,
    },
  });
}

export async function persist(
  normalized: NormalizeResult,
  contentKind: NodeContentKind | undefined,
  bodyOwnership: BodyOwnership | undefined,
  store: CanvasStore,
  src?: string,
  requireExisting = false,
  originator: ExecuteOriginator = { source: 'system' },
  baseline?: PreprocessExecutionBaseline,
): Promise<PersistResult> {
  if (!contentKind) {
    return { skipped: true };
  }

  const nodeId = normalized.nodeId;

  // Read → decide → whole-record precondition → aggregate commit stays under
  // the same per-Space mutex as content PUT, DELETE, and executor batches.
  type Branch = 'skip' | 'dedup-noop' | 'dedup-refresh' | 'full';
  let branch: Branch = 'skip';
  let isNew = false;
  let existingSrc: string | undefined;

  const decide = (existing: NodeContent | null): NodeContent | null => {
    existingSrc = typeof existing?.src === 'string' ? existing.src : undefined;

    if (requireExisting && !existing) {
      log.warn({ nodeId }, 'persist skipped: node sidecar is missing');
      branch = 'skip';
      return null;
    }

    // Authored-body ownership guard (data-loss prevention). For authored
    // bodies (note/text) the content PUT is the sole body writer and owns
    // the rev-CAS. If the on-disk body has diverged from the snapshot we
    // would persist, that is a concurrent edit (another tab / device /
    // external editor / Drive-synced copy) — do NOT overwrite it, and do
    // NOT write a title/summary derived from the stale snapshot against a
    // body it no longer matches. `bodyOwnership` is threaded from the
    // node's profile by the caller so a future authored type cannot slip
    // past. NOTE: the shared lock makes this read atomic but does NOT make
    // the guard redundant — the lock stops interleaving, not writing a
    // stale snapshot over a newer body. See §0 / §3f / §3g.
    if (
      bodyOwnership === 'authored' &&
      existing &&
      existing.content !== normalized.canonicalContent
    ) {
      log.warn(
        { nodeId },
        'persist skipped: authored body diverged from snapshot ' +
          '(concurrent edit) — content PUT owns the CAS resolution',
      );
      branch = 'skip';
      return null;
    }

    // Content-based dedup: body unchanged → don't rewrite the (potentially
    // large) body; only refresh `label` / `mhtmlArtifact` frontmatter if
    // they drifted. Without the mhtml refresh, a legacy web node would
    // re-fetch + re-write its snapshot forever.
    if (existing && existing.content === normalized.canonicalContent) {
      const labelDrifted =
        !!normalized.label && existing.label !== normalized.label;
      const newMhtml = normalized.metadata?.mhtmlArtifact;
      const mhtmlDrifted =
        typeof newMhtml === 'string' &&
        newMhtml.length > 0 &&
        (existing as Record<string, unknown>).mhtmlArtifact !== newMhtml;
      if (labelDrifted || mhtmlDrifted) {
        branch = 'dedup-refresh';
        const merged: NodeContent = { ...existing };
        if (labelDrifted) merged.label = normalized.label ?? null;
        if (mhtmlDrifted) merged.mhtmlArtifact = newMhtml;
        return merged;
      }
      branch = 'dedup-noop';
      // Still submit the identical record so the aggregate authority mints
      // a no-op acknowledgement without advancing version or publication.
      return existing;
    }

    // First write (new node) or a derived body being (re)extracted.
    branch = 'full';
    isNew = !existing;
    return {
      ...(normalized.metadata ?? {}),
      nodeId,
      type: contentKind,
      label: normalized.label ?? null,
      src,
      content: normalized.canonicalContent,
    };
  };

  const outcome = await withCanvasMutex(store.canvasId, async () => {
    const handle = getStructuredStore().space(store.canvasId);
    const canvas = await handle.record.read();
    if (canvas === null) {
      throw new Error(`persist: Space ${store.canvasId} does not exist`);
    }
    const current = await handle.nodes.read(nodeId);
    const topologyNode = (canvas.state.nodes ?? []).find((candidate) => {
      const id = (candidate as { id?: unknown } | null)?.id;
      return id === nodeId;
    }) as { type?: unknown } | undefined;
    const topologyType =
      typeof topologyNode?.type === 'string' ? topologyNode.type : null;
    if (
      baseline &&
      (topologyType !== baseline.topologyType ||
        canvas.version !== baseline.spaceVersion ||
        (current?.revision ?? null) !== baseline.nodeRecordRevision)
    ) {
      log.info(
        {
          nodeId,
          expectedVersion: baseline.spaceVersion,
          actualVersion: canvas.version,
        },
        'persist skipped: preprocessing baseline was superseded',
      );
      return { status: 'superseded' as const, snapshot: current };
    }
    if (topologyType !== contentKind) {
      log.info(
        { nodeId, contentKind, topologyType },
        topologyType === null
          ? 'persist skipped: node is absent from topology'
          : 'persist skipped: preprocessing result belongs to an older node type',
      );
      return {
        status: 'superseded' as const,
        snapshot: current,
      };
    }
    const next = decide(current?.record ?? null);
    if (next === null) {
      return { status: 'skipped' as const, snapshot: current };
    }

    const result = await handle.commit({
      expectedVersion: canvas.version,
      record: { title: canvas.title, state: canvas.state },
      nodePreconditions: [{ nodeId, revision: current?.revision ?? null }],
      nodeMutations: [{ kind: 'put', record: next }],
      publication: {
        originator,
        optimistic: false,
        commands: [],
        structureDeltas: [],
      },
    });
    if (!result.ok) {
      if (
        result.reason === 'node-write-suppressed' ||
        result.reason === 'node-topology-conflict'
      ) {
        return { status: 'superseded' as const, snapshot: current };
      }
      return { status: 'rejected' as const, result, snapshot: current };
    }

    const snapshot =
      result.nodes.find((entry) => entry.record.nodeId === nodeId) ?? current;
    if (snapshot === null) {
      throw new Error(`persist: committed node ${nodeId} has no snapshot`);
    }
    if (result.committed) publishPersistCommit(store.canvasId, result.event);
    return { status: 'ok' as const, result, snapshot };
  });

  if (outcome.status === 'skipped') {
    return {
      nodeId,
      isNew: false,
      contentChanged: false,
      recordRevision: outcome.snapshot?.revision,
    };
  }

  if (outcome.status === 'superseded') {
    return {
      nodeId,
      isNew: false,
      contentChanged: false,
      skipped: true,
      superseded: true,
      recordRevision: outcome.snapshot?.revision,
    };
  }

  const commitMetadata =
    outcome.status === 'ok'
      ? {
          recordRevision: outcome.snapshot.revision,
          ack: mutationAckOf(outcome.result.event),
          commit: outcome.result.event,
        }
      : {
          recordRevision: outcome.snapshot?.revision,
        };

  // `branch` / `isNew` / `existingSrc` are set inside `decide` above, which
  // runs synchronously within the mutex callback — but TS's
  // control-flow analysis can't see a closure's side effects, so it still
  // narrows `branch` to its initial `'skip'`. Re-widen for the switch.
  switch (branch as Branch) {
    case 'skip':
      return {
        nodeId,
        isNew: false,
        contentChanged: false,
        ...commitMetadata,
      };
    case 'dedup-noop':
      // Surface the on-disk `src` even when unchanged so the Project stage can
      // still patch a client holding an un-normalized version.
      return {
        nodeId,
        isNew: false,
        contentChanged: false,
        persistedSrc: existingSrc,
        ...commitMetadata,
      };
    case 'dedup-refresh': {
      let persistedLabel: string | undefined;
      if (outcome.status === 'ok') {
        persistedLabel = outcome.snapshot.record.label ?? undefined;
      } else if (outcome.status === 'rejected') {
        // Body already on disk + matches; only the label/mhtml refresh hit a
        // structural rejection (conflict / not-found). Tolerate + log; the
        // next preprocess retries. (IO errors throw and bubble past here.)
        log.warn(
          { nodeId, reason: outcome.result.reason },
          'metadata refresh failed',
        );
      }
      return {
        nodeId,
        isNew: false,
        contentChanged: false,
        persistedLabel,
        persistedSrc: existingSrc,
        ...commitMetadata,
      };
    }
    case 'full':
      if (outcome.status !== 'ok') {
        // Structural rejection (conflict / not-found). There is no `.md` on
        // disk, so we must NOT report the node persisted — throw so the
        // pipeline records a retryable PERSIST_FAILED diagnostic instead of
        // silently accumulating `contentMissing` nodes. (IO errors already
        // threw and bubbled past the aggregate commit.)
        const reason = outcome.result.reason;
        throw new Error(`persist: writeNode failed for ${nodeId}: ${reason}`);
      }
      return {
        nodeId,
        isNew,
        contentChanged: true,
        persistedLabel: outcome.snapshot.record.label ?? undefined,
        persistedSrc:
          typeof outcome.snapshot.record.src === 'string'
            ? outcome.snapshot.record.src
            : src,
        ...commitMetadata,
      };
  }
}
