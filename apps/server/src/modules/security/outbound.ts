// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

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

export function isPublicNetworkOnly(): boolean {
  return scope.getStore() === true;
}

/** `fetch`, restricted to public addresses inside {@link withPublicNetworkOnly}. */
export const outboundFetch: typeof fetch = (input, init) =>
  isPublicNetworkOnly()
    ? (undiciFetch(input as never, {
        ...(init as object),
        dispatcher: publicOnlyAgent,
      }) as unknown as Promise<Response>)
    : fetch(input, init);
