// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createServer } from 'node:http';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  isPublicAddress,
  leavesThroughProxy,
  outboundFetch,
  readBodyWithin,
  ResponseTooLargeError,
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

/** A refusal by the guard, as opposed to any other failed fetch. */
const REFUSED = expect.objectContaining({
  cause: expect.objectContaining({ code: 'NON_PUBLIC_ADDRESS' }),
});

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
    if (request.url === '/endless') {
      // No declared length: only reading can discover the size.
      response.writeHead(200, { 'Content-Type': 'text/html' });
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      const send = () => {
        while (!response.destroyed && response.write(chunk));
        if (!response.destroyed) response.once('drain', send);
      };
      return send();
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
  ).rejects.toThrow(REFUSED);
});

it('keeps the built-in Response and FormData for member multipart uploads', async () => {
  // The OpenAI SDK's file-upload probe: an image edit is refused when the
  // fetch's Response serializes FormData as "[object FormData]".
  const response = await asMember(() => outboundFetch('data:,'));
  expect(response).toBeInstanceOf(Response);
  const ResponseOf = response.constructor as typeof Response;
  expect(await new ResponseOf(new FormData()).text()).not.toBe(
    '[object FormData]',
  );
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
    ).rejects.toThrow(REFUSED);
    // A host name that resolves to loopback is refused at connect time too.
    await expect(
      withPublicNetworkOnly(() =>
        outboundFetch(`http://localhost:${port}/hop`),
      ),
    ).rejects.toThrow(REFUSED);
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
    await expect(memberModelFetch(url)).rejects.toThrow(REFUSED);
  });
});

