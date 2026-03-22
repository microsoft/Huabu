/**
 * Global proxy setup — must be imported before any other modules that use fetch.
 *
 * When HTTPS_PROXY is set, routes all outgoing requests through the proxy.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (proxyUrl) {
  const dispatcher = new ProxyAgent(proxyUrl);

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
  }) as typeof globalThis.fetch;

  console.log(`Proxy enabled: ${proxyUrl}`);
}
