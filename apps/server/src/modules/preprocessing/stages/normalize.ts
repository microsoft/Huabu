/**
 * Stage 3 — Normalize
 *
 * Produces canonical content hash, stable sourceId, title, and merged metadata.
 * No external calls, no LLM.
 */

import { computeContentHash, generateSourceId } from '../../knowledge/utils.js';

import type { SourceType } from '../../knowledge/types.js';
import type {
  ResolvedInput,
  ExtractResult,
  NormalizeResult,
} from '../types.js';

export function normalize(
  resolved: ResolvedInput,
  extracted: ExtractResult,
  sourceKind?: string,
): NormalizeResult {
  const canonicalContent = extracted.content ?? resolved.content ?? '';
  const contentHash = computeContentHash(canonicalContent);

  // Title: prefer extracted title, fall back to resolved title
  const title = extracted.title ?? resolved.title;

  // Metadata: merge extracted metadata with any existing metadata
  const metadata = extracted.metadata
    ? { ...(extracted.metadata as Record<string, unknown>) }
    : undefined;

  // Source ID generation
  const sourceId = resolveSourceId(resolved, contentHash, sourceKind);

  // Input fingerprint for cache/skip decisions
  const inputFingerprint = contentHash;

  return {
    contentHash,
    sourceId,
    title,
    metadata,
    canonicalContent,
    inputFingerprint,
  };
}

function resolveSourceId(
  resolved: ResolvedInput,
  contentHash: string,
  sourceKind?: string,
): string {
  // If an existing sourceId was provided, keep it
  if (resolved.existingSourceId) {
    return resolved.existingSourceId;
  }

  if (!sourceKind) {
    // No source kind — generate a content-based fingerprint for cache keying
    return `pp_${contentHash.replace('sha256:', '').substring(0, 16)}`;
  }

  const type = sourceKind as SourceType;

  switch (type) {
    case 'web':
      return generateSourceId({
        type: 'web',
        uri: resolved.normalizedUri,
      });
    case 'pdf':
      return generateSourceId({
        type: 'pdf',
        fileHash: contentHash,
      });
    case 'note':
    case 'text':
      return generateSourceId({ type });
    default:
      return generateSourceId({ type: 'note' });
  }
}
