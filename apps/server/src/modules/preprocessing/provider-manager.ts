// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Provider Manager
 *
 * Text tasks use the default external Profile. Image labeling retains the
 * built-in vision path until the separate multimodal migration.
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
import { isVisionImageMime } from '../../utils/mime.js';
import { runFunctionalText } from '../agent/functional-text.js';
import { llmComplete } from '../agent/llm.js';
import { resolveArtifactImageUrl } from '../artifact/utils.js';

import type { FunctionalTextContext } from '../agent/functional-text.js';
import type { Context } from '@earendil-works/pi-ai';

const contentMetaSchema = z.object({
  label: z.string().trim().min(1).optional(),
  summary: z.string().trim().min(1).optional(),
  keywords: z.array(z.string().trim().min(1)).min(1).optional(),
});

/**
 * Whether an error from an LLM / provider call is a transient connectivity or
 * auth-refresh failure (gateway down, OAuth token refresh failed, network
 * blip, rate limit) rather than a genuine "the model ran but produced nothing
 * usable" outcome.
 *
 * Transient failures are rethrown so the preprocessing pipeline records a
 * retryable `ENRICH_FAILED` diagnostic and does NOT mark the enrich
 * capabilities as done — instead of silently returning `undefined`, which is
 * indistinguishable from "this node has no content worth enriching" and would
 * permanently freeze the node without a label / summary. Genuine empty or
 * unparseable model output stays non-transient (returns `undefined`).
 */
export function isTransientProviderError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /please log in|authentication failed|oauth/i.test(message) ||
    /fetch failed|network|socket hang up|timeout|timed out|econn|etimedout|enotfound|eai_again/i.test(
      message,
    ) ||
    /\b(401|403|408|425|429|500|502|503|504)\b/.test(message)
  );
}

export class ProviderManager {
  /**
   * Generate a short semantic label for an image using LLM vision.
   * Returns undefined if generation fails or produces an invalid result.
   *
   * `defaultCanvasId` is used when `src` is a bare artifact key (the
   * canonical form persisted by the front-end after the bare-key
   * migration) instead of a full canvas-scoped URL.
   */
  async generateImageLabel(
    src: string,
    defaultCanvasId: string | null = null,
  ): Promise<string | undefined> {
    try {
      // Resolve URL → data URL. The local artifact branch reads the bytes
      // from blob storage; remote / data URLs are returned as-is.
      const dataUrl = await resolveArtifactImageUrl(src, defaultCanvasId);
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return undefined;

      const [, mimeType, base64Data] = match;
      if (!isVisionImageMime(mimeType)) return undefined;
      const piContext: Context = {
        systemPrompt: '',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', data: base64Data, mimeType },
              { type: 'text', text: IMAGE_LABEL_PROMPT },
            ],
            timestamp: Date.now(),
          },
        ],
      };
      const result = await llmComplete(piContext, {
        role: 'imageLabel',
        hasImage: true,
      });
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')
        .trim();
      if (text.length > 0 && text.length <= 60) {
        return text;
      }
      return undefined;
    } catch (err) {
      // A transient outage must not be swallowed into a clean skip.
      if (isTransientProviderError(err)) throw err;
      return undefined;
    }
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
