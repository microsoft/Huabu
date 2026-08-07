// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
  /**
   * Bare artifact key (e.g. `art_abc.mhtml`) of the one-shot snapshot
   * captured the first time the URL was fetched. Present once the
   * preprocess pipeline has written the artifact; `undefined` for
   * snapshot-less nodes (local HTML, `data:` URLs, legacy nodes that
   * have not been re-preprocessed yet). When present, the canvas-level
   * WebNode renders this via `/api/canvas/<id>/artifact/<key>` instead
   * of pointing the iframe at the live remote URL.
   */
  mhtmlArtifact?: string;
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
  /**
   * `true` when `src` points at a `.mhtml` archive (captured one-shot
   * snapshot or direct artifact key) rather than a genuinely interactive
   * artifact. A snapshot is a static archive of a page's already-rendered
   * DOM, so the client must embed it with scripts DISABLED: re-running the
   * original site's client bundle
   * (common on CSR SPAs) boots its router against the artifact URL, fails
   * to match a route, and wipes the baked-in DOM — leaving a blank frame
   * the moment the user scrolls or interacts. Scripts also can't reach
   * `localStorage` / `cookie` without `allow-same-origin` (which we never
   * grant same-origin artifacts) and throw at boot. Omitted / `false` for
   * user-uploaded HTML artifacts and `data:` URLs, which may legitimately
   * need JS to render.
   *
   * KNOWN LIMITATION: because snapshots are embedded with scripts disabled,
   * they are display-only. Static content renders (DOM + CSS + fonts +
   * images), native `<a href>` navigation, in-page anchors, text selection
   * and `target=_blank` popups still work, but every JS-driven interaction
   * is inert: collapsible sections, tab switches, dropdowns, modals, search
   * boxes, form submits, lazy-loaded / infinite-scroll content, theme
   * toggles, etc. Full interactivity requires the live remote page
   * (`kind: 'url'`), not the snapshot. Accepted trade-off: a snapshot is a
   * point-in-time archive, and re-enabling its scripts blanks the frame
   * (see above), so static rendering is the best achievable state here.
   */
  snapshot?: boolean;
}
