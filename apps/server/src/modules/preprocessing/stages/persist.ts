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

import type { CanvasStore } from '../../storage/canvas-store.js';
import type {
  NodeContentKind,
  NormalizeResult,
  PersistResult,
} from '../types.js';

export function persist(
  normalized: NormalizeResult,
  contentKind: NodeContentKind | undefined,
  store: CanvasStore,
  src?: string,
): PersistResult {
  if (!contentKind) {
    return { skipped: true };
  }

  const nodeId = normalized.nodeId;
  const existing = store.readNode(nodeId);

  // Content-based dedup inside this canvas: skip rewrite when canonical
  // content has not changed. Label and a small allow-list of metadata
  // fields may still drift, so refresh those without rewriting the
  // (potentially large) body. Currently the only field we care about
  // here is `mhtmlArtifact` — added by the web pipeline when it captures
  // a one-shot snapshot. Without this refresh path, legacy web nodes
  // (which already have markdown content but no snapshot) would never
  // record the artifact: persist would dedup on content, drop the new
  // metadata, and the next preprocess would re-fetch + re-write the
  // artifact forever.
  if (existing && existing.content === normalized.canonicalContent) {
    const labelDrifted =
      !!normalized.label && existing.label !== normalized.label;
    const newMhtml = normalized.metadata?.mhtmlArtifact;
    const mhtmlDrifted =
      typeof newMhtml === 'string' &&
      newMhtml.length > 0 &&
      (existing as Record<string, unknown>).mhtmlArtifact !== newMhtml;

    let persistedLabel: string | undefined;
    if (labelDrifted || mhtmlDrifted) {
      const merged: Record<string, unknown> = { ...existing };
      if (labelDrifted) merged.label = normalized.label;
      if (mhtmlDrifted) merged.mhtmlArtifact = newMhtml;
      const result = store.writeNode(nodeId, merged as typeof existing);
      if (result.ok) {
        persistedLabel = result.label ?? undefined;
      } else {
        // Body is already on disk and matches canonical content; only
        // label/mhtml metadata refresh failed. The next preprocess of
        // this node will retry the refresh, so we tolerate the failure
        // here — but log so a persistent failure (perms, disk full)
        // surfaces in operator logs instead of silently looping.
        console.warn(
          `[persist] metadata refresh failed for ${nodeId}: ${
            result.reason === 'fs-error' ? result.message : result.reason
          }`,
        );
      }
    }
    // Surface the on-disk `src` even when content was unchanged so the
    // Project stage can patch the client when it still holds an
    // un-normalized version (e.g. user pasted a URL with utm params and
    // the previous preprocess already normalized + cached it; the client
    // tab reloaded the canvas but a fresh re-trigger now races against
    // the cache short-circuit and would never receive the canonical src
    // otherwise).
    return {
      nodeId,
      isNew: false,
      contentChanged: false,
      persistedLabel,
      persistedSrc: typeof existing.src === 'string' ? existing.src : undefined,
    };
  }

  const result = store.writeNode(nodeId, {
    ...(normalized.metadata ?? {}),
    nodeId,
    type: contentKind,
    label: normalized.label ?? null,
    src,
    content: normalized.canonicalContent,
  });

  if (!result.ok) {
    // Body write failed — there is no `.md` on disk for this node, so
    // we must NOT return `contentChanged: true` (which would tell
    // downstream the node is persisted). Throw so the pipeline records
    // a retryable `PERSIST_FAILED` diagnostic instead of silently
    // accumulating `contentMissing` nodes on the canvas.
    throw new Error(
      `persist: writeNode failed for ${nodeId}: ${
        result.reason === 'fs-error' ? result.message : result.reason
      }`,
    );
  }

  return {
    nodeId,
    isNew: !existing,
    contentChanged: true,
    persistedLabel: result.label ?? undefined,
    persistedSrc: src,
  };
}