describe('public-only deployment', () => {
  const PROXY_NAMES = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
  ];
  /** Every scheme leaves through a proxy; nothing is exempt. */
  const useProxy = () => {
    process.env.HTTP_PROXY = 'http://proxy.invalid:8080';
    process.env.HTTPS_PROXY = 'http://proxy.invalid:8080';
  };
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(
      ['HUABU_PUBLIC_NETWORK_ONLY', ...PROXY_NAMES].map((name) => [
        name,
        process.env[name],
      ]),
    );
    for (const name of PROXY_NAMES) delete process.env[name];
    process.env.HUABU_PUBLIC_NETWORK_ONLY = '1';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });

  it('refuses the owner the Server network, by address, by name and by redirect', async () => {
    const before = requests;
    await expect(outboundFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      REFUSED,
    );
    await expect(outboundFetch(`http://localhost:${port}/`)).rejects.toThrow(
      REFUSED,
    );
    const loader = new WebLoader();
    await expect(loader.load(`http://localhost:${port}/hop`)).rejects.toThrow();
    expect(requests).toBe(before);
  });

  it('checks every hop itself when a proxy makes the connections', async () => {
    useProxy();
    const hops: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        hops.push(`${init.method} ${url}`);
        expect(init.redirect).toBe('manual');
        if (url.pathname === '/final') return new Response('public page');
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              url.pathname === '/inward'
                ? `http://127.0.0.1:${port}/`
                : 'http://93.184.215.14/final',
          },
        });
      }),
    );
    const before = requests;

    await expect(outboundFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(
      REFUSED,
    );
    await expect(outboundFetch(`http://localhost:${port}/`)).rejects.toThrow(
      REFUSED,
    );
    expect(hops).toEqual([]);

    const response = await outboundFetch('http://93.184.215.14/start');
    expect(await response.text()).toBe('public page');
    await expect(outboundFetch('http://93.184.215.14/inward')).rejects.toThrow(
      REFUSED,
    );
    expect(hops).toEqual([
      'GET http://93.184.215.14/start',
      'GET http://93.184.215.14/final',
      'GET http://93.184.215.14/inward',
    ]);
    expect(requests).toBe(before);
  });

  it('leaves an unresolved name to the proxy unless it is private by construction', async () => {
    useProxy();
    const proxied = vi.fn(async () => new Response('resolved by the proxy'));
    vi.stubGlobal('fetch', proxied);
    // Many networks resolve public names only at the proxy.
    const response = await outboundFetch('http://unresolvable.invalid/');
    expect(await response.text()).toBe('resolved by the proxy');
    expect(proxied).toHaveBeenCalledTimes(1);
    // A proxy may resolve names of its own network; these can only be that.
    for (const host of [
      'huabu-no-such-intranet-host',
      'wiki.huabu-no-such.corp',
      'build.huabu-no-such.internal',
      'nas.huabu-no-such.lan',
    ])
      await expect(outboundFetch(`http://${host}/`)).rejects.toThrow(REFUSED);
    expect(proxied).toHaveBeenCalledTimes(1);
  });

  it('checks a hop that bypasses the proxy where its connection is made', async () => {
    useProxy();
    process.env.NO_PROXY = `localhost,127.0.0.1,exempt.example`;
    const before = requests;
    // Real fetches: the guarded dispatcher refuses these at connect time.
    await expect(outboundFetch(`http://localhost:${port}/`)).rejects.toThrow(
      REFUSED,
    );
    await expect(outboundFetch(`http://127.0.0.1:${port}/hop`)).rejects.toThrow(
      REFUSED,
    );
    expect(requests).toBe(before);

    const sent: { url: string; guarded: boolean }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit & { dispatcher?: unknown }) => {
        sent.push({ url: String(url), guarded: init.dispatcher !== undefined });
        return url.pathname === '/start'
          ? new Response(null, {
              status: 302,
              headers: { Location: 'http://exempt.example/next' },
            })
          : new Response('ok');
      }),
    );
    await outboundFetch('http://93.184.215.14/start');
    // The proxied hop is checked beforehand; the exempt one by its dispatcher.
    expect(sent).toEqual([
      { url: 'http://93.184.215.14/start', guarded: false },
      { url: 'http://exempt.example/next', guarded: true },
    ]);
  });

  it('guards a scheme that has no proxy of its own', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.invalid:8080';
    const before = requests;
    await expect(outboundFetch(`http://localhost:${port}/`)).rejects.toThrow(
      REFUSED,
    );
    expect(requests).toBe(before);
  });

  it('drops credentials when a proxied redirect changes origin', async () => {
    useProxy();
    const seen: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        seen.push(new Headers(init.headers).get('authorization'));
        return url.hostname === '93.184.215.14'
          ? new Response(null, {
              status: 307,
              headers: { Location: 'http://8.8.8.8/' },
            })
          : new Response('ok');
      }),
    );
    await outboundFetch('http://93.184.215.14/', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(seen).toEqual(['Bearer secret', null]);
  });

  it('still connects member work directly behind a proxy', async () => {
    useProxy();
    const before = requests;
    await expect(
      withPublicNetworkOnly(() => outboundFetch(`http://127.0.0.1:${port}/`)),
    ).rejects.toThrow(REFUSED);
    expect(requests).toBe(before);
  });
});

describe('bounded response bodies', () => {
  it('returns a body within the limit', async () => {
    const body = await readBodyWithin(new Response('hello'), 5);
    expect(body.toString()).toBe('hello');
    expect((await readBodyWithin(new Response(null), 5)).length).toBe(0);
  });

  it('refuses a declared length over the limit without reading', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull: () => {
        throw new Error('The body must not be read');
      },
      cancel,
    });
    const response = new Response(stream, {
      headers: { 'Content-Length': '6' },
    });
    await expect(readBodyWithin(response, 5)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('abandons a body of undeclared length once it passes the limit', async () => {
    const response = await outboundFetch(`http://127.0.0.1:${port}/endless`);
    expect(response.headers.get('content-length')).toBeNull();
    await expect(readBodyWithin(response, 3 * 1024 * 1024)).rejects.toThrow(
      'exceeds 3145728 bytes',
    );
  });

  it('keeps the web loader from buffering an endless page', async () => {
    await expect(
      new WebLoader().load(`http://127.0.0.1:${port}/endless`),
    ).rejects.toThrow(/exceeds \d+ bytes/);
  });

  it('keeps a node-source download from buffering an endless file', async () => {
    const opened = await mountTestWorkspace(
      { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
      'huabu-endless-import-',
    );
    try {
      await opened.storage.structured
        .spaces()
        .create({ canvasId: 'own', title: 'Own Space' });
      const command: CanvasCommand = {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-image',
            nodeType: 'image',
            position: { x: 0, y: 0 },
            data: { src: `http://127.0.0.1:${port}/endless` },
          },
        ],
      };
      // Left as it was: the download was refused, not stored.
      expect(await importForeignNodeSources('own', [command])).toEqual([
        command,
      ]);
    } finally {
      await opened.close();
    }
  });
});

