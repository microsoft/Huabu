// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, buildConnector } from 'undici';

import { personalSettingsOwner } from '../identity/personal-settings.js';

import type { LookupAddress, LookupOptions } from 'node:dns';

/**
 * Addresses a caller restricted to the public network may not reach:
 * loopback, private, link-local, carrier-grade NAT, unspecified, multicast
 * and reserved ranges, in both families.
 */
const NON_PUBLIC = new BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  NON_PUBLIC.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  NON_PUBLIC.addSubnet(prefix, bits, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // An IPv4-mapped address is judged as the IPv4 address it carries.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return !NON_PUBLIC.check(mapped, 'ipv4');
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function refused(host: string) {
  return Object.assign(
    new Error(`Refusing to connect to a non-public address for ${host}`),
    { code: 'NON_PUBLIC_ADDRESS' },
  );
}

/** Resolve as usual, then refuse if any address the host names is not public. */
function publicLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (addresses.some(({ address }) => !isPublicAddress(address)))
      return callback(refused(hostname), []);
    if (options.all) return callback(null, addresses);
    const [first] = addresses;
    return callback(null, first.address, first.family);
  });
}

const connect = buildConnector({ lookup: publicLookup } as never);
// Every connection, including each redirect hop, is checked where it is
// made, so a name that resolves differently on a second lookup gains nothing.
const publicOnlyAgent = new Agent({
  connect: (options, callback) => {
    const host = options.hostname.replace(/^\[|\]$/g, '');
    // A literal address is never looked up, so it is checked here.
    if (isIP(host) && !isPublicAddress(host))
      return callback(refused(host), null);
    return connect(options, callback);
  },
});

const scope = new AsyncLocalStorage<true>();

/**
 * Run `operation` with every {@link outboundFetch} it makes, at any depth,
 * restricted to public addresses. For work a per-Space member starts, whose
 * URLs must not reach the Server's own network.
 */
export function withPublicNetworkOnly<T>(operation: () => Promise<T>) {
  return scope.run(true, operation);
}

/** Member work also reaches this transport outside the preprocessing pipeline. */
function isMemberWork(): boolean {
  return scope.getStore() === true || personalSettingsOwner() !== null;
}

/**
 * Whether this deployment keeps every content fetch on the public network,
 * the owner's included. The desktop app sets it: there the Server shares a
 * machine and a network with the user's other services, and the URLs it
 * fetches come from web pages and Agent output as often as from the user.
 */
function isPublicOnlyDeployment(): boolean {
  return process.env.HUABU_PUBLIC_NETWORK_ONLY === '1';
}

export function isPublicNetworkOnly(): boolean {
  return isMemberWork() || isPublicOnlyDeployment();
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/**
 * Whether a request to `url` leaves through a proxy. The global dispatcher
 * that `setup-proxy.ts` installs decides this per request, and a configured
 * proxy does not carry every one: `NO_PROXY` exempts hosts, and a scheme may
 * have no proxy at all. This follows the `EnvHttpProxyAgent` of the undici
 * this package pins, rule for rule. Where the two ever disagree the cost is
 * bounded: a hop taken for proxied is still checked before it is sent, and
 * one taken for direct still connects through the guarded dispatcher.
 */
export function leavesThroughProxy(
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const http = env.http_proxy ?? env.HTTP_PROXY;
  const https = env.https_proxy ?? env.HTTPS_PROXY;
  if (!(url.protocol === 'https:' ? https || http : http)) return false;
  // `host` rather than `hostname`: an IPv6 literal keeps its brackets.
  const hostname = url.host.replace(/:\d*$/, '').toLowerCase();
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol];
  const exemptions = env.no_proxy ?? env.NO_PROXY ?? '';
  if (exemptions === '*') return false;
  for (const entry of exemptions.split(/[,\s]/)) {
    if (!entry) continue;
    const withPort = entry.match(/^(.+):(\d+)$/);
    const exempt = (withPort ? withPort[1] : entry)
      .replace(/^\*?\./, '')
      .toLowerCase();
    if (withPort && Number.parseInt(withPort[2], 10) !== port) continue;
    if (hostname === exempt || hostname.endsWith(`.${exempt}`)) return false;
  }
  return true;
}

function fetchFailed(cause: Error): TypeError {
  return new TypeError('fetch failed', { cause });
}

/**
 * Names that are private by construction: a single label, and the suffixes
 * reserved or conventionally used for a local network.
 */
