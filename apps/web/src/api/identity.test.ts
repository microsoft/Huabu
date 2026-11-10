// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it('recognizes an absent Bubble discovery route', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  const { listInteractiveAuthenticators } = await import('./identity');
  await expect(listInteractiveAuthenticators()).resolves.toBeNull();
});

it.each([204, 401])(
  'notifies peers before session adoption and after HTTP %i, without sharing credentials',
  async (status) => {
    const peer = new BroadcastChannel('huabu.session');
    const heard: unknown[] = [];
    peer.onmessage = (event) => heard.push(event.data);
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
    );
    try {
      const { startSession } = await import('./identity');
      const outcome = startSession('private-test-token').then(
        () => 'accepted',
        () => 'refused',
      );
      await vi.waitFor(() => expect(heard).toEqual(['changing']));
      finish(new Response(null, { status }));
      expect(await outcome).toBe(status === 204 ? 'accepted' : 'refused');
      await vi.waitFor(() => expect(heard).toEqual(['changing', 'changed']));
    } finally {
      peer.close();
    }
  },
);

it('notifies peers before cookie deletion and after a failed deletion so they can verify the surviving session', async () => {
  const peer = new BroadcastChannel('huabu.session');
  const heard: unknown[] = [];
  peer.onmessage = (event) => heard.push(event.data);
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
  );
  try {
    const { endSession } = await import('./identity');
    const outcome = endSession().catch(() => 'refused');
    await vi.waitFor(() => expect(heard).toEqual(['changing']));
    finish(new Response('{}', { status: 503 }));
    expect(await outcome).toBe('refused');
    await vi.waitFor(() => expect(heard).toEqual(['changing', 'changed']));
  } finally {
    peer.close();
  }
});

it('verifies identity only after a pending shared-cookie write finishes', async () => {
  let finish!: () => void;
  let signedIn = false;
  const calls: string[] = [];
  const tails = new Map<string, Promise<unknown>>();
  vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
    request: (name: string, callback: () => Promise<unknown>) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  } as unknown as LockManager);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      if (init?.method === 'POST') {
        await new Promise<void>((resolve) => (finish = resolve));
        signedIn = true;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        principal: { principalId: signedIn ? 'b' : 'a' },
      });
    }),
  );
  const { startSession, getIdentity } = await import('./identity');
  const adoption = startSession('b-token');
  await vi.waitFor(() => expect(finish).toBeDefined());
  const identity = getIdentity();
  await Promise.resolve();
  expect(calls).toEqual(['POST']);
  finish();
  await adoption;
  expect(await identity).toMatchObject({ principal: { principalId: 'b' } });
  expect(calls).toEqual(['POST', 'GET']);
});

it.each([401, 429, 500, 503])(
  'does not treat discovery HTTP %i as an absent Bubble deployment',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status })),
    );
    const { listInteractiveAuthenticators } = await import('./identity');
    await expect(listInteractiveAuthenticators()).rejects.toThrow(
      String(status),
    );
  },
);

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

it('lets another tab finish its renewal before signing out, and keeps later renewals out', async () => {
  let release: (() => void) | undefined;
  let held = true;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'POST' && held) {
        held = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  // The test DOM has no Web Locks; grant each name's requests in order, as
  // browsers do across tabs.
  const tails = new Map<string, Promise<unknown>>();
  vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
    request: (name: string, callback: () => Promise<unknown>) => {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  } as unknown as LockManager);
  // Two module instances are two tabs sharing one cookie, lock and storage.
  const renewingTab = await import('./identity');
  vi.resetModules();
  const signingOutTab = await import('./identity');

  const renewal = renewingTab.startSession('renewed', { renewal: true });
  await vi.waitFor(() => expect(release).toBeDefined());
  const logout = signingOutTab.signOut();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The deletion waits for the other tab's write instead of racing it.
  expect(calls).toEqual(['POST']);
  release?.();
  await Promise.all([renewal, logout]);
  expect(calls).toEqual(['POST', 'DELETE']);

  // A renewal redeemed while the other tab signed out does not sign back in.
  await expect(
    renewingTab.startSession('late', { renewal: true }),
  ).rejects.toThrow('another tab');
  expect(calls).toEqual(['POST', 'DELETE']);

  // A sign-in the person completes starts again, and renewals resume.
  await renewingTab.startSession('signed-in');
  await renewingTab.startSession('renewed-again', { renewal: true });
  expect(calls).toEqual(['POST', 'DELETE', 'POST', 'POST']);
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

it('retains the selected provider after failed logout so retry ends its session', async () => {
  const provider = {
    driver: 'entra',
    issuer: 'https://login.example',
    clientId: 'spa',
  };
  sessionStorage.setItem('huabu.oidc.provider', JSON.stringify(provider));
  const assign = vi
    .spyOn(window.location, 'assign')
    .mockImplementation(() => {});
  let deletes = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE')
        return new Response(null, { status: ++deletes === 1 ? 503 : 204 });
      if (String(input).endsWith('openid-configuration'))
        return Response.json({
          end_session_endpoint: 'https://login.example/logout',
        });
      if (String(input).includes('/bubble/'))
        return Response.json({
          authenticators: [
            provider,
            { ...provider, driver: 'auth0', issuer: 'https://other.example' },
          ].map((p) => ({
            ...p,
            interactive: true,
            authorizationUrl: `${p.issuer}/authorize`,
          })),
        });
      throw new Error('Unexpected request');
    }),
  );
  const { signOut } = await import('./identity');
  await expect(signOut({ providerSignOut: true })).rejects.toThrow();
  expect(sessionStorage.getItem('huabu.oidc.provider')).toBe(
    JSON.stringify(provider),
  );
  expect(assign).not.toHaveBeenCalled();
  await signOut({ providerSignOut: true });
  expect(assign).toHaveBeenCalledWith(
    expect.stringContaining('https://login.example/logout?'),
  );
  expect(sessionStorage.getItem('huabu.oidc.provider')).toBeNull();
});

