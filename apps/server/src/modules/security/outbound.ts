// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, buildConnector, Dispatcher1Wrapper } from 'undici';

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
//
// Node's built-in `fetch` speaks the handler protocol of the undici it
// bundles, which this package's undici no longer accepts unwrapped: without
// the wrapper every request fails, whatever its address.
const publicOnlyAgent = new Dispatcher1Wrapper(
  new Agent({
    connect: (options, callback) => {
      const host = options.hostname.replace(/^\[|\]$/g, '');
      // A literal address is never looked up, so it is checked here.
      if (isIP(host) && !isPublicAddress(host))
        return callback(refused(host), null);
      return connect(options, callback);
    },
  }),
);

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

function usesProxy(): boolean {
  const env = process.env;
  return Boolean(
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy,
  );
}

function fetchFailed(cause: Error): TypeError {
  return new TypeError('fetch failed', { cause });
}

/**
 * Refuse a host this machine knows to be non-public. A name this machine
 * cannot resolve is left to the proxy: it names nothing on this network.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw fetchFailed(refused(host));
    return;
  }
  const addresses = await new Promise<LookupAddress[]>((resolve) =>
    dnsLookup(host, { all: true }, (error, found) =>
      resolve(error ? [] : found),
    ),
  );
  if (addresses.some(({ address }) => !isPublicAddress(address)))
    throw fetchFailed(refused(host));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/**
 * A proxy makes the connection, so no address can be checked where it is
 * made. Each hop is checked before it is sent instead, redirects included.
 * Unlike the direct guard this leaves the gap between the check and the
 * proxy's own lookup.
 */
async function fetchThroughProxy(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  if (request.redirect !== 'follow') {
    await assertPublicHost(new URL(request.url).hostname);
    return fetch(request);
  }
  let url = new URL(request.url);
  let method = request.method;
  const headers = new Headers(request.headers);
  let body = request.body ? await request.arrayBuffer() : undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const response = await fetch(url, {
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

/**
 * `fetch`, kept to public addresses for members, inside
 * {@link withPublicNetworkOnly}, and throughout a public-only deployment.
 * The built-in `fetch` takes the guarded dispatcher, so callers keep its
 * `Response` and `FormData`: SDKs that probe for multipart support (image
 * edits) reject npm undici's, which cannot serialize Node's `FormData`.
 *
 * Member work always connects directly, as it did before a deployment could
 * be public-only. The owner's fetches keep the configured proxy.
 */
export const outboundFetch: typeof fetch = (input, init) => {
  if (!isPublicNetworkOnly()) return fetch(input, init);
  if (!isMemberWork() && usesProxy()) return fetchThroughProxy(input, init);
  return fetch(input, {
    ...init,
    dispatcher: publicOnlyAgent,
  } as RequestInit);
};
