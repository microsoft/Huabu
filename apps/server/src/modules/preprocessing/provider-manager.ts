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
  IMAGE_LABEL_PROMPT,
  buildFrameLabelPrompt,
} from '../../prompt/resolve-label.js';
import { llmComplete } from '../agent/llm.js';
import { resolveArtifactImageUrl } from '../artifact/utils.js';
import { getArtifactsDir } from '../workspace.js';

import type { Context } from '@mariozechner/pi-ai';

export class ProviderManager {
  /**
   * Generate a short semantic label for an image using LLM vision.
   * Returns undefined if generation fails or produces an invalid result.
   */
  async generateImageLabel(src: string): Promise<string | undefined> {
    try {
      const dataUrl = await resolveArtifactImageUrl(src, getArtifactsDir());
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
      const result = await llmComplete(piContext);
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
      const result = await llmComplete(piContext);
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
}
