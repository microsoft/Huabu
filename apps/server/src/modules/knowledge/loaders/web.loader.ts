import type { IDocumentLoader, LoadResult } from './loader.interface.js';

// ===================================
// Types & Constants
// ===================================

export interface FetchWebContentResult {
  success: boolean;
  content?: string;
  title?: string;
  image?: string;
  favicon?: string;
  error?: string;
}

export type WebSnapshot = {
  content: string;
  title?: string;
  metadata: {
    siteName?: string;
    [key: string]: unknown;
  };
};

export type FetchWebContentOptions = {
  timeoutMs?: number;
  format?: 'text' | 'markdown';
};

const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_WEB_FETCH_RETRIES = 1;
const DEFAULT_ABORT_GRACE_MS = 5_000;

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
      throw new Error('Invalid source for Web loader. Expected URL string.');
    }

    // Check if content was provided in options (pre-fetched)
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
      };
    } catch (error) {
      throw new Error(
        `Web loading failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// ===================================
// Helper Functions (Previously web-fetcher.ts)
// ===================================

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

function mergeDerivedMetadata(params: {
  uri: string;
  content: string;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = params.metadata;

  const existingSiteName =
    typeof metadata.siteName === 'string' ? metadata.siteName.trim() : '';
  if (!existingSiteName) {
    const hostname = safeGetHostname(params.uri);
    if (hostname) metadata.siteName = hostname;
  }

  return metadata;
}

/**
 * Get a normalized web snapshot for ingestion.
 *
 * This consolidates:
 * - Fetching (when `content` is not provided)
 * - Merging Tavily fields into metadata
 * - Deriving siteName from URI
 */
export async function getWebSnapshot(params: {
  uri: string;
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  format?: 'text' | 'markdown';
}): Promise<WebSnapshot> {
  let content = params.content;
  let title = params.title;
  const metadata: Record<string, unknown> = { ...(params.metadata ?? {}) };

  if (!content) {
    // Backend fetch via Tavily. This is the ONLY place we fetch web sources.
    const fetchResult = await fetchWebContent(params.uri, {
      format: params.format,
    });

    if (!fetchResult.success) {
      throw new Error(
        `Failed to fetch web content (${params.uri}): ${fetchResult.error}`,
      );
    }

    content = fetchResult.content ?? '';
    title = title ?? fetchResult.title;
    const image =
      typeof fetchResult.image === 'string' ? fetchResult.image : '';
    const favicon =
      typeof fetchResult.favicon === 'string' ? fetchResult.favicon : '';

    const existingImage =
      typeof metadata.image === 'string' ? metadata.image.trim() : '';
    const existingFavicon =
      typeof metadata.favicon === 'string' ? metadata.favicon.trim() : '';

    if (!existingImage && image.trim()) metadata.image = image.trim();
    if (!existingFavicon && favicon.trim()) metadata.favicon = favicon.trim();
  }

  const contentText = content ?? '';
  mergeDerivedMetadata({
    uri: params.uri,
    content: contentText,
    metadata,
  });

  return {
    content: contentText,
    title,
    metadata,
  };
}

/**
 * Fetch and extract text content from a web URL
 *
 * Strategy:
 * - Use Tavily Extract API only
 * - Timeout and retry handling
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @returns Extracted content or error
 */
export async function fetchWebContent(
  url: string,
  options: FetchWebContentOptions = {},
): Promise<FetchWebContentResult> {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_WEB_FETCH_TIMEOUT_MS;

  const maxAttempts = Math.max(1, DEFAULT_WEB_FETCH_RETRIES + 1);
  let lastErrorMessage: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tavilyResult = await fetchWebContentViaTavilyExtract(url, {
      timeoutMs,
      format: options.format,
    });

    if (tavilyResult.success) {
      return tavilyResult;
    }

    lastErrorMessage = tavilyResult.error ?? 'Unknown error';

    const isRetryable =
      /request timeout/i.test(lastErrorMessage) ||
      /status\s+429/i.test(lastErrorMessage) ||
      /status\s+5\d\d/i.test(lastErrorMessage) ||
      /ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(lastErrorMessage);

    const shouldRetry = attempt < maxAttempts && isRetryable;
    if (!shouldRetry) {
      return {
        success: false,
        error: lastErrorMessage,
      };
    }

    const backoffMs = 250 * attempt * attempt;
    await sleep(backoffMs);
  }

  return {
    success: false,
    error: lastErrorMessage ?? 'Unknown error',
  };
}

async function fetchWebContentViaTavilyExtract(
  url: string,
  params: {
    timeoutMs: number;
    format?: 'text' | 'markdown';
  },
): Promise<FetchWebContentResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'Missing TAVILY_API_KEY in environment variables.',
    };
  }

  const extractDepth: 'basic' | 'advanced' =
    process.env.SEDIMENT_TAVILY_EXTRACT_DEPTH === 'advanced'
      ? 'advanced'
      : 'basic';

  const format: 'text' | 'markdown' =
    params.format ??
    (process.env.SEDIMENT_TAVILY_EXTRACT_FORMAT === 'markdown'
      ? 'markdown'
      : 'text');

  const timeoutSeconds = clampNumber(
    Math.round(params.timeoutMs / 1000),
    1,
    60,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    params.timeoutMs + DEFAULT_ABORT_GRACE_MS,
  );

  try {
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        urls: [url],
        extract_depth: extractDepth,
        format,
        timeout: timeoutSeconds,
        include_images: true,
        include_favicon: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: text
          ? `Tavily extract failed with status ${response.status}: ${text}`
          : `Tavily extract failed with status ${response.status}.`,
      };
    }

    const data = (await response.json()) as {
      results?: Array<Record<string, unknown>>;
      failed_results?: Array<{
        url?: string;
        error?: string;
      }>;
    };

    const firstResult = data.results?.[0];
    const failed = data.failed_results?.find((r) => r?.url === url);

    if (!firstResult) {
      const failedMessage = failed?.error ? `: ${failed.error}` : '';
      return {
        success: false,
        error: `Tavily extract returned no results${failedMessage}`,
      };
    }

    const title =
      typeof firstResult?.title === 'string' ? firstResult.title : undefined;

    const favicon =
      typeof firstResult?.favicon === 'string'
        ? firstResult.favicon
        : undefined;

    const imagesList = Array.isArray(firstResult?.images)
      ? (firstResult.images as unknown[])
      : undefined;

    const imageFromList = imagesList
      ?.find((v) => typeof v === 'string')
      ?.toString();

    const image = imageFromList;

    const rawContent =
      (typeof firstResult?.raw_content === 'string'
        ? firstResult.raw_content
        : undefined) ??
      (typeof firstResult?.content === 'string'
        ? firstResult.content
        : undefined) ??
      '';

    const content = rawContent.trim();
    if (!content) {
      return {
        success: false,
        error: 'Tavily extract returned empty content.',
      };
    }

    return {
      success: true,
      title,
      image,
      favicon,
      content,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const isAbort = error instanceof Error && error.name === 'AbortError';
    return {
      success: false,
      error: isAbort ? 'Request timeout' : errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
