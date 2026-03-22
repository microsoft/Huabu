/**
 * Global proxy setup — must be imported before any other modules that use fetch.
 *
 * When HTTPS_PROXY is set, routes all outgoing requests through the proxy.
 * Supports NO_PROXY to bypass the proxy for specific hosts (comma-separated).
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (proxyUrl) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Always bypass proxy for localhost addresses
  const defaultBypass = ['localhost', '127.0.0.1', '::1'];
  const bypassSet = new Set([...defaultBypass, ...noProxy]);

  function shouldBypass(input: string | URL | Request): boolean {
    try {
      const urlStr =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const { hostname } = new URL(urlStr);
      return bypassSet.has(hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  const dispatcher = new ProxyAgent(proxyUrl);

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const opts = {
      ...(init as Parameters<typeof undiciFetch>[1]),
      ...(shouldBypass(input) ? {} : { dispatcher }),
    };
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], opts);
  }) as typeof globalThis.fetch;

  if (noProxy.length > 0) {
    console.log(`NO_PROXY: ${noProxy.join(', ')}`);
  }
}
