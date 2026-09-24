// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Provider Manager
 *
 * Text and image metadata tasks use the default external Profile.
 */

import { z } from 'zod';

import {
  buildContentEnrichPrompt,
  type ContentEnrichResult,
} from '../../prompt/enrich.js';
import {
  IMAGE_LABEL_PROMPT,
  buildFrameLabelPrompt,
} from '../../prompt/resolve-label.js';
import { resolveImageUrl } from '../agent/conversation/prompt/image-inlining.js';
import { runFunctionalText } from '../agent/functional-text.js';

import type { FunctionalTextContext } from '../agent/functional-text.js';

const contentMetaSchema = z.object({
  label: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  keywords: z.array(z.string().trim().min(1)).min(1).optional(),
});

export class ProviderManager {
  /**
   * Reuse chat image resolution and ACP input blocks for image labeling.
   * Failures propagate so preprocessing retains retryable diagnostics.
   */
  async generateImageLabel(src: string, canvasId: string): Promise<string> {
    const image = await resolveImageUrl(src, canvasId);
    if (image.kind !== 'inline' || !image.data) {
      throw new Error(
        `Image label input unavailable: ${image.kind === 'skipped' ? image.reason : 'empty image'}`,
      );
    }
    const text = (
      await runFunctionalText(IMAGE_LABEL_PROMPT, {
        canvasId,
        images: [{ type: 'image', data: image.data, mimeType: image.mimeType }],
      })
    ).trim();
    if (!text || text.length > 60 || /[\r\n]/.test(text)) {
      throw new Error('External Agent returned an invalid image title');
    }
    return text;
  }

  /**
   * Generate a short thematic label for a frame from its child labels.
   * Rejects unavailable agents and invalid output so callers retain retryability.
   */
  async generateFrameLabel(
    childLabels: string[],
    context: FunctionalTextContext,
  ): Promise<string> {
    const text = (
      await runFunctionalText(buildFrameLabelPrompt(childLabels), context)
    ).trim();
    if (!text || text.length > 60 || /[\r\n]/.test(text)) {
      throw new Error('External Agent returned an invalid Frame title');
    }
    return text;
  }

  /**
   * Enrich text content in a single LLM call: generate label, summary, and
   * keywords together to minimise token expenditure.
   */
  async generateContentMeta(
    content: string,
    opts: {
      title?: string;
      needLabel?: boolean;
      needSummary?: boolean;
      needKeywords?: boolean;
    },
    context: FunctionalTextContext,
  ): Promise<ContentEnrichResult | undefined> {
    if (!content.trim()) return undefined;
    const text = await runFunctionalText(
      buildContentEnrichPrompt(content, opts),
      context,
    );
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    const parsed = contentMetaSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success) {
      throw new Error(
        `External Agent returned invalid text metadata: ${parsed.error.message}`,
      );
    }
    const { label, summary, keywords } = parsed.data;
    if (
      (opts.needLabel !== false && !label) ||
      (opts.needSummary !== false && !summary) ||
      (opts.needKeywords !== false && !keywords)
    ) {
      throw new Error('External Agent omitted requested text metadata');
    }
    return {
      ...(opts.needLabel !== false ? { label } : {}),
      ...(opts.needSummary !== false ? { summary } : {}),
      ...(opts.needKeywords !== false ? { keywords } : {}),
    };
  }
}
