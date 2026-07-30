/**
 * Preprocessing Pipeline
 *
 * Runs the 6 stages in order, skipping stages whose capabilities are not
 * in the execution plan.
 */

import { randomUUID } from 'node:crypto';

import { createId } from '@sediment/shared';

import { wrapAsMhtml } from '../web/mhtml.js';
import { tryCacheShortCircuit } from './stages/cache-check.js';
import { enrich } from './stages/enrich.js';
import { extract } from './stages/extract.js';
import { inputResolve } from './stages/input-resolve.js';
import { normalize } from './stages/normalize.js';
import { persist } from './stages/persist.js';
import { project } from './stages/project.js';

import type { ProviderManager } from './provider-manager.js';
import type {
  BodyOwnership,
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
  bodyOwnership: BodyOwnership | undefined,
  deps: PipelineDeps,
): Promise<PreprocessNodeResult> {
  const requestId = randomUUID();
  const ctx: PipelineContext = {};
  const diagnostics: PreprocessDiagnostic[] = [];
  const usedCapabilities: Capability[] = [];

  const has = (cap: Capability) => plan.includes(cap);

  // Manifest-aware artifact resolver. URL keys (`<artifactId><ext>`) are
  // mapped to absolute on-disk paths via the canvas artifact index, so
  // display-name renames don't break preprocessing.
  const resolveArtifactByName = (filename: string): string | null =>
    deps.store.resolveArtifactFilePath(filename);
  const resolveArtifactForCanvas = (
    _canvasId: string,
    filename: string,
  ): string | null => resolveArtifactByName(filename);

  // Stage 1 — Input Resolve
  if (has('resolve_input')) {
    try {
      ctx.resolved = inputResolve(request, resolveArtifactByName);
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

  // Stage 1.5 — Cache short-circuit (web/pdf only). When the node already
  // has cached content on disk and `src` is unchanged, skip Stages 2-5 and
  // project directly from the cached node. See `stages/cache-check.ts`.
  if (
    tryCacheShortCircuit(request, ctx.resolved, ctx, diagnostics, deps.store)
  ) {
    return project(
      request,
      requestId,
      usedCapabilities,
      ctx,
      diagnostics,
      contentKind,
    );
  }

  // Stage 2 — Extract
  if (has('extract_text') || has('fetch_remote_content')) {
    try {
      ctx.extracted = await extract(ctx.resolved);
      if (has('extract_text')) usedCapabilities.push('extract_text');
      if (has('fetch_remote_content'))
        usedCapabilities.push('fetch_remote_content');

      // Web one-shot snapshot: persist the fetched HTML as a `.mhtml`
      // artifact so subsequent renders can load from disk instead of
      // re-hitting the live URL. Only fires when the loader actually
      // performed a network fetch (i.e. `rawHtml` is set) and the
      // resolved input is a remote URL. Failures are non-fatal — the
      // node still works in degraded "refetch every time" mode.
      if (
        request.nodeType === 'web' &&
        ctx.extracted?.rawHtml &&
        ctx.resolved.normalizedUri
      ) {
        try {
          const artifactId = createId('artifact');
          const ext = '.mhtml';
          const buffer = wrapAsMhtml(
            ctx.extracted.rawHtml,
            ctx.resolved.normalizedUri,
            typeof ctx.extracted.title === 'string'
              ? ctx.extracted.title
              : ctx.resolved.normalizedUri,
          );
          const record = await deps.store.writeArtifactBuffer(
            { id: artifactId, ext, mimeType: 'message/rfc822' },
            buffer,
          );
          // Inject the artifact key into metadata so the Normalize →
          // Persist chain writes it as a top-level YAML field on the
          // node sidecar. The web route reads `mhtmlArtifact` directly
          // from frontmatter to point the iframe at the snapshot.
          ctx.extracted = {
            ...ctx.extracted,
            metadata: {
              ...(ctx.extracted.metadata ?? {}),
              mhtmlArtifact: record.filename,
            },
          };
        } catch (snapshotError) {
          diagnostics.push({
            code: 'SNAPSHOT_FAILED',
            level: 'warning',
            message:
              snapshotError instanceof Error
                ? snapshotError.message
                : String(snapshotError),
          });
        }
        // Drop rawHtml before normalize so it never round-trips into the
        // frontmatter.
        if (ctx.extracted) {
          const { rawHtml: _rawHtml, ...rest } = ctx.extracted;
          ctx.extracted = rest;
        }
      }
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
  // Normalize builds the canonical record (`ctx.normalized`) that Persist
  // writes and Enrich reads. Run it whenever a downstream stage will consume
  // that record — the node will persist a sidecar or run LLM enrichment — or
  // when title / metadata resolution is explicitly requested. (Replaces the
  // former `compute_fingerprint` gate, a vestige of a removed content-hash
  // step; the real content-change dedup lives in Persist as a string compare.)
  if (
    has('persist_source') ||
    has('generate_label') ||
    has('generate_summary') ||
    has('generate_keywords') ||
    has('resolve_title') ||
    has('merge_metadata')
  ) {
    try {
      ctx.normalized = normalize(
        ctx.resolved,
        ctx.extracted ?? { skipped: true },
        contentKind,
      );
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
          resolveArtifactForCanvas,
          deps.store.canvasId,
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
          ctx.persisted = await persist(
            placeholderNormalized,
            contentKind,
            bodyOwnership,
            deps.store,
            src,
            true,
          );
          ctx.persisted.placeholder = true;
          diagnostics.push({
            code: 'PERSIST_PLACEHOLDER',
            level: 'info',
            message:
              'Persisted placeholder source because extraction failed — content is empty',
          });
        } else {
          ctx.persisted = await persist(
            ctx.normalized,
            contentKind,
            bodyOwnership,
            deps.store,
            src,
            true,
          );
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
