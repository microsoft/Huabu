/**
 * Preprocessing Pipeline
 *
 * Runs the 6 stages in order, skipping stages whose capabilities are not
 * in the execution plan.
 */

import { randomUUID } from 'node:crypto';

import { enrich } from './stages/enrich.js';
import { extract } from './stages/extract.js';
import { inputResolve } from './stages/input-resolve.js';
import { normalize } from './stages/normalize.js';
import { persist } from './stages/persist.js';
import { project } from './stages/project.js';

import type { ProviderManager } from './provider-manager.js';
import type {
  Capability,
  NodeContentKind,
  PipelineContext,
  PreprocessDiagnostic,
  PreprocessNodeResult,
} from './types.js';
import type { CanvasStore } from '../storage/canvas-store.js';
import type { PreprocessNodeRequest } from '@sediment/shared';

/** Dependencies injected into the pipeline runner. */
export interface PipelineDeps {
  store: CanvasStore;
  provider: ProviderManager;
}

/**
 * Execute the preprocessing pipeline for a single node.
 */
export async function runPipeline(
  request: PreprocessNodeRequest,
  plan: Capability[],
  contentKind: NodeContentKind | undefined,
  deps: PipelineDeps,
): Promise<PreprocessNodeResult> {
  const requestId = randomUUID();
  const ctx: PipelineContext = {};
  const diagnostics: PreprocessDiagnostic[] = [];
  const usedCapabilities: Capability[] = [];

  const has = (cap: Capability) => plan.includes(cap);

  // Stage 1 — Input Resolve
  if (has('resolve_input')) {
    try {
      ctx.resolved = inputResolve(request, deps.store.artifactsDir());
      usedCapabilities.push('resolve_input');
    } catch (error) {
      diagnostics.push({
        code: 'INPUT_RESOLVE_FAILED',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!ctx.resolved) {
    return project(
      request,
      requestId,
      usedCapabilities,
      ctx,
      diagnostics,
      contentKind,
    );
  }

  // Stage 1.5 — Cache short-circuit (web/pdf only).
  //
  // Re-fetching a web page (Tavily Extract) or re-parsing a PDF is the most
  // expensive work in the pipeline, and Stage 4 enrichment (LLM summary +
  // keywords) compounds the cost. When the node already has cached content
  // on disk and `src` has not changed, skip Stages 2-5 entirely and project
  // from the cached node instead.
  //
  // We deliberately gate this on `src` equality rather than a content hash:
  // before extract runs we have no fresh content to compare against, so the
  // input identity (URL / artifact URI) is the only signal we can trust.
  // `force=true` overrides this — repair / manual triggers may explicitly
  // want a re-extract even when src is unchanged.
  if (
    !request.options?.force &&
    contentKind &&
    (request.nodeType === 'web' || request.nodeType === 'pdf')
  ) {
    const targetSrc =
      request.nodeType === 'web'
        ? ctx.resolved.normalizedUri
        : ctx.resolved.artifactUri;
    const existing = targetSrc ? deps.store.readNode(request.nodeId) : null;
    if (
      existing &&
      existing.content.length > 0 &&
      existing.src &&
      existing.src === targetSrc
    ) {
      diagnostics.push({
        code: 'CACHE_HIT',
        level: 'info',
        message: `Reused cached ${request.nodeType} content; src unchanged.`,
      });
      // The persisted markdown is now flat YAML — frontmatter fields like
      // `summary` / `keywords` live as top-level properties on the node.
      // Strip the structural fields (nodeId/type/label/src/content) before
      // treating the rest as the metadata bag the pipeline expects.
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
        summary:
          typeof meta['summary'] === 'string' ? meta['summary'] : undefined,
        keywords: Array.isArray(meta['keywords'])
          ? (meta['keywords'] as string[])
          : undefined,
      };
      ctx.persisted = {
        nodeId: request.nodeId,
        isNew: false,
        contentChanged: false,
      };
      return project(
        request,
        requestId,
        usedCapabilities,
        ctx,
        diagnostics,
        contentKind,
      );
    }
  }

  // Stage 2 — Extract
  if (has('extract_text') || has('fetch_remote_content')) {
    try {
      ctx.extracted = await extract(ctx.resolved);
      if (has('extract_text')) usedCapabilities.push('extract_text');
      if (has('fetch_remote_content'))
        usedCapabilities.push('fetch_remote_content');
    } catch (error) {
      diagnostics.push({
        code: 'EXTRACT_FAILED',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  // Stage 3 — Normalize
  if (
    has('compute_fingerprint') ||
    has('resolve_title') ||
    has('merge_metadata')
  ) {
    try {
      ctx.normalized = normalize(
        ctx.resolved,
        ctx.extracted ?? { skipped: true },
        contentKind,
      );
      if (has('compute_fingerprint'))
        usedCapabilities.push('compute_fingerprint');
      if (has('resolve_title')) usedCapabilities.push('resolve_title');
      if (has('merge_metadata')) usedCapabilities.push('merge_metadata');
    } catch (error) {
      diagnostics.push({
        code: 'NORMALIZE_FAILED',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Stage 4 — Enrich
  if (
    has('generate_label') ||
    has('generate_summary') ||
    has('generate_keywords')
  ) {
    const allowLLM =
      request.options?.allowLLM !== false &&
      request.options?.mode !== 'interactive';
    if (allowLLM) {
      try {
        ctx.enriched = await enrich(
          request.nodeType,
          ctx.resolved,
          ctx.normalized,
          plan,
          deps.provider,
          deps.store.artifactsDir(),
        );
        if (has('generate_label')) usedCapabilities.push('generate_label');
        if (has('generate_summary')) usedCapabilities.push('generate_summary');
        if (has('generate_keywords'))
          usedCapabilities.push('generate_keywords');

        // Merge enriched summary and keywords into normalized metadata so they are persisted
        if (ctx.enriched?.summary && ctx.normalized) {
          ctx.normalized.metadata = {
            ...ctx.normalized.metadata,
            summary: ctx.enriched.summary,
          };
        }
        if (ctx.enriched?.keywords?.length && ctx.normalized) {
          ctx.normalized.metadata = {
            ...ctx.normalized.metadata,
            keywords: ctx.enriched.keywords,
          };
        }

        // When the extracted document has no title, use the LLM-generated
        // label as the normalized label so the canvas list and source list
        // stay in sync.
        if (
          !ctx.normalized?.label &&
          ctx.enriched?.suggestedLabel &&
          ctx.normalized
        ) {
          ctx.normalized.label = ctx.enriched.suggestedLabel;
        }
      } catch (error) {
        diagnostics.push({
          code: 'ENRICH_FAILED',
          level: 'warning',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    } else {
      ctx.enriched = { skipped: true };
      diagnostics.push({
        code: 'ENRICH_SKIPPED',
        level: 'info',
        message: 'LLM enrichment disabled by request options',
      });
    }
  }

  // Stage 5 — Persist
  // When extraction failed the node is still visible on the canvas, so we
  // persist a placeholder source (empty content + error metadata) to ensure
  // the node still has a stable record under its nodeId and can be retried
  // later.
  const extractFailed = diagnostics.some(
    (d) => d.code === 'EXTRACT_FAILED' && d.level === 'error',
  );
  if (has('persist_source') && ctx.normalized) {
    const allowPersistence = request.options?.allowPersistence !== false;
    if (allowPersistence) {
      try {
        const src = ctx.resolved?.normalizedUri ?? ctx.resolved?.artifactUri;

        if (extractFailed) {
          // Persist a placeholder with empty content so the node still has
          // a record keyed by its nodeId. Store the extraction error in
          // metadata for debugging.
          const placeholderNormalized = {
            ...ctx.normalized,
            canonicalContent: '',
            metadata: {
              ...ctx.normalized.metadata,
              placeholder: true,
              extractError: diagnostics
                .filter((d) => d.code === 'EXTRACT_FAILED')
                .map((d) => d.message)
                .join('; '),
            },
          };
          ctx.persisted = persist(
            placeholderNormalized,
            contentKind,
            deps.store,
            src,
          );
          ctx.persisted.placeholder = true;
          diagnostics.push({
            code: 'PERSIST_PLACEHOLDER',
            level: 'info',
            message:
              'Persisted placeholder source because extraction failed — content is empty',
          });
        } else {
          ctx.persisted = persist(ctx.normalized, contentKind, deps.store, src);
        }
        usedCapabilities.push('persist_source');
      } catch (error) {
        diagnostics.push({
          code: 'PERSIST_FAILED',
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    } else {
      ctx.persisted = { skipped: true };
    }
  }

  // Stage 6 — Project
  if (has('build_patch')) {
    usedCapabilities.push('build_patch');
  }
  return project(
    request,
    requestId,
    usedCapabilities,
    ctx,
    diagnostics,
    contentKind,
  );
}
