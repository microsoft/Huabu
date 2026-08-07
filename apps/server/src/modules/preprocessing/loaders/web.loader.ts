// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Web Loader.
 *
 * Accepts either a remote URL or an absolute path to a local `.html` file
 * and returns the page's main content as markdown, plus a metadata bag
 * (title, og:image, favicon, siteName).
 *
 * Extraction strategy:
 *   1. Obtain raw HTML (`fetch` for URLs, `readFile` for local artifacts).
 *   2. Parse with `linkedom` and run `@mozilla/readability` to isolate the
 *      reader-friendly article body.
 *   3. Pull head metadata (title, og:*, link[rel=icon]) before serializing.
 *   4. Convert the article HTML to markdown with `turndown`.
 *
 * This loader has no external API dependencies — everything runs locally so
 * preprocessing works offline and without API keys.
 */

import { readFile } from 'node:fs/promises';

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

import type { IDocumentLoader, LoadResult } from './loader.interface.js';

// ===================================
// Types & Constants
// ===================================

export type WebSnapshot = {
  content: string;
  title?: string;
  metadata: {
    siteName?: string;
    image?: string;
    favicon?: string;
    /**
     * Whether the upstream response advertises that the page may be
     * embedded in a cross-origin `<iframe>`. `false` when we observed
     * `X-Frame-Options: DENY | SAMEORIGIN` or a CSP `frame-ancestors`
     * directive that excludes us. `true` when no such restriction was
     * present. `undefined` for local HTML artifacts or when we never
     * fetched (cache short-circuit).
     *
     * The web frontend uses this to decide whether to even attempt a
     * live iframe in the plain-browser build — see WebPreview.
     */
    embeddable?: boolean;
    [key: string]: unknown;
  };
  /**
   * Original page HTML as fetched. Only present when we actually
   * performed a network fetch for a remote URL — caller-supplied
   * `content`, cached short-circuits, and local-file / data: paths
   * leave this undefined. Consumed by the preprocess pipeline to
   * write the one-shot `.mhtml` snapshot artifact.
   */
  rawHtml?: string;
};

export type FetchWebContentOptions = {
  timeoutMs?: number;
};

const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_WEB_FETCH_RETRIES = 1;
const DEFAULT_ABORT_GRACE_MS = 5_000;

const REMOTE_URL_RE = /^https?:\/\//i;

// ===================================
// Loader Implementation
// ===================================

export class WebLoader implements IDocumentLoader {
  supports(sourceType: string): boolean {
    return sourceType === 'web';
  }

