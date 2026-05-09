/**
 * Stage 6 — Project
 *
 * Assembles the authoritative PreprocessNodeResult and node patch
 * from the outputs of all previous stages.
 */

import type {
  Capability,
  NodeContentKind,
  PipelineContext,
  PreprocessDiagnostic,
  PreprocessNodeResult,
} from '../types.js';
import type { PreprocessNodeRequest } from '@sediment/shared';

export function project(
  request: PreprocessNodeRequest,
  requestId: string,
  usedCapabilities: Capability[],
  ctx: PipelineContext,
  diagnostics: PreprocessDiagnostic[],
  contentKind?: NodeContentKind,
): PreprocessNodeResult {
  const patch: Record<string, unknown> = {};

  // Apply suggested label from enrich or extract stage, but only when the
  // user has not manually set the label.
  // Prefer extracted title (e.g. HTML <title>), fallback to LLM-generated label.
  const snapshotLabelSource = request.snapshot.labelSource as
    | string
    | undefined;
  if (snapshotLabelSource !== 'user' && snapshotLabelSource !== 'agent') {
    const autoLabel = ctx.extracted?.title ?? ctx.enriched?.suggestedLabel;
    if (autoLabel) {
      patch.label = autoLabel;
      patch.labelSource = 'auto';
    }
  }

  const hasError = diagnostics.some((d) => d.level === 'error');
  const hasPersist = ctx.persisted && !ctx.persisted.skipped;
  const hasEnrich = ctx.enriched && !ctx.enriched.skipped;

  let status: PreprocessNodeResult['status'];
  if (hasError) {
    status = 'error';
  } else if (hasPersist || hasEnrich) {
    status = 'success';
  } else if (usedCapabilities.length === 0) {
    status = 'skipped';
  } else {
    status = 'partial';
  }

  return {
    nodeId: request.nodeId,
    nodeType: request.nodeType,
    trigger: request.trigger,
    requestId,
    success: !hasError,
    status,
    usedCapabilities,
    extracted: ctx.extracted?.skipped
      ? undefined
      : {
          title: ctx.extracted?.title,
          content: ctx.extracted?.content,
          metadata: ctx.extracted?.metadata,
        },
    enriched: ctx.enriched?.skipped
      ? undefined
      : {
          suggestedLabel: ctx.enriched?.suggestedLabel,
          summary: ctx.enriched?.summary,
          keywords: ctx.enriched?.keywords,
        },
    persistence: ctx.persisted?.skipped
      ? undefined
      : {
          contentKind,
          isNew: ctx.persisted?.isNew,
          contentChanged: ctx.persisted?.contentChanged,
          placeholder: ctx.persisted?.placeholder,
        },
    patch,
    diagnostics,
  };
}
