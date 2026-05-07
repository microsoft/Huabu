/**
 * Stage 3 — Normalize
 *
 * Produces canonical content hash, stable nodeId, title, and merged
 * metadata. No external calls, no LLM. Source identity is now
 * canvas-local: the `sourceId` field carries the canvas node id, which
 * is what `nodes/<nodeId>.md` is keyed by.
 */

import { computeContentHash } from '../utils.js';

import type {
  ResolvedInput,
  ExtractResult,
  NormalizeResult,
} from '../types.js';
import type { NodeContentKind } from '@sediment/shared';

export function normalize(
  resolved: ResolvedInput,
  extracted: ExtractResult,
  contentKind?: NodeContentKind,
): NormalizeResult {
  const canonicalContent = extracted.content ?? resolved.content ?? '';
  const contentHash = computeContentHash(canonicalContent);

  // Title resolution:
  // - User-set labels always take precedence.
  // - For web/pdf nodes whose titles come from extraction (HTML <title>, PDF
  //   metadata), do NOT fall back to resolved.title — it may carry a stale
  //   URL-based label from a previous run.  The Enrich stage will supply an
  //   LLM-generated label later via the pipeline backfill.
  // - For note/text nodes, resolved.title (derived from content) is a
  //   reasonable fallback.
  const title =
    resolved.labelSource === 'user' || resolved.labelSource === 'agent'
      ? (resolved.title ?? extracted.title)
      : resolved.nodeType === 'web' || resolved.nodeType === 'pdf'
        ? extracted.title
        : (extracted.title ?? resolved.title);

  // Metadata: merge extracted metadata with any existing metadata
  const metadata = extracted.metadata
    ? { ...(extracted.metadata as Record<string, unknown>) }
    : undefined;

  // Source ID generation
  const sourceId = resolveSourceId(resolved, contentHash, contentKind);

  // Input fingerprint: hash type-specific canonical input to avoid collisions
  // across unrelated nodes (e.g. two empty notes, or image vs frame).
  const inputFingerprint = computeInputFingerprint(resolved, canonicalContent);

  return {
    contentHash,
    sourceId,
    title,
    metadata,
    canonicalContent,
    inputFingerprint,
  };
}

/**
 * Compute a type-specific input fingerprint.
 * Uses the canonical input that uniquely identifies this node's content
 * rather than falling back to empty-string hash for non-textual types.
 */
function computeInputFingerprint(
  resolved: ResolvedInput,
  canonicalContent: string,
): string {
  const { nodeType } = resolved;

  switch (nodeType) {
    case 'image':
      return computeContentHash(`image:${resolved.imageSrc ?? ''}`);
    case 'frame':
      return computeContentHash(
        `frame:${(resolved.childLabels ?? []).join('|')}`,
      );
    case 'web':
      // Use URL + content so fingerprint changes when either changes
      return computeContentHash(
        `web:${resolved.normalizedUri ?? ''}:${canonicalContent}`,
      );
    case 'pdf':
      // Use artifact URI + content hash
      return computeContentHash(
        `pdf:${resolved.artifactUri ?? ''}:${canonicalContent}`,
      );
    default:
      // note/text/video: content-based
      return computeContentHash(`${nodeType}:${canonicalContent}`);
  }
}

function resolveSourceId(
  resolved: ResolvedInput,
  _contentHash: string,
  _contentKind?: NodeContentKind,
): string {
  // Source identity is canvas-local: the node id is the source id.
  // An explicit existing id (e.g. supplied by a legacy snapshot) wins
  // when present, otherwise fall back to the resolved node id.
  return resolved.existingSourceId ?? resolved.nodeId;
}