  async load(
    source: string | Buffer,
    options?: Record<string, unknown>,
  ): Promise<LoadResult> {
    if (typeof source !== 'string') {
      throw new Error(
        'Invalid source for Web loader. Expected URL string or local .html path.',
      );
    }

    // Allow callers to skip the fetch by passing pre-fetched content.
    // Used by the preprocess cache short-circuit so we never re-parse.
    if (options?.content && typeof options.content === 'string') {
      return {
        content: options.content,
        title: options.title as string | undefined,
        metadata: options.metadata as Record<string, unknown> | undefined,
      };
    }

    try {
      const snapshot = await getWebSnapshot({
        uri: source,
        title: options?.title as string | undefined,
        metadata: options?.metadata as Record<string, unknown> | undefined,
      });

      return {
        content: snapshot.content,
        title: snapshot.title,
        metadata: snapshot.metadata,
        rawHtml: snapshot.rawHtml,
      };
    } catch (error) {
      throw new Error(
        `Web loading failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// ===================================
// Helpers
// ===================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeGetHostname(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    return hostname ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function absoluteUrl(maybeRelative: string, baseUrl: string): string {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative;
  }
}

function pickMetaContent(
  doc: Document,
  selectors: string[],
): string | undefined {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    const value = el?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return undefined;
}

function pickFavicon(doc: Document, baseUrl?: string): string | undefined {
  const link =
    doc.querySelector('link[rel="icon"]') ??
    doc.querySelector('link[rel="shortcut icon"]') ??
    doc.querySelector('link[rel="apple-touch-icon"]');
  const href = link?.getAttribute('href')?.trim();
  if (!href) return undefined;
  return baseUrl ? absoluteUrl(href, baseUrl) : href;
}

let turndownInstance: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  // Drop noisy nodes that Readability sometimes leaves behind.
  td.remove(['script', 'style', 'noscript', 'iframe']);
  turndownInstance = td;
  return td;
}

/**
 * Run Readability + turndown over raw HTML and return a normalized snapshot.
 *
 * `baseUrl` is used to resolve relative `<img>` / favicon URLs into absolute
 * ones so the markdown / metadata is portable.
 */
function htmlToSnapshot(rawHtml: string, baseUrl?: string): WebSnapshot {
  // linkedom's `parseHTML` gives us a DOM that Readability understands.
  // We pass the URL hint so Readability can resolve in-article links.
  const { document } = parseHTML(rawHtml);

  // Pull head metadata BEFORE Readability runs — Readability strips most of
  // the original `<head>`.
  const metaTitle =
    pickMetaContent(document, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ?? document.querySelector('title')?.textContent?.trim();
  const metaImage = pickMetaContent(document, [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ]);
  const metaSiteName = pickMetaContent(document, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
  ]);
  const favicon = pickFavicon(document, baseUrl);

  // Readability mutates the document; clone it via re-parse to keep the
  // original around for fallback querying below.
  const readabilityDoc = parseHTML(rawHtml).document;
  const reader = new Readability(readabilityDoc as unknown as Document, {
    charThreshold: 200,
  });
  const article = reader.parse();

  const articleHtml = article?.content?.trim() ?? '';
  const articleTitle = article?.title?.trim() || metaTitle || undefined;

  let markdown = '';
  if (articleHtml) {
    markdown = getTurndown().turndown(articleHtml).trim();
  } else {
    // Readability failed (very short pages, login walls, etc.) — fall back
    // to body innerText so we still persist *something* useful.
    const body = document.querySelector('body');
    const text = body?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    markdown = text;
  }

  // Resolve relative image URLs inside the markdown to absolute so the
  // node renders correctly outside the original site.
  if (baseUrl) {
    markdown = markdown.replace(
      /(!\[[^\]]*\]\()([^)\s]+)/g,
      (_match, prefix: string, url: string) =>
        `${prefix}${absoluteUrl(url, baseUrl)}`,
    );
  }

  const metadata: WebSnapshot['metadata'] = {};
  if (metaImage) {
    metadata.image = baseUrl ? absoluteUrl(metaImage, baseUrl) : metaImage;
  }
  if (favicon) metadata.favicon = favicon;
  if (metaSiteName) metadata.siteName = metaSiteName;

  return {
    content: markdown,
    title: articleTitle,
    metadata,
  };
}

/**
 * Get a normalized web snapshot for ingestion.
 *
 * Accepts either:
 *   - a URL (http/https) — fetched with the runtime `fetch`
 *   - an absolute filesystem path to a `.html` file — read from disk
 *
 * Pre-fetched content can be supplied via `params.content` to skip I/O.
 */
export async function getWebSnapshot(params: {
  uri: string;
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<WebSnapshot> {
  const incoming: Record<string, unknown> = { ...(params.metadata ?? {}) };

  let rawHtml = params.content;
  let baseUrl: string | undefined;
  let embeddable: boolean | undefined;
  // Track whether rawHtml came from a fresh network fetch (vs. a
  // pre-fetched caller payload or a local file). Only the fresh case
  // is worth wrapping into a `.mhtml` snapshot artifact downstream.
  let fetchedRawHtml: string | undefined;

  if (REMOTE_URL_RE.test(params.uri)) {
    baseUrl = params.uri;
    if (!rawHtml) {
      const fetched = await fetchHtmlSmart(params.uri);
      rawHtml = fetched.html;
      fetchedRawHtml = fetched.html;
      // `headers` is `undefined` when the Electron fallback served the
      // response (BrowserWindow doesn't surface raw response headers).
      // Treat unknown as "embeddable status unknown" so the front-end
      // falls back to the live-iframe optimism path.
      embeddable = fetched.headers ? isEmbeddable(fetched.headers) : undefined;
    }
  } else if (/^data:/i.test(params.uri)) {
    // `data:` URLs are self-contained — the HTML lives inside the URL
    // itself. Decode the body directly instead of routing through
    // `fetch()` (its data-URL handling drops our custom headers and
    // returns the body anyway, so we'd just pay the round-trip cost for
    // no benefit). Same-origin embed model = always embeddable.
    if (!rawHtml) {
      rawHtml = decodeDataUrlBody(params.uri);
    }
    embeddable = true;
  } else {
    // Treat as local file path (artifact upload). Same-origin = always
    // embeddable by definition.
    if (!rawHtml) {
      rawHtml = await readFile(params.uri, 'utf8');
    }
    embeddable = true;
  }

  if (!rawHtml || !rawHtml.trim()) {
    throw new Error(`Empty HTML content for ${params.uri}`);
  }

  const snapshot = htmlToSnapshot(rawHtml, baseUrl);

  // Merge any caller-supplied metadata into the extracted snapshot, letting
  // extracted values fill in fields the caller did not provide.
  for (const [key, value] of Object.entries(snapshot.metadata)) {
    if (value && !incoming[key]) incoming[key] = value;
  }

  // Always derive siteName from hostname when not provided.
  if (!incoming.siteName) {
    const hostname = safeGetHostname(params.uri);
    if (hostname) incoming.siteName = hostname;
  }

  // Record the embeddability verdict on first observation. We never
  // overwrite an existing explicit value so a re-run can't accidentally
  // weaken the signal — the worst case is the cache short-circuit keeps
  // the old verdict, which is still better than no verdict at all.
  if (embeddable !== undefined && incoming.embeddable === undefined) {
    incoming.embeddable = embeddable;
  }

  return {
    content: snapshot.content,
    title: params.title ?? snapshot.title,
    metadata: incoming as WebSnapshot['metadata'],
    rawHtml: fetchedRawHtml,
  };
}

/**
 * Decode the body of a `data:` URL into a plain UTF-8 string.
 *
 * Supports both the percent-encoded text form (`data:text/html,...`) and
 * the base64 form (`data:text/html;base64,...`), plus the bare comma form
 * (`data:,...`). Throws on malformed input so the calling pipeline
 * surfaces an `EXTRACT_FAILED` diagnostic instead of silently producing
 * an empty node.
 */
function decodeDataUrlBody(input: string): string {
  const match = /^data:([^,]*),(.*)$/s.exec(input);
  if (!match) {
    throw new Error('Malformed data: URL — missing comma separator');
  }
  const [, mediaInfo, body] = match;
  const isBase64 = /;\s*base64\s*$/i.test(mediaInfo);
  if (isBase64) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return decodeURIComponent(body);
}

/**
 * Inspect the response headers from a successful HTML fetch and decide
 * whether the page advertises itself as embeddable in a cross-origin
 * `<iframe>`.
 *
 * Returns `false` when ANY of these is true:
 *   - `X-Frame-Options: DENY` or `SAMEORIGIN` (case-insensitive)
 *   - `Content-Security-Policy` contains `frame-ancestors` with a value
 *     that excludes a generic cross-origin embedder. We treat anything
 *     other than `*` or explicit `https://*` as "blocking" — the plain
 *     browser would have to match an exact origin we don't know how to
 *     enumerate, so it's safer to mark the page non-embeddable and let
 *     the front-end show the reader view immediately.
 *
 * Returns `true` otherwise.
 *
 * Note: this signal is only meaningful for the plain-browser build. The
 * Electron main process strips both headers before they reach Chromium,
 * so the desktop client always renders the live iframe regardless of
 * this verdict — see WebPreview for the front-end branching.
 */
function isEmbeddable(headers: Headers): boolean {
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return false;
  const csp = headers.get('content-security-policy');
  if (csp) {
    // Find the frame-ancestors directive; CSP directives are
    // semicolon-separated, each directive starts with its name.
    for (const directive of csp.split(';')) {
      const trimmed = directive.trim();
      if (!/^frame-ancestors\b/i.test(trimmed)) continue;
      const value = trimmed.replace(/^frame-ancestors\s*/i, '').trim();
      // `*` or unspecified = anyone can embed.
      if (value === '*' || value.length === 0) return true;
      // `'none'` or any explicit list = blocks generic embedders.
      return false;
    }
  }

  return true;
}

/**
 * Fetch raw HTML for a URL with a bounded timeout and one retry on
 * transient failures (timeouts, 429, 5xx, common transient network
 * errors). The user-agent and accept headers are set to look like a
 * standard desktop browser so sites don't reject us as a bot.
 *
 * Returns the body text alongside the response headers so callers can
 * derive secondary signals (e.g. {@link isEmbeddable}).
 */
async function fetchHtmlWithRetry(
  url: string,
  options: FetchWebContentOptions = {},
): Promise<{ html: string; headers: Headers }> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_WEB_FETCH_TIMEOUT_MS;

  const maxAttempts = Math.max(1, DEFAULT_WEB_FETCH_RETRIES + 1);
  let lastErrorMessage = 'Unknown error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeoutMs + DEFAULT_ABORT_GRACE_MS,
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/125.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      if (!response.ok) {
        lastErrorMessage = `HTTP ${response.status} ${response.statusText}`;
        const isRetryable =
          response.status === 429 ||
          (response.status >= 500 && response.status < 600);
        if (attempt < maxAttempts && isRetryable) {
          await sleep(250 * attempt * attempt);
          continue;
        }
        throw new WebFetchHttpError(
          lastErrorMessage,
          response.status,
          response.headers,
        );
      }

      const html = await response.text();
      return { html, headers: response.headers };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrorMessage = message;
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const isTransient =
        isAbort ||
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message) ||
        /HTTP 429|HTTP 5\d\d/.test(message);
      if (attempt < maxAttempts && isTransient) {
        await sleep(250 * attempt * attempt);
        continue;
      }
      // Preserve HTTP errors verbatim so callers (e.g. the Electron
      // fetch fallback) can inspect the status + headers and decide
      // whether the response looks like a bot challenge.
      if (error instanceof WebFetchHttpError) {
        throw error;
      }
      throw new Error(
        isAbort ? `Request timeout for ${url}` : `Fetch failed: ${message}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(lastErrorMessage);
}

/**
 * Carries the original HTTP status + headers so callers can inspect
 * the response. Thrown by {@link fetchHtmlWithRetry} for non-2xx
 * responses; the Electron fallback wrapper uses the status / headers
 * to decide whether the failure looks like a bot challenge.
 */
class WebFetchHttpError extends Error {
  status: number;
  headers: Headers;
  constructor(message: string, status: number, headers: Headers) {
    super(message);
    this.name = 'WebFetchHttpError';
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Detect a Cloudflare-style bot challenge response.
 *
 * `cf-mitigated: challenge` is the unambiguous signal Cloudflare emits
 * on its bot-management interstitials. We also accept a few well-known
 * body markers in case the header is stripped by an intermediate
 * proxy.
 */
function looksLikeBotChallenge(html: string, headers?: Headers): boolean {
  if (headers) {
    const mitigated = headers.get('cf-mitigated')?.toLowerCase();
    if (mitigated === 'challenge') return true;
  }
  if (!html) return false;
  const head = html.slice(0, 4000).toLowerCase();
  if (head.includes('<title>just a moment')) return true;
  if (head.includes('cf-browser-verification')) return true;
  if (head.includes('challenge-platform')) return true;
  return false;
}

/**
 * POST the URL to the Electron main process's loopback fetch service.
 *
 * Returns `null` when the service isn't available (plain web build,
 * `pnpm dev` without the desktop shell, …) or when the fallback itself
 * failed, so callers can fall through to surfacing the original error.
 */
async function fetchViaElectron(url: string): Promise<string | null> {
  const endpoint = process.env.HUABU_ELECTRON_FETCH_URL;
  const token = process.env.HUABU_ELECTRON_FETCH_TOKEN;
  if (!endpoint || !token) return null;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Huabu-Fetch-Token': token,
      },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as
      | { ok: true; html: string }
      | { ok: false; error: string };
    if (!payload.ok) return null;
    return typeof payload.html === 'string' && payload.html.trim().length > 0
      ? payload.html
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch raw HTML for a URL with an Electron-side fallback path.
 *
 * Tries the native `fetch`-based path first (cheap, no extra process)
 * and escalates to the offscreen Chromium fetcher when either:
 *   - the response looks like a Cloudflare bot challenge (header
 *     `cf-mitigated: challenge`, status 403/429/503 with cloudflare
 *     server, or known challenge HTML markers), or
 *   - the native fetch failed outright.
 *
 * Falls through to the original error when the fallback is unavailable
 * (non-Electron builds) or also failed.
 */
async function fetchHtmlSmart(
  url: string,
  options: FetchWebContentOptions = {},
): Promise<{ html: string; headers?: Headers }> {
  try {
    const result = await fetchHtmlWithRetry(url, options);
    if (looksLikeBotChallenge(result.html, result.headers)) {
      const escalated = await fetchViaElectron(url);
      if (escalated) return { html: escalated };
    }
    return result;
  } catch (error) {
    const isHttpError = error instanceof WebFetchHttpError;
    const shouldEscalate = isHttpError
      ? error.status === 403 ||
        error.status === 429 ||
        error.status === 503 ||
        looksLikeBotChallenge('', error.headers)
      : // Network errors / timeouts — many sites that gate on UA give
        // back a `Request timeout` here. Try the fallback once before
        // surfacing the failure.
        true;
    if (shouldEscalate) {
      const escalated = await fetchViaElectron(url);
      if (escalated) return { html: escalated };
    }
    throw error;
  }
}
