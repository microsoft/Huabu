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
  /**
   * Whether the upstream page accepts being framed cross-origin (see
   * `WebPageResponse.embeddable` for the full contract). Surfaced on the
   * preview payload so the canvas-level WebNode can pick its render
   * strategy without making a second `/api/web/page` round-trip.
   */
  embeddable?: boolean;
}

export interface WebReaderResponse {
  url: string;
  /** Display label for the node (mirrors `NodeContent.label` on the server). */
  label: string;
  html: string;
  contentMarkdown?: string;
  siteName?: string;
}

/**
 * Response from `GET /api/web/page`.
 *
 * Tells the client where to point the live-site iframe in the Preview panel:
 *   - `kind: 'url'`   → remote site; the iframe loads `src` directly. Cross-
 *                       origin, so subject to `X-Frame-Options` /
 *                       `frame-ancestors`. Works reliably in Electron after
 *                       the main process strips those headers; in a plain
 *                       browser most sites will refuse.
 *   - `kind: 'html'`  → user-uploaded HTML artifact; the iframe loads a
 *                       same-origin URL under `/api/canvas/<id>/artifact/...`
 *                       which always succeeds.
 *
 * `embeddable` is a server-side verdict captured during the original fetch
 * (`X-Frame-Options` / CSP `frame-ancestors`). The plain-browser front-end
 * uses it to skip the live iframe entirely when the page is known to
 * refuse embedding. Desktop ignores this — the main process strips both
 * headers, so live always wins there. `undefined` when we never observed
 * the headers (local HTML, or the node was created before this signal
 * existed); the front-end should optimistically try live in that case.
 */
export interface WebPageResponse {
  src: string;
  kind: 'url' | 'html';
  embeddable?: boolean;
}
