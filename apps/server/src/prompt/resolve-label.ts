// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Prompts for LLM-powered semantic label resolution.
 */

/**
 * Vision prompt — asks the LLM to describe an image in a few words
 * suitable for a canvas node label.
 */
export const IMAGE_LABEL_PROMPT =
  'Describe this image in 1-5 words for use as a short label. Reply with ONLY the label text, no quotes or punctuation.';

/**
 * Frame summarisation prompt template.
 * Use `buildFrameLabelPrompt(childLabels)` to produce the final string.
 */
export function buildFrameLabelPrompt(childLabels: string[]): string {
  const joined = childLabels.join(', ');
  return `Given these items in a group: [${joined}]\n\nSuggest a short group name (1-5 words) that captures the common theme. Reply with ONLY the group name, no quotes or punctuation.`;
}
