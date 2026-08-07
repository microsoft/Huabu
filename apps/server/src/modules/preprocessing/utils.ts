// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Normalize URL for consistent hashing of web sources.
 * - Remove query parameters
 * - Normalize protocol (http/https)
 * - Remove trailing slashes
 * - Lowercase domain
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize protocol to https
    parsed.protocol = 'https:';
    // Remove search params and hash
    parsed.search = '';
    parsed.hash = '';
    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();
    // Remove trailing slash from pathname
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    return parsed.toString();
  } catch {
    // If URL parsing fails, return lowercased original
    return url.toLowerCase().trim();
  }
}

/** Strip common inline Markdown formatting so the title reads as plain text. */
export function stripInlineMarkdown(text: string): string {
  return (
    text
      // leading blockquote >
      .replace(/^(?:>\s*)+/, '')
      // leading list markers (- * + 1.)  — must run before bold/italic
      // so that `* **bold**` doesn't mis-pair the list `*` with bold.
      .replace(/^(?:[-*+]|\d+\.)\s+/, '')
      // images ![alt](url) → alt
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // links [text](url) → text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // bold / italic  ** __ * _
      .replace(/\*{1,3}(.+?)\*{1,3}/g, '$1')
      .replace(/_{1,3}(.+?)_{1,3}/g, '$1')
      // strikethrough ~~text~~
      .replace(/~~(.+?)~~/g, '$1')
      // inline code `code`
      .replace(/`(.+?)`/g, '$1')
      .trim()
  );
}

/**
 * Extract a title from plain text or markdown content: the first heading, or
 * the first non-empty line, stripped of inline markdown and capped at 50 chars.
 * Returns undefined for empty / whitespace-only content.
 */
export function extractTitleFromText(content: string): string | undefined {
  const lines = content.split('\n');
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) return stripInlineMarkdown(heading[1]).slice(0, 50);
  }
  const firstLine = lines.find((l) => l.trim().length > 0)?.trim();
  return firstLine ? stripInlineMarkdown(firstLine).slice(0, 50) : undefined;
}
