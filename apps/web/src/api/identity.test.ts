// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

it('waits for outstanding session writes before logout and refuses new adoptions', async () => {
  let release!: () => void;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      if (init?.method === 'POST')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return new Response(null, { status: 204 });
    }),
  );
  const { startSession, signOut } = await import('./identity');
  const adoption = startSession('old-token');
  const logout = signOut();
  await expect(startSession('late-token')).rejects.toThrow('Sign-out');
  await Promise.resolve();
  expect(calls).toEqual(['POST']);
  release();
  await Promise.all([adoption, logout]);
  expect(calls).toEqual(['POST', 'DELETE']);
});

it('uses the persisted non-secret provider after reload without another discovery request', async () => {
  const provider = {
    driver: 'entra',
    issuer: 'https://login.example',
    clientId: 'spa',
  };
  sessionStorage.setItem('huabu.oidc.provider', JSON.stringify(provider));
  const assign = vi
    .spyOn(window.location, 'assign')
    .mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (String(input).endsWith('openid-configuration'))
        return Response.json({
          end_session_endpoint: 'https://login.example/logout',
        });
      throw new Error('Unnecessary discovery request');
    }),
  );
  const { signOut } = await import('./identity');
  await signOut({ providerSignOut: true });
  expect(assign).toHaveBeenCalledWith(
    expect.stringContaining('https://login.example/logout?'),
  );
  expect(sessionStorage.getItem('huabu.oidc.provider')).toBeNull();
});

it('finishes local logout when provider discovery has a network failure', async () => {
  const assign = vi
    .spyOn(window.location, 'assign')
    .mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new TypeError('Failed to fetch');
    }),
  );
  const { signOut } = await import('./identity');
  await expect(signOut({ providerSignOut: true })).resolves.toBeUndefined();
  expect(assign).toHaveBeenCalledWith('/');
});
