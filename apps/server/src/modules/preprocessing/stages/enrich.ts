// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stage 4 — Enrich
 *
 * ALL LLM and paid semantic work happens here and only here.
 * - Image / frame nodes: single-purpose label generation.
 * - Text-based nodes (web, pdf, note, text): unified single-call enrichment
 *   that produces label, summary, and keywords together.
 */

import type { ProviderManager } from '../provider-manager.js';
import type {
  Capability,
  EnrichResult,
  NormalizeResult,
  ResolvedInput,
} from '../types.js';
import type { CanvasNodeType } from '@huabu/shared';

const TEXT_NODE_TYPES: ReadonlySet<string> = new Set([
  'web',
  'pdf',
  'note',
  'text',
  'question',
]);

export async function enrich(
  nodeType: CanvasNodeType,
  resolved: ResolvedInput,
  normalized: NormalizeResult | undefined,
  capabilities: Capability[],
  provider: ProviderManager,
  canvasId: string,
): Promise<EnrichResult> {
  const needsLabel = capabilities.includes('generate_label');
  const needsSummary = capabilities.includes('generate_summary');
  const needsKeywords = capabilities.includes('generate_keywords');

  if (!needsLabel && !needsSummary && !needsKeywords) {
    return { skipped: true };
  }

  // ── Text-based nodes: unified single LLM call ──────────────────────
  if (TEXT_NODE_TYPES.has(nodeType)) {
    const content =
      normalized?.canonicalContent ??
      resolved.content ??
      resolved.prefetchedContent;
    if (!content || !content.trim()) {
      return { skipped: true };
    }

    const result = await provider.generateContentMeta(content, {
      title: normalized?.label ?? resolved.title,
      needLabel: needsLabel,
      needSummary: needsSummary,
      needKeywords: needsKeywords,
    });

    if (!result) {
      return { skipped: true };
    }

    return {
      suggestedLabel: result.label,
      summary: result.summary,
      keywords: result.keywords,
    };
  }

  // ── Non-text nodes: dedicated label generation ─────────────────────
  if (needsLabel) {
    if (nodeType === 'image') {
      const src = resolved.imageSrc;
      if (src) {
        const label = await provider.generateImageLabel(src, canvasId);
        return label ? { suggestedLabel: label } : { skipped: true };
      }
    } else if (nodeType === 'frame') {
      const childLabels = resolved.childLabels;
      if (childLabels && childLabels.length > 0) {
        const label = await provider.generateFrameLabel(childLabels);
        return label ? { suggestedLabel: label } : { skipped: true };
      }
    }
  }

  return { skipped: true };
}
