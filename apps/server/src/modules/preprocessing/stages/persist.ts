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
import { updateNode } from '../../canvas/write-coordinator.js';

import type { CanvasStore, NodeContent } from '../../storage/canvas-store.js';
import type {
  BodyOwnership,
  NodeContentKind,
  NormalizeResult,
  PersistResult,
} from '../types.js';

const log = getLogger('preprocessing.persist');

export async function persist(
  normalized: NormalizeResult,
  contentKind: NodeContentKind | undefined,
  bodyOwnership: BodyOwnership | undefined,
  store: CanvasStore,
  src?: string,
  requireExisting = false,
): Promise<PersistResult> {
  if (!contentKind) {
    return { skipped: true };
  }

  const nodeId = normalized.nodeId;

  // The read → decide → write critical section runs through `updateNode`, so
  // it is serialized under the shared per-canvas write lock: preprocess can no
  // longer interleave with the content PUT or an agent executor batch writing
  // the same `.md`. The decision (which branch, and thus the result shape +
  // error handling) is captured here from inside `apply`, which sees the
  // current on-disk record read atomically inside the lock.
  type Branch = 'skip' | 'dedup-noop' | 'dedup-refresh' | 'full';
  let branch: Branch = 'skip';
  let isNew = false;
  let existingSrc: string | undefined;

  const outcome = await updateNode(store, nodeId, {
    apply: (existing) => {
      existingSrc =
        typeof existing?.src === 'string' ? existing.src : undefined;

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
        return null;
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
    },
  });

  // `branch` / `isNew` / `existingSrc` are set inside `apply` above, which
  // runs synchronously within `updateNode`'s critical section — but TS's
  // control-flow analysis can't see a closure's side effects, so it still
  // narrows `branch` to its initial `'skip'`. Re-widen for the switch.
  switch (branch as Branch) {
    case 'skip':
      return { nodeId, isNew: false, contentChanged: false };
    case 'dedup-noop':
      // Surface the on-disk `src` even when unchanged so the Project stage can
      // still patch a client holding an un-normalized version.
      return {
        nodeId,
        isNew: false,
        contentChanged: false,
        persistedSrc: existingSrc,
      };
    case 'dedup-refresh': {
      let persistedLabel: string | undefined;
      if (outcome.status === 'ok') {
        persistedLabel = outcome.label ?? undefined;
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
      };
    }
    case 'full':
      if (outcome.status !== 'ok') {
        // Structural rejection (conflict / not-found). There is no `.md` on
        // disk, so we must NOT report the node persisted — throw so the
        // pipeline records a retryable PERSIST_FAILED diagnostic instead of
        // silently accumulating `contentMissing` nodes. (IO errors already
        // threw and bubbled past `await updateNode`.)
        const reason =
          outcome.status === 'rejected'
            ? outcome.result.reason
            : outcome.status;
        throw new Error(`persist: writeNode failed for ${nodeId}: ${reason}`);
      }
      return {
        nodeId,
        isNew,
        contentChanged: true,
        persistedLabel: outcome.label ?? undefined,
        persistedSrc: src,
      };
  }
}
