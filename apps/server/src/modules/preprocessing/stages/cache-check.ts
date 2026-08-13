// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stage 1.5 — Cache short-circuit (web / pdf only).
 *
 * Re-fetching a web page or re-parsing a PDF is the most expensive work in
 * the pipeline, and Stage 4 enrichment (LLM summary + keywords) compounds
 * the cost. When the node already has cached content on disk and `src` is
 * unchanged, we skip Stages 2-5 entirely and project directly from the
 * cached node.
 *
 * Gated on `src` equality rather than a content hash: before extract runs
 * we have no fresh content to compare against, so the input identity (URL
 * / artifact URI) is the only signal we can trust. `force=true` overrides
 * this — repair / manual triggers may explicitly want a re-extract even
 * when src is unchanged.
 */

import type { SpaceNodes } from '../../storage/index.js';
import type {
  PipelineContext,
  PreprocessDiagnostic,
  ResolvedInput,
} from '../types.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

export type CacheCheckResult = { hit: boolean };

/**
 * Mutates `ctx` to fully populate `extracted` / `normalized` / `enriched` /
 * `persisted` from the cached node sidecar when the cache is warm.
 * Pushes a `CACHE_HIT` diagnostic when it short-circuits.
 *
 * Callers should `return project(...)` immediately when this returns `true`.
 */
export async function tryCacheShortCircuit(
  request: PreprocessNodeRequest,
  resolved: ResolvedInput,
  ctx: PipelineContext,
  diagnostics: PreprocessDiagnostic[],
  nodes: SpaceNodes,
): Promise<boolean> {
  if (request.options?.force) return false;
  if (request.nodeType !== 'web' && request.nodeType !== 'pdf') return false;

  // Web nodes can be backed by either a remote URL (`normalizedUri`) or a
  // local HTML artifact (`artifactUri`); PDF nodes are always artifact-backed.
  const targetSrc =
    request.nodeType === 'web'
      ? (resolved.normalizedUri ?? resolved.artifactUri)
      : resolved.artifactUri;
  if (!targetSrc) return false;

  // Remote PDF URLs pre-date canvas-local PDF snapshots. Let them pass
  // through Extract once so the fetched bytes can be stored in BlobStore and
  // `src` migrated to an artifact key. Once migrated, normal cache reuse
  // resumes because the source is no longer remote.
  if (request.nodeType === 'pdf' && /^https?:\/\//i.test(targetSrc)) {
    return false;
  }

  const existing = (await nodes.read(request.nodeId))?.record ?? null;
  if (
    !existing ||
    existing.content.length === 0 ||
    !existing.src ||
    existing.src !== targetSrc
  ) {
    return false;
  }

  // Migration safeguard: web nodes that pre-date the one-shot MHTML
  // snapshot feature have no `mhtmlArtifact` recorded. Force a fresh
  // extract so the pipeline can write the snapshot artifact for them.
  // Local HTML artifacts (`resolved.filePath` set) and `data:` URLs are
  // already self-contained on disk — they never need an MHTML wrapper.
  if (
    request.nodeType === 'web' &&
    resolved.normalizedUri &&
    typeof (existing as Record<string, unknown>).mhtmlArtifact !== 'string'
  ) {
    return false;
  }

  diagnostics.push({
    code: 'CACHE_HIT',
    level: 'info',
    message: `Reused cached ${request.nodeType} content; src unchanged.`,
  });

  // The persisted markdown is flat YAML — frontmatter fields like
  // `summary` / `keywords` live as top-level properties on the node.
  // Strip the structural fields before treating the rest as the metadata
  // bag the pipeline expects.
  const {
    nodeId: _nid,
    type: _t,
    label: _tt,
    src: _s,
    content: _c,
    ...meta
  } = existing;

  ctx.extracted = {
    content: existing.content,
    title: existing.label ?? undefined,
    metadata: meta,
  };
  ctx.normalized = {
    nodeId: request.nodeId,
    label: existing.label ?? undefined,
    metadata: meta,
    canonicalContent: existing.content,
  };
  ctx.enriched = {
    suggestedLabel: existing.label ?? undefined,
    summary: typeof meta['summary'] === 'string' ? meta['summary'] : undefined,
    keywords: Array.isArray(meta['keywords'])
      ? (meta['keywords'] as string[])
      : undefined,
  };
  ctx.persisted = {
    nodeId: request.nodeId,
    isNew: false,
    contentChanged: false,
    // Cache-hit path: `existing.src === targetSrc` by the guard above.
    // Surface it so Project can still patch the client when its in-memory
    // `data.src` lags behind the canonical form.
    persistedSrc: existing.src ?? undefined,
  };

  return true;
}
