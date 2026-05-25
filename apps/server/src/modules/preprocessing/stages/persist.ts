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
  // content has not changed. Label may still drift, so refresh it.
  if (existing && existing.content === normalized.canonicalContent) {
    let persistedLabel: string | undefined;
    if (normalized.label && existing.label !== normalized.label) {
      const result = store.writeNode(nodeId, {
        ...existing,
        label: normalized.label,
      });
      if (result.ok) {
        persistedLabel = result.label ?? undefined;
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

  return {
    nodeId,
    isNew: !existing,
    contentChanged: true,
    persistedLabel: result.ok ? (result.label ?? undefined) : undefined,
    persistedSrc: src,
  };
}
