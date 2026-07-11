/**
 * Provider Manager
 *
 * Single entry point for all LLM and external-provider calls made by the
 * preprocessing pipeline. Wraps the existing `llmComplete` from `agent/llm.ts`
 * and the label prompts from `prompt/resolve-label.ts`.
 *
 * Future enhancements: caching, budget limits, batch support.
 */

import {
  buildContentEnrichPrompt,
  type ContentEnrichResult,
} from '../../prompt/enrich.js';
import {
  IMAGE_LABEL_PROMPT,
  buildFrameLabelPrompt,
} from '../../prompt/resolve-label.js';
import { llmComplete } from '../agent/llm.js';
import { resolveArtifactImageUrl } from '../artifact/utils.js';

import type { Context } from '@earendil-works/pi-ai';

export class ProviderManager {
  /**
   * Generate a short semantic label for an image using LLM vision.
   * Returns undefined if generation fails or produces an invalid result.
   *
   * `resolveArtifact` maps `(canvasId, filename)` to an absolute on-disk
   * path, or `null` if the artifact is unknown. `defaultCanvasId` is
   * used when `src` is a bare artifact key (the canonical form persisted
   * by the front-end after the bare-key migration) instead of a full
   * canvas-scoped URL.
   */
  async generateImageLabel(
    src: string,
    resolveArtifact: (canvasId: string, filename: string) => string | null,
    defaultCanvasId: string | null = null,
  ): Promise<string | undefined> {
    try {
      // Resolve URL → data URL. The local artifact branch reads the file
      // via the resolver; remote / data URLs are returned as-is.
      const dataUrl = await resolveArtifactImageUrl(
        src,
        resolveArtifact,
        defaultCanvasId,
      );
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return undefined;

      const [, mimeType, base64Data] = match;
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
    } catch {
      return undefined;
    }
  }

  /**
   * Generate a short thematic label for a frame from its child labels.
   * Returns undefined if generation fails or produces an invalid result.
   */
  async generateFrameLabel(childLabels: string[]): Promise<string | undefined> {
    try {
      const piContext: Context = {
        systemPrompt: '',
        messages: [
          {
            role: 'user',
            content: buildFrameLabelPrompt(childLabels),
            timestamp: Date.now(),
          },
        ],
      };
      const result = await llmComplete(piContext, { role: 'frameLabel' });
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')
        .trim();
      if (text.length > 0 && text.length <= 60) {
        return text;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Enrich text content in a single LLM call: generate label, summary, and
   * keywords together to minimise token expenditure.
   */
  async generateContentMeta(
    content: string,
    opts?: {
      title?: string;
      needLabel?: boolean;
      needSummary?: boolean;
      needKeywords?: boolean;
    },
  ): Promise<ContentEnrichResult | undefined> {
    try {
      if (!content.trim()) return undefined;

      const piContext: Context = {
        systemPrompt: '',
        messages: [
          {
            role: 'user',
            content: buildContentEnrichPrompt(content, opts),
            timestamp: Date.now(),
          },
        ],
      };
      const result = await llmComplete(piContext, { role: 'contentMeta' });
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')
        .trim();
      if (!text) return undefined;

      // Strip markdown fences if the model wraps the JSON
      const cleaned = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      const label =
        typeof parsed.label === 'string' && parsed.label.trim()
          ? parsed.label.trim()
          : undefined;
      const summary =
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : undefined;
      const keywords = Array.isArray(parsed.keywords)
        ? (parsed.keywords.filter(
            (k): k is string => typeof k === 'string' && k.trim().length > 0,
          ) as string[])
        : undefined;

      if (!label && !summary && (!keywords || keywords.length === 0)) {
        return undefined;
      }

      return { label, summary, keywords };
    } catch {
      return undefined;
    }
  }
}
