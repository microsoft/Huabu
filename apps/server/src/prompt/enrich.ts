// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Prompts for LLM-powered content enrichment.
 */

/** Structured result returned by the unified enrich prompt. */
export interface ContentEnrichResult {
  label?: string;
  summary?: string;
  keywords?: string[];
}

/**
 * Build a prompt that asks the LLM to produce label, summary, and keywords
 * for text content in a single request.  Returns JSON.
 */
export function buildContentEnrichPrompt(
  content: string,
  opts?: {
    title?: string;
    needLabel?: boolean;
    needSummary?: boolean;
    needKeywords?: boolean;
  },
): string {
  const {
    title,
    needLabel = true,
    needSummary = true,
    needKeywords = true,
  } = opts ?? {};
  const titleHint = title ? `Title: ${title}\n\n` : '';
  // Limit content to ~4000 chars to stay within reasonable token budgets.
  const trimmed =
    content.length > 4000 ? content.slice(0, 4000) + '…' : content;

  const fields: string[] = [];
  if (needLabel) {
    fields.push(
      '"label": a short descriptive name for this content (3-8 words, no URL)',
    );
  }
  if (needSummary) {
    fields.push(
      '"summary": a concise summary in 2-4 sentences covering key points. Focus on the key points and main ideas.',
    );
  }
  if (needKeywords) {
    fields.push(
      '"keywords": a concise set of 3-6 standardized keywords that accurately reflect the content’s main topic, methodology, and application domain, using established terminology and optimized for search and indexing.',
    );
  }

  return (
    titleHint +
    `Content:\n${trimmed}\n\n` +
    'Analyze the above content and respond with a JSON object containing:\n' +
    fields.map((f) => `- ${f}`).join('\n') +
    '\n\nRespond with ONLY valid JSON, no markdown fences or extra text.'
  );
}
