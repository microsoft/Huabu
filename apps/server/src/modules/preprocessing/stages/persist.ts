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

  // Hash-based dedup inside this canvas: skip rewrite when canonical
  // content has not changed. Title may still drift, so refresh it.
  if (existing && existing.contentHash === normalized.contentHash) {
    if (normalized.title && existing.title !== normalized.title) {
      store.writeNode(nodeId, {
        ...existing,
        title: normalized.title,
      });
    }
    return {
      nodeId,
      isNew: false,
      contentChanged: false,
    };
  }

  store.writeNode(nodeId, {
    nodeId,
    type: contentKind,
    title: normalized.title ?? null,
    src: src ?? null,
    content: normalized.canonicalContent,
    contentHash: normalized.contentHash,
    metadata: normalized.metadata ?? {},
  });

  return {
    nodeId,
    isNew: !existing,
    contentChanged: true,
  };
}