describe('leavesThroughProxy', () => {
  const through = (url: string, env: NodeJS.ProcessEnv) =>
    leavesThroughProxy(new URL(url), env);
  const BOTH = { HTTP_PROXY: 'http://p:1', HTTPS_PROXY: 'http://p:1' };

  it('follows the proxy configured for the scheme', () => {
    expect(through('http://example.com/', {})).toBe(false);
    expect(through('https://example.com/', BOTH)).toBe(true);
    expect(through('http://example.com/', BOTH)).toBe(true);
    // An HTTP proxy also carries HTTPS; an HTTPS proxy does not carry HTTP.
    expect(through('https://example.com/', { HTTP_PROXY: 'http://p:1' })).toBe(
      true,
    );
    expect(through('http://example.com/', { HTTPS_PROXY: 'http://p:1' })).toBe(
      false,
    );
    expect(through('https://example.com/', { https_proxy: 'http://p:1' })).toBe(
      true,
    );
  });

  it.each([
    ['*', 'https://example.com/', false],
    ['example.com', 'https://example.com/', false],
    ['example.com', 'https://api.example.com/', false],
    ['example.com', 'https://badexample.com/', true],
    ['.example.com', 'https://example.com/', false],
    ['*.example.com', 'https://api.example.com/', false],
    ['*.example.com', 'https://example.com/', true],
    ['EXAMPLE.com', 'https://Example.COM./', false],
    ['example.com:8443', 'https://example.com/', true],
    ['example.com:8443', 'https://example.com:8443/', false],
    ['example.com:443', 'https://example.com/', false],
    ['other.test, example.com', 'https://example.com/', false],
    ['127.0.0.1', 'http://127.0.0.1:3000/', false],
    ['::1', 'http://[::1]:3000/', false],
    ['[::1]:3000', 'http://[::1]:3000/', false],
    ['[::1]:3001', 'http://[::1]:3000/', true],
    ['', 'https://example.com/', true],
  ])('NO_PROXY=%j for %s: proxied=%s', (noProxy, url, expected) => {
    expect(through(url, { ...BOTH, NO_PROXY: noProxy })).toBe(expected);
    expect(through(url, { ...BOTH, no_proxy: noProxy })).toBe(expected);
  });
});

describe('the guarded dispatcher and the built-in fetch', () => {
  // Node's fetch and this package's undici are different copies with
  // different handler protocols: an upgrade of either can leave the guarded
  // dispatcher unable to return any response. The guard itself only admits
  // public addresses, which a test cannot serve, so this checks the wrapping
  // it depends on against a real response and a real redirect.
  it('reads a response and follows a redirect through a wrapped dispatcher', async () => {
    const { Agent, Dispatcher1Wrapper } = await import('undici');
    const dispatcher = new Dispatcher1Wrapper(new Agent());
    try {
      const before = requests;
      const response = await fetch(`http://127.0.0.1:${port}/hop`, {
        dispatcher,
      } as RequestInit);
      expect(response.status).toBe(200);
      expect(response.redirected).toBe(true);
      expect(await response.text()).toContain('secret');
      expect(requests).toBe(before + 2);
    } finally {
      await dispatcher.close();
    }
  });
});
