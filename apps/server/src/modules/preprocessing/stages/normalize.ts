// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stage 3 — Normalize
 *
 * Produces canonical content, stable nodeId, label, and merged metadata.
 * No external calls, no LLM. Source identity is canvas-local: the
 * `nodeId` field carries the canvas node id, which is what
 * `nodes/<nodeId>.md` is keyed by.
 */

import { extractTitleFromText } from '../utils.js';

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

  // Label resolution:
  // - User-set labels always take precedence.
  // - For web/pdf nodes whose titles come from extraction (HTML <title>, PDF
  //   metadata), do NOT fall back to resolved.title — it may carry a stale
  //   URL-based label from a previous run.  The Enrich stage will supply an
  //   LLM-generated label later via the pipeline backfill.
  // - For note/text nodes, resolved.title (derived from content) is a
  //   reasonable fallback.
  // - For content-bearing nodes with no title from either source (e.g. a
  //   `question` created while the LLM provider is unreachable, which has no
  //   Extract stage), derive a stable local title from the first line so the
  //   node is never nameless. This is a permanent `auto` label — it is not
  //   re-derived once set, so the visible name stays stable.
  const label =
    resolved.labelSource === 'user' || resolved.labelSource === 'agent'
      ? (resolved.title ?? extracted.title)
      : resolved.nodeType === 'web' || resolved.nodeType === 'pdf'
        ? extracted.title
        : (extracted.title ??
          resolved.title ??
          extractTitleFromText(canonicalContent));

  // Metadata: merge extracted metadata with any existing metadata
  const metadata = extracted.metadata
    ? { ...(extracted.metadata as Record<string, unknown>) }
    : undefined;

  // Node id resolution (source identity is canvas-local).
  const nodeId = resolveNodeId(resolved, contentKind);

  return {
    nodeId,
    label,
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
