/**
 * Stage 4 — Enrich
 *
 * ALL LLM and paid semantic work happens here and only here.
 * Currently supports `generate_label` for image and frame nodes.
 */

import type { ProviderManager } from '../provider-manager.js';
import type { EnrichResult, NormalizeResult, ResolvedInput } from '../types.js';
import type { Capability, CanvasNodeKind } from '@sediment/shared';

export async function enrich(
  nodeType: CanvasNodeKind,
  resolved: ResolvedInput,
  _normalized: NormalizeResult | undefined,
  capabilities: Capability[],
  provider: ProviderManager,
): Promise<EnrichResult> {
  const needsLabel = capabilities.includes('generate_label');

  if (!needsLabel) {
    return { skipped: true };
  }

  if (nodeType === 'image') {
    const src = resolved.imageSrc;
    if (!src) return { skipped: true };
    const label = await provider.generateImageLabel(src);
    return { suggestedLabel: label };
  }

  if (nodeType === 'frame') {
    const childLabels = resolved.childLabels;
    if (!childLabels || childLabels.length === 0) return { skipped: true };
    const label = await provider.generateFrameLabel(childLabels);
    return { suggestedLabel: label };
  }

  return { skipped: true };
}
