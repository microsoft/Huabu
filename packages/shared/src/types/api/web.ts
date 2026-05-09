import { z } from 'zod';

/**
 * Allowed characters for canvas/node identifiers \u2014 alphanumeric, dash,
 * underscore. Mirrors the path-safety constraint enforced by the storage
 * layer; rejecting anything else here keeps directory traversal and
 * shell-meaningful chars out of read paths.
 */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Querystring for `GET /api/web/preview` and `GET /api/web/reader`. */
export const webLookupQuerySchema = z
  .object({
    canvasId: z.string().min(1).regex(ID_PATTERN),
    nodeId: z.string().min(1).regex(ID_PATTERN),
  })
  .strict();
export type WebLookupQuery = z.infer<typeof webLookupQuerySchema>;

export interface WebPreviewResponse {
  url: string;
  /** Display label for the node (mirrors `NodeContent.label` on the server). */
  label?: string;
  contentHtml?: string;
  summary?: string;
  image?: string;
  favicon?: string;
  siteName?: string;
}

export interface WebReaderResponse {
  url: string;
  /** Display label for the node (mirrors `NodeContent.label` on the server). */
  label: string;
  html: string;
  contentMarkdown?: string;
  siteName?: string;
}
