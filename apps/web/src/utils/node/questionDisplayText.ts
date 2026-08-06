// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Max characters of the first message shown on a question node while the
 * generated label is still pending. Bounds the auto-sized footprint so a very
 * long first message does not make the node much larger than its eventual
 * concise label.
 */
const QUESTION_PREVIEW_MAX_CHARS = 80;

/** Trim the first-message fallback to a short, single-block preview. */
export function truncateQuestionPreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= QUESTION_PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, QUESTION_PREVIEW_MAX_CHARS).trimEnd()}…`;
}

/** Return the exact text a QuestionNode renders on the canvas. */
export function getQuestionDisplayText(data: {
  label?: unknown;
  content?: unknown;
}): string {
  const label = typeof data.label === 'string' ? data.label.trim() : '';
  if (label) return label;
  const content = typeof data.content === 'string' ? data.content : '';
  return truncateQuestionPreview(content);
}
