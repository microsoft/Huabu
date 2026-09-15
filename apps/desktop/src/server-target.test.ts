// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import {
  isSameOrigin,
  hasBasicAuthChallenge,
  normalizeServerOrigin,
  parseServerOption,
  probeRemoteServer,
} from './server-target';

const readiness = {
  bind: { host: '0.0.0.0', scope: 'network' },
  access: { allowedHostsConfigured: true, basicAuthConfigured: true },
  owner: { policy: 'loopback-or-basic-auth', allowedForRequest: true },
  credentials: { writable: true, reason: 'available' },
  transport: { status: 'operator-unverified' },
  issues: [],
};

describe('parseServerOption', () => {
  it('supports both CLI forms and canonicalizes origins', () => {
    expect(
      parseServerOption([
        'electron',
        '.',
        '--server',
        'HTTP://Example.COM:80/',
      ]),
    ).toBe('http://example.com');
    expect(
      parseServerOption(['Huabu', '--server=https://Example.COM:443']),
    ).toBe('https://example.com');
    expect(parseServerOption(['Huabu', '--server', 'http://[::1]:3001/'])).toBe(
      'http://[::1]:3001',
    );
  });

  it('preserves omitted local-server behavior', () => {
    expect(parseServerOption(['electron', '.'])).toBeUndefined();
  });

  it('rejects missing, repeated, or unsafe values', () => {
    expect(() => parseServerOption(['Huabu', '--server'])).toThrow(/requires/);
    expect(() =>
      parseServerOption([
        'Huabu',
        '--server=http://one.example',
        '--server=http://two.example',
      ]),
    ).toThrow(/only once/);
    expect(() =>
      normalizeServerOrigin('https://user:pass@example.com'),
    ).toThrow(/credentials/);
    expect(() => normalizeServerOrigin('file:///tmp/huabu')).toThrow(
      /HTTP or HTTPS/,
    );
    expect(() => normalizeServerOrigin('https://example.com/huabu')).toThrow(
      /path prefix/,
    );
    expect(() =>
      normalizeServerOrigin('https://example.com/?mode=desktop'),
    ).toThrow(/query or fragment/);
  });
});

describe('isSameOrigin', () => {
  it('uses URL origins instead of vulnerable string prefixes', () => {
    expect(
      isSameOrigin('https://huabu.example/api', 'https://huabu.example'),
    ).toBe(true);
    expect(
      isSameOrigin(
        'https://huabu.example.attacker.test',
        'https://huabu.example',
      ),
    ).toBe(false);
    expect(isSameOrigin('not a URL', 'https://huabu.example')).toBe(false);
  });
});

describe('probeRemoteServer', () => {
  it('accepts a compatible readiness response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(readiness), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      probeRemoteServer('https://huabu.example', fetchImpl),
    ).resolves.toEqual({ authenticationRequired: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://huabu.example/api/deployment/readiness'),
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('treats a Basic Auth challenge as reachable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Huabu"' },
      }),
    );

    await expect(
      probeRemoteServer('https://huabu.example', fetchImpl),
    ).resolves.toEqual({
      authenticationRequired: true,
      realm: 'Huabu',
    });
  });

  it('rejects a non-Basic unauthorized response', async () => {
    await expect(
      probeRemoteServer(
        'https://huabu.example',
        vi.fn().mockResolvedValue(
          new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer realm="api"' },
          }),
        ),
      ),
    ).rejects.toThrow(/without a Basic Auth challenge/);
  });

  it('surfaces host-policy, wrong-server, and transport failures', async () => {
    await expect(
      probeRemoteServer(
        'https://huabu.example',
        vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
      ),
    ).rejects.toThrow(/HUABU_ALLOWED_HOSTS/);
    await expect(
      probeRemoteServer(
        'https://huabu.example',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ service: 'other' }), { status: 200 }),
          ),
      ),
    ).rejects.toThrow(/compatible Huabu/);
    await expect(
      probeRemoteServer(
        'https://huabu.example',
        vi.fn().mockRejectedValue(new Error('certificate expired')),
      ),
    ).rejects.toThrow(/certificate expired/);
  });

  describe('hasBasicAuthChallenge', () => {
    it('recognizes Basic among one or more authentication challenges', () => {
      expect(hasBasicAuthChallenge('Basic realm="Huabu"')).toBe(true);
      expect(
        hasBasicAuthChallenge('Bearer realm="api", Basic realm="Huabu"'),
      ).toBe(true);
      expect(hasBasicAuthChallenge('Bearer realm="api"')).toBe(false);
      expect(hasBasicAuthChallenge(null)).toBe(false);
    });
  });

  it('reports redirects without leaving the configured origin', async () => {
    await expect(
      probeRemoteServer(
        'http://huabu.example',
        vi.fn().mockResolvedValue(
          new Response(null, {
            status: 301,
            headers: { Location: 'https://huabu.example/' },
          }),
        ),
      ),
    ).rejects.toThrow(/redirects to https:\/\/huabu\.example/);
  });

  it('validates readiness again with Basic Auth credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(readiness), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      probeRemoteServer('https://huabu.example', fetchImpl, 10_000, {
        username: 'owner',
        password: 'secret',
      }),
    ).resolves.toEqual({ authenticationRequired: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://huabu.example/api/deployment/readiness'),
      expect.objectContaining({
        headers: {
          Authorization: `Basic ${Buffer.from('owner:secret').toString(
            'base64',
          )}`,
        },
      }),
    );
  });
});
