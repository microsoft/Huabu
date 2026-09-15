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

// Preserve preprocessing imports while sharing the exact policy with Chat.
export {
  extractTitleFromText,
  stripInlineMarkdown,
} from '@huabu/shared/conversation-title';
