/**
 * Web content fetcher utility
 * Decoupled from ingestion logic for testability and reusability
 */

export interface FetchWebContentResult {
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}

const DEFAULT_WEB_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_WEB_FETCH_RETRIES = 1;
const DEFAULT_ABORT_GRACE_MS = 5_000;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
): Promise<FetchWebContentResult> {
  const maxAttempts = Math.max(1, DEFAULT_WEB_FETCH_RETRIES + 1);
  let lastErrorMessage: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tavilyResult = await fetchWebContentViaTavilyExtract(url, {
      timeoutMs: DEFAULT_WEB_FETCH_TIMEOUT_MS,
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
    process.env.SEDIMENT_TAVILY_EXTRACT_FORMAT === 'markdown'
      ? 'markdown'
      : 'text';

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
        include_images: false,
        include_favicon: false,
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
      results?: Array<{
        url?: string;
        title?: string;
        raw_content?: string;
        content?: string;
      }>;
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

    const content = (
      firstResult.raw_content ??
      firstResult.content ??
      ''
    ).trim();
    if (!content) {
      return {
        success: false,
        error: 'Tavily extract returned empty content.',
      };
    }

    return {
      success: true,
      title:
        typeof firstResult.title === 'string' ? firstResult.title : undefined,
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
