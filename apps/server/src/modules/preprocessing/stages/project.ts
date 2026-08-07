/**
 * Stage 6 — Project
 *
 * Assembles the authoritative PreprocessNodeResult and node patch
 * from the outputs of all previous stages.
 */

import { normalizeForCompare } from '../../workspace/disk/naming.js';
import { isLabelProtected } from '../label-policy.js';

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
  // label is not already user/agent-owned.
  //
  // Prefer the post-dedup label from the Persist stage when available:
  // `writeNode` returns the actually-on-disk label (e.g. "Huabu (3)" when
  // another node already owns "Huabu"). Surfacing that as the suggestion
  // means the client applies the final form in one step, instead of
  // briefly rendering the un-deduped base ("Huabu") and then snapping to
  // the deduped form once the next content-save round-trips. For nodes
  // that skip Persist (image, frame, …) fall back to the raw extracted /
  // enriched label.
  if (!isLabelProtected(request.snapshot.labelSource, request.snapshot.title)) {
    // `ctx.normalized.label` is the last-resort local fallback (e.g. a
    // `question`'s first line when the LLM enrich stage produced nothing —
    // offline / provider unreachable), so the node is never left nameless.
    const rawAutoLabel =
      ctx.extracted?.title ??
      ctx.enriched?.suggestedLabel ??
      ctx.normalized?.label;
    const autoLabel = ctx.persisted?.persistedLabel ?? rawAutoLabel;
    if (autoLabel) {
      // Skip when the suggestion already matches the snapshot label
      // (case-insensitive, NFC-normalized to match `dedupeName`'s
      // own comparison key). This avoids a redundant `patch.label`
      // round-trip on every preprocess pass for stable nodes.
      const snapshotLabel =
        typeof request.snapshot.title === 'string'
          ? request.snapshot.title
          : '';
      const isSame =
        snapshotLabel !== '' &&
        normalizeForCompare(snapshotLabel) === normalizeForCompare(autoLabel);
      if (!isSame) {
        patch.label = autoLabel;
        patch.labelSource = 'auto';
      }
    }
  }

  // Surface the post-Persist canonical `src` whenever it diverges from
  // what the client sent in the snapshot. Typical sources of divergence:
  //   • web nodes: URL normalization strips utm / fragment / trailing
  //     slashes, so the persisted form may differ from the user-pasted
  //     URL.
  //   • pdf nodes: the snapshot may carry a transient local path while
  //     the persisted form is the canvas-scoped artifact URL.
  // Without this patch the client keeps its un-normalized `data.src`
  // until the next canvas reload re-hydrates it from the markdown
  // sidecar — visible as a brief disagreement between the URL the user
  // sees on the node and the one that was actually saved.
  const persistedSrc = ctx.persisted?.persistedSrc;
  if (typeof persistedSrc === 'string' && persistedSrc.length > 0) {
    const snapshotSrc =
      typeof request.snapshot.src === 'string' ? request.snapshot.src : '';
    if (snapshotSrc !== persistedSrc) {
      patch.src = persistedSrc;
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
