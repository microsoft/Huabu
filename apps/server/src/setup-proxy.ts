/**
 * Global proxy setup — must be imported before any other modules that use fetch.
 *
 * When HTTPS_PROXY is set, routes all outgoing requests through the proxy.
 * Supports NO_PROXY to bypass the proxy for specific hosts (comma-separated).
 */
import { ProxyAgent, type Dispatcher, fetch as undiciFetch } from 'undici';

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

let proxyDispatcher: Dispatcher | undefined;
let shouldBypassHost: (host: string) => boolean = () => false;

if (proxyUrl) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Always bypass proxy for localhost addresses
  const defaultBypass = ['localhost', '127.0.0.1', '::1'];
  const bypassSet = new Set([...defaultBypass, ...noProxy]);

  shouldBypassHost = (host: string) => bypassSet.has(host.toLowerCase());

  function shouldBypass(input: string | URL | Request): boolean {
    try {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const { hostname } = new URL(urlStr);
      return shouldBypassHost(hostname);
    } catch {
      return false;
    }
  }

  proxyDispatcher = new ProxyAgent(proxyUrl);

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const opts = {
      ...(init as Parameters<typeof undiciFetch>[1]),
      ...(shouldBypass(input) ? {} : { dispatcher: proxyDispatcher }),
    };
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], opts);
  }) as typeof globalThis.fetch;

  if (noProxy.length > 0) {
    console.log(`NO_PROXY: ${noProxy.join(', ')}`);
  }
}

/**
 * Returns the configured proxy dispatcher for a given target URL, or
 * `undefined` if no proxy is configured or the host is on the bypass list.
 *
 * Use this when calling `undici.fetch` directly (e.g. when you need to
 * send a multipart `FormData` body and must keep `fetch` + `FormData`
 * from the same realm — Node's built-in fetch uses Node's bundled
 * undici copy, whose `FormData` class is *not* identity-equal to the
 * one exported from this package's `undici` dependency).
 */
export function getProxyDispatcher(
  target?: string | URL,
): Dispatcher | undefined {
  if (!proxyDispatcher) return undefined;
  if (target) {
    try {
      const { hostname } = new URL(
        typeof target === 'string' ? target : target.href,
      );
      if (shouldBypassHost(hostname)) return undefined;
    } catch {
      // Fall through and return the dispatcher; the request will fail
      // its own URL parsing soon enough with a clearer error.
    }
  }
  return proxyDispatcher;
}
