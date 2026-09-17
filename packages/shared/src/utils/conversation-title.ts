// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const MAX_TITLE_LENGTH = 120;

function normalizeWhitespace(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim() || null;
}

/** Normalize host/manual titles, preserving the existing truncation policy. */
export function normalizeConversationTitle(value: unknown): string | null {
  return normalizeWhitespace(value)?.slice(0, MAX_TITLE_LENGTH) ?? null;
}

/** Accept nonempty, single-line ACP titles within the limit. */
export function normalizeAcpConversationTitle(value: unknown): string | null {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
  const title = normalizeWhitespace(value);
  if (!title || title.length > MAX_TITLE_LENGTH) return null;
  return title;
}

/** Strip common inline Markdown formatting so the title reads as plain text. */
export function stripInlineMarkdown(text: string): string {
  return (
    text
      // Leading list markers must be removed before bold/italic markers.
      .replace(/^(?:>\s*)+/, '')
      .replace(/^(?:[-*+]|\d+\.)\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*{1,3}(.+?)\*{1,3}/g, '$1')
      .replace(/_{1,3}(.+?)_{1,3}/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .trim()
  );
}

/** First heading, otherwise first nonempty line, stripped and capped at 50 characters. */
export function extractTitleFromText(content: string): string | undefined {
  const lines = content.split('\n');
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) return stripInlineMarkdown(heading[1]).slice(0, 50);
  }
  const firstLine = lines.find((line) => line.trim().length > 0)?.trim();
  return firstLine ? stripInlineMarkdown(firstLine).slice(0, 50) : undefined;
}
