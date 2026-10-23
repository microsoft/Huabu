// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  fetchDesktopAgentCredential,
  readDesktopDeviceInfo,
} from '../src/desktop.js';

describe('desktop device information', () => {
  it('reads identity from the runtime without starting a worker or requesting credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-device-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(dir, 'device-info.js'),
        'export const version = "2.3.4"; export function resolveDeviceIdentity() { return "stable-device-id"; }',
      );
      expect(await readDesktopDeviceInfo(join(dir, 'index.js'))).toEqual({
        agentletId: 'stable-device-id',
        displayName: `${hostname()}: ${process.platform} ${process.arch}`,
        version: '2.3.4',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects a runtime without version metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'desktop-device-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(dir, 'device-info.js'),
        'export function resolveDeviceIdentity() { return "stable-device-id"; }',
      );
      await expect(
        readDesktopDeviceInfo(join(dir, 'index.js')),
      ).rejects.toThrow('invalid device version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('desktop device credential exchange', () => {
  it('uses the authenticated fetch implementation and never follows redirects', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ token: 'secret', maxAgents: 3 }));
    expect(
      await fetchDesktopAgentCredential('https://huabu.test', request),
    ).toEqual(['secret', 3]);
    expect(request).toHaveBeenCalledWith(
      new URL('https://huabu.test/api/acp/connection-credentials'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://huabu.test',
        },
        body: '{}',
        redirect: 'error',
      }),
    );
  });
  it.each([
    ['http://192.168.1.20:3001/', 'http://192.168.1.20:3001'],
    ['https://HUABU.test:443/', 'https://huabu.test'],
  ])(
    'pins credential requests to the normalized server origin: %s',
    async (origin, expected) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ token: 'secret', maxAgents: 3 }));
      await fetchDesktopAgentCredential(origin, request);
      expect(request).toHaveBeenCalledWith(
        new URL('/api/acp/connection-credentials', expected),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Origin: expected,
          },
          redirect: 'error',
        }),
      );
    },
  );
  it.each([401, 403, 302, 503])(
    'surfaces HTTP %i without returning credentials',
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));
      await expect(
        fetchDesktopAgentCredential('https://huabu.test', request),
      ).rejects.toThrow(`HTTP ${status}`);
    },
  );
  it.each([
    { token: '', maxAgents: 3 },
    { token: 'secret', maxAgents: 0 },
    { token: 'secret', maxAgents: 1.5 },
    { token: 'secret' },
  ])(
    'rejects malformed credential responses without exposing them',
    async (body) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(body));
      await expect(
        fetchDesktopAgentCredential('https://huabu.test', request),
      ).rejects.toThrow('invalid device connection credentials');
    },
  );
});
