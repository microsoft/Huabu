/**
 * Stage 5 — Persist
 *
 * Writes canonical source records into the knowledge store.
 * Skipped for node types that have no sourceKind (image, frame, video).
 */

import type { IKnowledgeRepository } from '../../knowledge/knowledge.interface.js';
import type { NormalizeResult, PersistResult } from '../types.js';
import type { SourceKind } from '@sediment/shared';

export function persist(
  normalized: NormalizeResult,
  sourceKind: SourceKind | undefined,
  repository: IKnowledgeRepository,
  src?: string,
): PersistResult {
  if (!sourceKind) {
    return { skipped: true };
  }

  const type = sourceKind;
  const existing = repository.findSourceById(normalized.sourceId);

  // Content-hash deduplication: skip full write if hash unchanged.
  // Still update the source title when it has changed.
  if (existing && existing.contentHash === normalized.contentHash) {
    if (normalized.title && existing.title !== normalized.title) {
      repository.updateSource(normalized.sourceId, {
        title: normalized.title,
      });
    }
    return {
      sourceId: normalized.sourceId,
      isNew: false,
      contentChanged: false,
    };
  }

  if (existing) {
    repository.updateSource(normalized.sourceId, {
      content: normalized.canonicalContent,
      contentHash: normalized.contentHash,
      title: normalized.title,
      metadata: normalized.metadata,
    });
    return {
      sourceId: normalized.sourceId,
      isNew: false,
      contentChanged: true,
    };
  }

  // Create new source
  repository.createSource({
    sourceId: normalized.sourceId,
    type,
    title: normalized.title,
    src,
    content: normalized.canonicalContent,
    contentHash: normalized.contentHash,
    metadata: normalized.metadata,
  });

  return {
    sourceId: normalized.sourceId,
    isNew: true,
    contentChanged: true,
  };
}
