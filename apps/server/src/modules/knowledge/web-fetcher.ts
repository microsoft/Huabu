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

/**
 * Fetch and extract text content from a web URL
 *
 * Strategy:
 * - Use native fetch API
 * - Basic HTML text extraction (cheerio-like approach)
 * - Timeout and error handling
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @returns Extracted content or error
 */
export async function fetchWebContent(
  url: string,
  options: {
    timeout?: number;
    userAgent?: string;
  } = {},
): Promise<FetchWebContentResult> {
  const { timeout = 10000, userAgent = 'Sediment/1.0' } = options;

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('text/html')) {
      return {
        success: false,
        error: `Unsupported content type: ${contentType}`,
      };
    }

    const html = await response.text();
    const { title, content } = extractTextFromHtml(html);

    return {
      success: true,
      title,
      content,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, error: 'Request timeout' };
      }
      return { success: false, error: error.message };
    }
    return { success: false, error: 'Unknown error' };
  }
}

/**
 * Extract text content from HTML
 * Simplified extraction without heavy dependencies
 *
 * @param html - HTML string
 * @returns Extracted title and content
 */
function extractTextFromHtml(html: string): {
  title?: string;
  content: string;
} {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch?.[1]?.trim();

  // Remove script and style tags
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities (basic set)
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Normalize whitespace
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();

  return { title, content: text };
}
