/**
 * Stage 5 — Persist
 *
 * Writes canonical source records into the knowledge store.
 * Skipped for node types that have no sourceKind (image, frame, video).
 */

import type { IKnowledgeRepository } from '../../knowledge/knowledge.interface.js';
import type { SourceType } from '../../knowledge/types.js';
import type { NormalizeResult, PersistResult } from '../types.js';

export function persist(
  normalized: NormalizeResult,
  sourceKind: string | undefined,
  repository: IKnowledgeRepository,
): PersistResult {
  if (!sourceKind) {
    return { skipped: true };
  }

  const type = sourceKind as SourceType;
  const existing = repository.findSourceById(normalized.sourceId);

  // Content-hash deduplication: skip write if hash unchanged
  if (existing && existing.contentHash === normalized.contentHash) {
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
    src: undefined,
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