const PRIVATE_NAME =
  /^[^.]+$|\.(?:local|localhost|localdomain|internal|intranet|lan|home|corp|private|home\.arpa)$/i;

/**
 * Refuse a host this machine knows to be non-public, before a proxy is asked
 * to reach it.
 *
 * A name this machine cannot resolve is not proof of anything: many networks
 * resolve public names only at the proxy, and a proxy may also resolve names
 * of its own network. Refusing every such name would stop all fetching on
 * the former; allowing every one would open the latter. So an unresolved
 * name is refused when it is private by construction, and otherwise left to
 * the proxy, whose own policy then governs.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw fetchFailed(refused(host));
    return;
  }
  const addresses = await new Promise<LookupAddress[] | null>((resolve) =>
    dnsLookup(host, { all: true }, (error, found) =>
      resolve(error ? null : found),
    ),
  );
  if (
    addresses
      ? addresses.some(({ address }) => !isPublicAddress(address))
      : PRIVATE_NAME.test(host)
  )
    throw fetchFailed(refused(host));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/**
 * The owner's fetch where a proxy is configured. Redirects are followed here,
 * one hop at a time, because each hop may leave differently:
 *
 * - directly, when `NO_PROXY` or the scheme exempts it: through the guarded
 *   dispatcher, which checks the address where the connection is made;
 * - through the proxy, which makes the connection itself: checked before it
 *   is sent, leaving the gap between that check and the proxy's own lookup.
 */
async function fetchWhereProxied(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const send = async (url: URL, options: RequestInit) => {
    if (!leavesThroughProxy(url))
      return fetch(url, {
        ...options,
        dispatcher: publicOnlyAgent,
      } as RequestInit);
    await assertPublicHost(url.hostname);
    return fetch(url, options);
  };
  let url = new URL(request.url);
  let method = request.method;
  const headers = new Headers(request.headers);
  let body = request.body ? await request.arrayBuffer() : undefined;
  if (request.redirect !== 'follow')
    return send(url, {
      method,
      headers,
      body,
      signal: request.signal,
      redirect: request.redirect,
    });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await send(url, {
      method,
      headers,
      body,
      signal: request.signal,
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (!REDIRECTS.has(response.status) || !location) return response;
    await response.body?.cancel();
    const next = new URL(location, url);
    if (next.protocol !== 'http:' && next.protocol !== 'https:')
      throw fetchFailed(new Error('Redirect to an unsupported scheme'));
    if (
      response.status === 303 ||
      (response.status !== 307 && response.status !== 308 && method === 'POST')
    ) {
      if (method !== 'HEAD') method = 'GET';
      body = undefined;
      for (const name of ['content-type', 'content-length', 'content-encoding'])
        headers.delete(name);
    }
    if (next.origin !== url.origin)
      for (const name of ['authorization', 'cookie', 'proxy-authorization'])
        headers.delete(name);
    url = next;
  }
  throw fetchFailed(new Error('Too many redirects'));
}

function proxyConfigured(): boolean {
  const env = process.env;
  return Boolean(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
  );
}

/**
 * `fetch`, kept to public addresses for members, inside
 * {@link withPublicNetworkOnly}, and throughout a public-only deployment.
 * The built-in `fetch` takes the guarded dispatcher, so callers keep its
 * `Response` and `FormData`: SDKs that probe for multipart support (image
 * edits) reject npm undici's, which cannot serialize Node's `FormData`.
 * That only works while the npm `undici` the Agent comes from shares a major
 * version with the one bundled in Node (`process.versions.undici`): undici 8's
 * Agent rejects the handlers Node 24's fetch hands it, failing every guarded
 * request. `outbound.test.ts` checks the pairing.
 *
 * Member work always connects directly, as it did before a deployment could
 * be public-only. The owner's fetches keep the configured proxy.
 */
export const outboundFetch: typeof fetch = (input, init) => {
  if (!isPublicNetworkOnly()) return fetch(input, init);
  if (!isMemberWork() && proxyConfigured())
    return fetchWhereProxied(input, init);
  return fetch(input, {
    ...init,
    dispatcher: publicOnlyAgent,
  } as RequestInit);
};

export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Response body exceeds ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * The whole body of `response`, refused once it passes `limit` bytes.
 *
 * `arrayBuffer()` and `text()` buffer whatever a server chooses to send, so a
 * fetched URL decides how much memory the Server spends. A declared length is
 * refused up front; a body without one is abandoned at the limit.
 */
export async function readBodyWithin(
  response: Response,
  limit: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(limit);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Release the stream so the underlying connection can close.
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
