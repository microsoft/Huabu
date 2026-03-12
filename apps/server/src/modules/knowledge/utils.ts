import { createHash, randomUUID } from 'node:crypto';

import type { SourceType } from './types.js';

/**
 * Normalize URL for consistent sourceId generation
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

/**
 * Generate deterministic sourceId from workspace and data
 * @param workspaceId - Workspace identifier
 * @param data - Type-specific data for hash generation
 * @returns sourceId in format "src_<hash>"
 */
function generateDeterministicSourceId(
  workspaceId: string,
  data: string,
): string {
  const combined = `${workspaceId}:${data}`;
  const hash = createHash('sha256')
    .update(combined, 'utf8')
    .digest('hex')
    .substring(0, 16); // Use first 16 hex chars for reasonable length
  return `src_${hash}`;
}

/**
 * Generate sourceId for a data source
 *
 * Generation rules:
 * - Note/Text: UUID (editable content, hash unstable)
 * - Web: hash(workspaceId + normalizedUri)
 * - PDF: hash(workspaceId + fileContentHash)
 *
 * @param options - Generation options
 * @returns Generated sourceId
 */
export function generateSourceId(options: {
  workspaceId: string;
  type: SourceType;
  uri?: string;
  fileHash?: string;
}): string {
  const { workspaceId, type, uri, fileHash } = options;

  switch (type) {
    case 'note':
    case 'text': {
      // Editable types: use UUID for simplicity and stability
      return `src_${randomUUID()}`;
    }

    case 'web': {
      // Web: deterministic based on normalized URI
      if (!uri) {
        throw new Error('URI required for web source');
      }
      const normalized = normalizeUrl(uri);
      return generateDeterministicSourceId(workspaceId, `web:${normalized}`);
    }

    case 'pdf': {
      // PDF: deterministic based on file content hash
      if (!fileHash) {
        throw new Error('File hash required for PDF source');
      }
      return generateDeterministicSourceId(workspaceId, `pdf:${fileHash}`);
    }

    default:
      throw new Error(`Unsupported source type: ${type}`);
  }
}
