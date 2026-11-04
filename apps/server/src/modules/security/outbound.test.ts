// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  isPublicAddress,
  outboundFetch,
  withPublicNetworkOnly,
} from './outbound.js';
import { resolveImageUrl } from '../agent/conversation/prompt/image-inlining.js';
import { importForeignNodeSources } from '../canvas/import-node-src.js';
import {
  openPersonalSettings,
  useCaller,
} from '../identity/personal-settings.js';
import { WebLoader } from '../preprocessing/loaders/web.loader.js';
import { mountTestWorkspace } from '../storage/testing.js';

import type { CanvasCommand } from '@huabu/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let server: Server;
let port: number;
let requests = 0;
beforeAll(async () => {
  server = createServer((request, response) => {
    requests++;
    if (request.url === '/hop') {
      response.writeHead(302, { Location: `http://127.0.0.1:${port}/` });
      return response.end();
    }
    if (request.url === '/image.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      return response.end('private-image-bytes');
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

function asMember<T>(operation: () => Promise<T>): Promise<T> {
  return openPersonalSettings(() => {
    useCaller({
      principal: { principalId: 'member', kind: 'user' },
      member: true,
      owner: false,
      access: {
        can: async () => true,
        claim: async () => {},
        workspaces: async () => [],
      },
    });
    return operation();
  });
}

it('applies public-network checks to member calls without a preprocessing scope', async () => {
  await expect(
    asMember(() => outboundFetch(`http://localhost:${port}/hop`)),
  ).rejects.toThrow();
});

it('blocks member image inlining before connecting to the Server network', async () => {
  const url = `http://127.0.0.1:${port}/image.png`;
  expect(await resolveImageUrl(url, null)).toMatchObject({ kind: 'inline' });
  const before = requests;
  expect(await asMember(() => resolveImageUrl(url, null))).toEqual({
    kind: 'skipped',
    reason: 'fetch_failed',
  });
  expect(requests).toBe(before);
});

it('blocks member node-source downloads before connecting to the Server network', async () => {
  const opened = await mountTestWorkspace(
    { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
    'huabu-member-import-',
  );
  try {
    await opened.storage.structured
      .spaces()
      .create({ canvasId: 'own', title: 'Own Space' });
    const src = `http://localhost:${port}/image.png`;
    const command: CanvasCommand = {
      type: 'CREATE_NODES',
      nodes: [
        {
          id: 'node-image',
          nodeType: 'image',
          position: { x: 0, y: 0 },
          data: { src },
        },
      ],
    };
    const allowed = await importForeignNodeSources('own', [command]);
    expect(allowed).not.toEqual([command]);
    const before = requests;
    expect(
      await asMember(() => importForeignNodeSources('own', [command])),
    ).toEqual([command]);
    expect(requests).toBe(before);
  } finally {
    await opened.close();
  }
});

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

it('applies the same connection-time guard to member model discovery and inference transport', async () => {
  const { openPersonalSettings, useCaller } =
    await import('../identity/personal-settings.js');
  const { memberModelFetch } = await import('../agent/llm.js');
  const url = `http://localhost:${port}/hop`;
  expect((await memberModelFetch(url)).status).toBe(200);
  await openPersonalSettings(async () => {
    useCaller({
      principal: { principalId: 'carol', kind: 'user' },
      member: true,
      owner: false,
      access: {
        can: async () => true,
        claim: async () => {},
        workspaces: async () => [],
      },
    });
    await expect(memberModelFetch(url)).rejects.toThrow();
  });
});