it('retains both tabs rotating refresh tokens after failed logout and forgets them only after confirmed deletion', async () => {
  const authenticator = {
    driver: 'auth0',
    issuer: 'https://auth.example',
    authorizationUrl: 'https://auth.example/authorize',
    clientId: 'spa',
    scopes: ['openid'],
  };
  sessionStorage.setItem(
    'huabu.oidc.refresh',
    JSON.stringify({
      authenticator,
      refreshToken: 'refresh-1',
      revision: 'initial-revision',
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  localStorage.setItem('huabu.oidc.refresh.revision', 'initial-revision');
  const presented: string[] = [];
  let deletes = 0;
  vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE')
        return new Response(null, { status: ++deletes === 1 ? 503 : 204 });
      if (String(input).endsWith('openid-configuration'))
        return Response.json({ token_endpoint: 'https://auth.example/token' });
      const grant = new URLSearchParams(String(init?.body));
      presented.push(grant.get('refresh_token') ?? '');
      return Response.json({
        access_token: `access-${presented.length}`,
        refresh_token: `refresh-${presented.length + 1}`,
        expires_in: 3600,
      });
    }),
  );
  const firstTab = await import('../utils/oidcLogin');
  const { signOut } = await import('./identity');
  vi.resetModules();
  const secondTab = await import('../utils/oidcLogin');

  await expect(signOut()).rejects.toThrow();
  expect(localStorage.getItem('huabu.oidc.refresh.revision')).toBe(
    'initial-revision',
  );
  expect(localStorage.getItem('huabu.session.signedOut')).toBeNull();
  expect(firstTab.heldSessionExpiresIn()).toBeGreaterThan(3500);
  expect(secondTab.heldSessionExpiresIn()).toBeGreaterThan(3500);
  await expect(firstTab.refreshTokens()).resolves.toMatchObject({
    renewal: true,
  });
  await expect(secondTab.refreshTokens()).resolves.toMatchObject({
    renewal: true,
  });
  expect(presented).toEqual(['refresh-1', 'refresh-2']);

  await signOut();
  await vi.waitFor(() => expect(secondTab.heldSessionExpiresIn()).toBeNull());
  expect(localStorage.getItem('huabu.oidc.refresh.revision')).toBeNull();
  expect(localStorage.getItem('huabu.session.signedOut')).not.toBeNull();
  await expect(firstTab.refreshTokens()).resolves.toBeNull();
  await expect(secondTab.refreshTokens()).resolves.toBeNull();
  expect(presented).toEqual(['refresh-1', 'refresh-2']);
});

it('can delete the session while provider redemption is pending and does not restore its late token', async () => {
  const authenticator = {
    driver: 'auth0',
    issuer: 'https://auth.example',
    authorizationUrl: 'https://auth.example/authorize',
    clientId: 'spa',
    scopes: ['openid'],
  };
  sessionStorage.setItem(
    'huabu.oidc.refresh',
    JSON.stringify({
      authenticator,
      refreshToken: 'refresh-1',
      revision: 'initial-revision',
    }),
  );
  localStorage.setItem('huabu.oidc.refresh.revision', 'initial-revision');
  const lockNames: string[] = [];
  const tails = new Map<string, Promise<unknown>>();
  vi.spyOn(navigator, 'locks', 'get').mockReturnValue({
    request: (name: string, callback: () => Promise<unknown>) => {
      lockNames.push(name);
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  } as unknown as LockManager);
  let finish!: (response: Response) => void;
  const assign = vi
    .spyOn(window.location, 'assign')
    .mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (String(input).endsWith('openid-configuration'))
        return Response.json({ token_endpoint: 'https://auth.example/token' });
      return new Promise<Response>((resolve) => (finish = resolve));
    }),
  );
  const oidc = await import('../utils/oidcLogin');
  const { signOut } = await import('./identity');
  const renewal = oidc.refreshTokens();
  await vi.waitFor(() => expect(finish).toBeDefined());
  try {
    await signOut();
    expect(assign).toHaveBeenCalledWith('/');
    expect(lockNames).toEqual(['huabu.oidc.refresh', 'huabu.session']);
  } finally {
    finish(
      Response.json({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
      }),
    );
  }
  await expect(renewal).resolves.toBeNull();
  await expect(oidc.refreshTokens()).resolves.toBeNull();
  expect(sessionStorage.getItem('huabu.oidc.refresh')).toBeNull();
});
