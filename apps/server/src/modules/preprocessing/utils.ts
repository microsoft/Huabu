import { createHash } from 'node:crypto';

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

/**
 * Compute SHA-256 hash of content
 * @param content - Content to hash
 * @returns Hash string in format "sha256:<hex>"
 */
export function computeContentHash(content: string): string {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Compute SHA-256 hash of binary data
 * @param buffer - Binary data to hash
 * @returns Hash string in format "sha256:<hex>"
 */
export function computeBufferHash(buffer: Uint8Array): string {
  const hash = createHash('sha256').update(buffer).digest('hex');
  return `sha256:${hash}`;
}
