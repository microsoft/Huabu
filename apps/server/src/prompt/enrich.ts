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

const SUMMARY_CONTENT_BUDGET = 6000;

function clipExcerpt(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
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
  const trimmed = needSummary
    ? clipExcerpt(content, SUMMARY_CONTENT_BUDGET)
    : content.length > 4000
      ? content.slice(0, 4000) + '…'
      : content;
  const coverageHint =
    trimmed !== content
      ? 'The content below is an opening excerpt, not the full document. Summarize only the supplied evidence; do not infer missing findings or treat omitted caveats as absent.\n\n'
      : '';

  const fields: string[] = [];
  if (needLabel) {
    fields.push(
      '"label": a short descriptive name for this content (3-8 words, no URL)',
    );
  }
  if (needSummary) {
    fields.push(
      '"summary": a compact Markdown string (at most 400 characters) stating the actual findings, decisions, facts, or next steps, not introducing or describing the document. Choose 1-2 short paragraphs or 2-4 bullet/numbered items according to the content; do not force a list. Preserve important uncertainty and caveats, and never invent conclusions. Use only paragraphs and flat lists, with no headings, images, HTML, tables, or code blocks. Avoid openings such as "This document describes" or "This is a guide to".',
    );
  }
  if (needKeywords) {
    fields.push(
      '"keywords": a concise set of 3-6 standardized keywords that accurately reflect the content’s main topic, methodology, and application domain, using established terminology and optimized for search and indexing.',
    );
  }

  return (
    titleHint +
    coverageHint +
    `Content:\n${trimmed}\n\n` +
    'Analyze the above content and respond with a JSON object containing:\n' +
    fields.map((f) => `- ${f}`).join('\n') +
    '\n\nRespond with ONLY valid JSON, no markdown fences or extra text.'
  );
}
