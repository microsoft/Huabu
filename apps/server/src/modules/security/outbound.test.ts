// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isPublicAddress,
  outboundFetch,
  withPublicNetworkOnly,
} from './outbound.js';
import { WebLoader } from '../preprocessing/loaders/web.loader.js';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let port: number;
beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/hop') {
      response.writeHead(302, { Location: `http://127.0.0.1:${port}/` });
      return response.end();
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<html><head><title>Internal</title></head><body><p>secret</p></body></html>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('public-network-only outbound fetch', () => {
  it.each([
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['::ffff:8.8.8.8', true],
    ['not-an-ip', false],
  ])('classifies %s as public: %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it('reaches a loopback server outside the scope, and refuses it inside', async () => {
    const url = `http://127.0.0.1:${port}/`;
    expect((await outboundFetch(url)).status).toBe(200);
    await expect(
      withPublicNetworkOnly(() => outboundFetch(url)),
    ).rejects.toThrow();
    // A host name that resolves to loopback is refused at connect time too.
    await expect(
      withPublicNetworkOnly(() =>
        outboundFetch(`http://localhost:${port}/hop`),
      ),
    ).rejects.toThrow();
  });

  it('keeps the web loader from reading the Server network inside the scope', async () => {
    const loader = new WebLoader();
    const url = `http://localhost:${port}/hop`;
    expect((await loader.load(url)).content).toContain('secret');
    const inside = await withPublicNetworkOnly(() =>
      loader.load(url).then(
        (result) => result.content,
        () => 'refused',
      ),
    );
    expect(inside).not.toContain('secret');
  });
});
