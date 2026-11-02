// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Prompts for LLM-powered content enrichment.
 */

import { Lexer } from 'marked';

import { stripMarkdown } from '@huabu/shared/canvas-engine';

/** Structured result returned by the unified enrich prompt. */
export interface ContentEnrichResult {
  label?: string;
  summary?: string;
  keywords?: string[];
}

const SUMMARY_CONTENT_BUDGET = 6000;
const EXCERPT_SEPARATOR = '\n\n[...]\n\n';
const SUMMARY_HEADINGS = [
  /^(?:abstract|summary)\b|^(?:摘要|概要)/i,
  /^(?:results?|findings?)\b|^(?:研究结果|实验结果|结果|研究发现)/i,
  /^(?:conclusions?)\b|^(?:结论|总结)/i,
  /^(?:limitations?|caveats?)\b|^(?:局限性|局限|研究限制|限制)/i,
];

function clipExcerpt(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/** Select bounded source evidence locally; no additional model call. */
function summaryExcerpt(content: string): string {
  if (content.length <= SUMMARY_CONTENT_BUDGET) return content;
  const tokens = Lexer.lex(content);
  const sections = new Map<number, { start: number; end: number }>();
  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    if (token.type !== 'heading') continue;
    const title = stripMarkdown(token.text)
      .replace(
        /^(?:\d+(?:\.\d+)*[.)、]?\s*|[一二三四五六七八九十]+[、.]\s*)/,
        '',
      )
      .trim();
    const category = SUMMARY_HEADINGS.findIndex((pattern) =>
      pattern.test(title),
    );
    if (category < 0 || sections.has(category)) continue;
    let end = start + 1;
    while (end < tokens.length) {
      const next = tokens[end];
      if (next.type === 'heading' && next.depth <= token.depth) break;
      end += 1;
    }
    if (tokens.slice(start + 1, end).some((part) => part.raw.trim())) {
      sections.set(category, { start, end });
    }
  }
  // shortcut: heading heuristics can miss relevant text; use explicit full-document work when coverage matters.
  if (sections.size === 0) {
    const available = SUMMARY_CONTENT_BUDGET - EXCERPT_SEPARATOR.length;
    const head = Math.ceil(available / 2);
    return (
      clipExcerpt(content, head) +
      EXCERPT_SEPARATOR +
      content.slice(-(available - head)).replace(/^[\uDC00-\uDFFF]/, '')
    );
  }
  const ordered = [...sections.values()].sort((a, b) => a.start - b.start);
  const snippets = ordered.map(({ start, end }, index) => ({
    text: tokens
      .slice(start, Math.min(end, ordered[index + 1]?.start ?? end))
      .map((token) => token.raw)
      .join('')
      .trim(),
  }));
  let remaining =
    SUMMARY_CONTENT_BUDGET - EXCERPT_SEPARATOR.length * (snippets.length - 1);
  // Allocate short sections first so unused space remains available to longer ones.
  [...snippets]
    .sort((a, b) => a.text.length - b.text.length)
    .forEach((snippet, index) => {
      snippet.text = clipExcerpt(
        snippet.text,
        Math.floor(remaining / (snippets.length - index)),
      );
      remaining -= snippet.text.length;
    });
  return snippets.map(({ text }) => text).join(EXCERPT_SEPARATOR);
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
    ? summaryExcerpt(content)
    : content.length > 4000
      ? content.slice(0, 4000) + '…'
      : content;
  const coverageHint =
    trimmed !== content
      ? 'The content below contains excerpts, not the full document. Summarize only the supplied evidence; do not infer missing findings or treat omitted caveats as absent.\n\n'
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
