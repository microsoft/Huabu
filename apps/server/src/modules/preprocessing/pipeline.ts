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
import type { PipelineContext } from './types.js';
import type { IKnowledgeRepository } from '../knowledge/knowledge.interface.js';
import type {
  Capability,
  PreprocessDiagnostic,
  PreprocessNodeRequest,
  PreprocessNodeResult,
  SourceKind,
} from '@sediment/shared';

/** Dependencies injected into the pipeline runner. */
export interface PipelineDeps {
  repository: IKnowledgeRepository;
  provider: ProviderManager;
  artifactsDir: string;
}

/**
 * Execute the preprocessing pipeline for a single node.
 */
export async function runPipeline(
  request: PreprocessNodeRequest,
  plan: Capability[],
  sourceKind: SourceKind | undefined,
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
      ctx.resolved = inputResolve(request, deps.artifactsDir);
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
      sourceKind,
    );
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
        sourceKind,
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
        );
        if (has('generate_label')) usedCapabilities.push('generate_label');
        if (has('generate_summary')) usedCapabilities.push('generate_summary');
        if (has('generate_keywords'))
          usedCapabilities.push('generate_keywords');

        // Merge enriched summary into normalized metadata so it is persisted
        if (ctx.enriched?.summary && ctx.normalized) {
          ctx.normalized.metadata = {
            ...ctx.normalized.metadata,
            summary: ctx.enriched.summary,
          };
        }

        // When extracted title is missing, use the LLM-generated label as
        // the persisted Source.title so canvas list and source list stay in sync.
        if (
          !ctx.normalized?.title &&
          ctx.enriched?.suggestedLabel &&
          ctx.normalized
        ) {
          ctx.normalized.title = ctx.enriched.suggestedLabel;
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
  // the node gets a stable sourceId and can be retried later.
  const extractFailed = diagnostics.some(
    (d) => d.code === 'EXTRACT_FAILED' && d.level === 'error',
  );
  if (has('persist_source') && ctx.normalized) {
    const allowPersistence = request.options?.allowPersistence !== false;
    if (allowPersistence) {
      try {
        const src = ctx.resolved?.normalizedUri ?? ctx.resolved?.artifactUri;

        if (extractFailed) {
          // Persist a placeholder with empty content so the node still gets
          // a sourceId. Store the extraction error in metadata for debugging.
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
            sourceKind,
            deps.repository,
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
          ctx.persisted = persist(
            ctx.normalized,
            sourceKind,
            deps.repository,
            src,
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
    sourceKind,
  );
}
