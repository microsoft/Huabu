// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Global proxy setup — must be imported before any other modules that use fetch.
 *
 * When HTTPS_PROXY / HTTP_PROXY is set, installs a global undici
 * dispatcher so Node's built-in `fetch` routes through the proxy.
 * `NO_PROXY` (comma-separated) bypasses the proxy for specific hosts;
 * loopback addresses are always bypassed.
 *
 * Why a global dispatcher and not a `globalThis.fetch` wrapper:
 * replacing `globalThis.fetch` with `undici.fetch` from this package's
 * `undici` dep puts `fetch` into a different realm than
 * `globalThis.FormData` (which still comes from Node's bundled undici
 * copy). The OpenAI SDK does an `instanceof FormData` check on
 * multipart bodies and rejects mismatched realms with
 * `"The provided fetch function does not support file uploads with
 * the current global FormData class"` — which broke
 * `images.edit({ image: ... })` whenever a proxy was configured.
 * Installing a global dispatcher leaves Node's built-in fetch in
 * place, so fetch and FormData stay realm-aligned.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

import { getLogger } from './utils/logger.js';

const log = getLogger('proxy');

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;

if (proxyUrl) {
  // EnvHttpProxyAgent reads HTTPS_PROXY/HTTP_PROXY/NO_PROXY itself,
  // but it does NOT implicitly bypass loopback — make sure localhost
  // is in NO_PROXY so dev requests to local services stay direct.
  const existingNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const noProxySet = new Set(
    existingNoProxy
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    noProxySet.add(host);
  }
  const mergedNoProxy = [...noProxySet].join(',');
  process.env.NO_PROXY = mergedNoProxy;

  setGlobalDispatcher(new EnvHttpProxyAgent());

  if (existingNoProxy) {
    log.info({ noProxy: existingNoProxy }, 'proxy NO_PROXY active');
  }
}
