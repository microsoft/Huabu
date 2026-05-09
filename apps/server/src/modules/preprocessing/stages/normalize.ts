/**
 * Stage 3 — Normalize
 *
 * Produces canonical content, stable nodeId, title, and merged metadata.
 * No external calls, no LLM. Source identity is canvas-local: the
 * `nodeId` field carries the canvas node id, which is what
 * `nodes/<nodeId>.md` is keyed by.
 */

import type {
  ResolvedInput,
  ExtractResult,
  NormalizeResult,
  NodeContentKind,
} from '../types.js';

export function normalize(
  resolved: ResolvedInput,
  extracted: ExtractResult,
  contentKind?: NodeContentKind,
): NormalizeResult {
  const canonicalContent = extracted.content ?? resolved.content ?? '';

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

  // Node id resolution (source identity is canvas-local).
  const nodeId = resolveNodeId(resolved, contentKind);

  return {
    nodeId,
    title,
    metadata,
    canonicalContent,
  };
}

function resolveNodeId(
  resolved: ResolvedInput,
  _contentKind?: NodeContentKind,
): string {
  // Source identity is canvas-local: the node id is the source id.
  return resolved.nodeId;
}
