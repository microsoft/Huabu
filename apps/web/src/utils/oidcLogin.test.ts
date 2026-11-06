// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completeLogin,
  forgetTokens,
  heldAuthenticator,
  refreshTokens,
  signInWithPopup,
} from './oidcLogin';
import { signOut } from '../api/identity';

const ENTRA = {
  driver: 'entra',
  interactive: true as const,
  issuer: 'https://login.example/tenant/v2.0',
  authorizationUrl: 'https://login.example/tenant/authorize',
  clientId: 'spa',
  scopes: ['api://huabu/access'],
};

afterEach(() => {
  forgetTokens();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function holdRefreshToken() {
  sessionStorage.setItem(
    'huabu.oidc.pending',
    JSON.stringify({
      state: 'expected',
      verifier: 'v',
      authenticator: ENTRA,
      returnTo: '/',
    }),
  );
  window.history.replaceState(null, '', '/auth/callback?code=c&state=expected');
  await completeLogin();
}

describe('session renewal', () => {
  it('shares one rotating refresh across concurrent callers and permits the next rotation', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let refreshCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('openid-configuration'))
          return Response.json({
            token_endpoint: 'https://login.example/token',
          });
        const grant = new URLSearchParams(String(init?.body));
        if (grant.get('grant_type') === 'authorization_code')
          return Response.json({
            access_token: 'initial',
            refresh_token: 'r1',
          });
        refreshCalls++;
        if (refreshCalls === 1) return pending;
        expect(grant.get('refresh_token')).toBe('r2');
        return Response.json({ access_token: 'third', refresh_token: 'r3' });
      }),
    );
    await holdRefreshToken();
    const first = refreshTokens();
    const second = refreshTokens();
    await vi.waitFor(() => expect(refreshCalls).toBeGreaterThan(0));
    expect(refreshCalls).toBe(1);
    release(Response.json({ access_token: 'renewed', refresh_token: 'r2' }));
    expect(await Promise.all([first, second])).toEqual([
      { accessToken: 'renewed', renewal: true },
      { accessToken: 'renewed', renewal: true },
    ]);
    expect(await refreshTokens()).toEqual({
      accessToken: 'third',
      renewal: true,
    });
  });

  it('does not restore a refresh token when an in-flight renewal finishes after sign-out', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('openid-configuration'))
          return Response.json({
            token_endpoint: 'https://login.example/token',
          });
        return new URLSearchParams(String(init?.body)).get('grant_type') ===
          'authorization_code'
          ? Response.json({ access_token: 'initial', refresh_token: 'r1' })
          : pending;
      }),
    );
    await holdRefreshToken();
    const renewal = refreshTokens();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4));
    forgetTokens();
    release(
      Response.json({ access_token: 'late', refresh_token: 'late-refresh' }),
    );
    expect(await renewal).toBeNull();
    expect(await refreshTokens()).toBeNull();
    expect(heldAuthenticator()).toBeNull();
  });

  it.each([false, true])(
    'logs out the selected provider with multiple providers (retry=%s)',
    async (retry) => {
      const assign = vi
        .spyOn(window.location, 'assign')
        .mockImplementation(() => {});
      let deleteAttempts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'DELETE') {
            deleteAttempts += 1;
            return new Response(null, {
              status: retry && deleteAttempts === 1 ? 503 : 204,
            });
          }
          if (String(input).includes('/bubble/'))
            return Response.json({
              authenticators: [
                ENTRA,
                { ...ENTRA, driver: 'auth0', issuer: 'https://auth0.example' },
              ],
            });
          if (String(input).endsWith('openid-configuration'))
            return Response.json({
              token_endpoint: 'https://login.example/token',
              end_session_endpoint: 'https://login.example/logout',
            });
          return Response.json({
            access_token: 'initial',
            refresh_token: 'r1',
          });
        }),
      );
      await holdRefreshToken();
      if (retry) {
        await expect(signOut({ providerSignOut: true })).rejects.toThrow();
        expect(await refreshTokens()).toBeNull();
        expect(heldAuthenticator()).toEqual(ENTRA);
        expect(assign).not.toHaveBeenCalled();
      }
      await signOut({ providerSignOut: true });
      expect(assign).toHaveBeenCalledWith(
        expect.stringContaining('https://login.example/logout?'),
      );
      expect(heldAuthenticator()).toBeNull();
    },
  );
});

describe('signing in again in a popup', () => {
  it('redeems the code the popup posts back, with a verifier only this page held', async () => {
    const popup = { closed: false, location: { href: '' } };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const bodies: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration'))
          return Response.json({ token_endpoint: 'https://login.example/t' });
        bodies.push(
          Object.fromEntries(new URLSearchParams(String(init?.body))),
        );
        return Response.json({
          access_token: 'fresh',
          refresh_token: 'refresh',
          expires_in: 3600,
        });
      }),
    );

    const signingIn = signInWithPopup(ENTRA);
    await vi.waitFor(() => expect(popup.location.href).not.toBe(''));
    const sent = new URL(popup.location.href);
    expect(sent.searchParams.get('scope')).toContain('offline_access');
    const state = sent.searchParams.get('state')!;

    // Another origin, or another login's state, is ignored.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'huabu.oidc.popup', state, code: 'stolen' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'huabu.oidc.popup', state: 'popup.other', code: 'x' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'huabu.oidc.popup', state, code: 'the-code' },
      }),
    );

    await expect(signingIn).resolves.toEqual({
      accessToken: 'fresh',
      expiresIn: 3600,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'spa',
    });
    expect(bodies[0].code_verifier).toBeTruthy();

    // The refresh token it brought renews the next session.
    await expect(refreshTokens()).resolves.toMatchObject({
      accessToken: 'fresh',
    });
    // Entra refuses a refresh without the scope its API was granted under
    // (AADSTS90009), so the original scope is named again.
    expect(bodies[1]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh',
      scope: 'api://huabu/access openid profile offline_access',
    });
  });

  it('fails plainly when the browser blocks the window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(signInWithPopup(ENTRA)).rejects.toThrow(/blocked/);
  });
});

describe('renewal failures', () => {
  it('retains the refresh token after a network failure but drops an invalid grant', async () => {
    let mode = 'login';
    const tokenFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('openid-configuration'))
        return Response.json({ token_endpoint: 'https://login.example/t' });
      if (mode === 'network') throw new TypeError('Failed to fetch');
      if (mode === 'rejected')
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'fresh', refresh_token: 'refresh' });
    });
    vi.stubGlobal('fetch', tokenFetch);
    await holdRefreshToken();
    mode = 'network';
    expect(await refreshTokens()).toBeNull();
    mode = 'recovered';
    expect(await refreshTokens()).toEqual({
      accessToken: 'fresh',
      renewal: true,
    });
    mode = 'rejected';
    expect(await refreshTokens()).toBeNull();
    tokenFetch.mockClear();
    expect(await refreshTokens()).toBeNull();
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'invalid_request', false],
    [401, 'invalid_client', false],
    [429, 'temporarily_unavailable', true],
    [503, 'temporarily_unavailable', true],
  ])(
    'after HTTP %i %s keeps the refresh token: %s',
    async (status, error, kept) => {
      let refused = false;
      const tokenFetch = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('openid-configuration'))
          return Response.json({ token_endpoint: 'https://login.example/t' });
        if (refused) return Response.json({ error }, { status });
        return Response.json({ access_token: 'a', refresh_token: 'r' });
      });
      vi.stubGlobal('fetch', tokenFetch);
      await holdRefreshToken();
      refused = true;
      expect(await refreshTokens()).toBeNull();
      tokenFetch.mockClear();
      await refreshTokens();
      expect(tokenFetch.mock.calls.length > 0).toBe(kept);
    },
  );

  it('does not request offline_access for an unconfigured generic OIDC provider', async () => {
    const popup = { closed: false, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith('openid-configuration')
          ? Response.json({ token_endpoint: 'https://login.example/t' })
          : Response.json({ access_token: 'fresh' }),
      ),
    );
    const signingIn = signInWithPopup({
      ...ENTRA,
      driver: 'generic-oidc',
      scopes: [],
    });
    await vi.waitFor(() => expect(popup.location.href).not.toBe(''));
    const url = new URL(popup.location.href);
    expect(url.searchParams.get('scope')).toBe('openid profile');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'huabu.oidc.popup',
          state: url.searchParams.get('state'),
          code: 'code',
        },
      }),
    );
    await signingIn;
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('leaves a callback popup open until the opener consumes its message', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('opener', { postMessage });
    const close = vi.spyOn(window, 'close');
    window.history.replaceState(
      null,
      '',
      '/auth/callback?state=popup.expected&code=ok',
    );
    expect(await completeLogin()).toBeNull();
    expect(postMessage).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('keeping the session across reloads and tabs', () => {
  function stubTokens(refreshed: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('openid-configuration'))
          return Response.json({ token_endpoint: 'https://login.example/t' });
        const grant = new URLSearchParams(String(init?.body));
        if (grant.get('grant_type') === 'refresh_token')
          refreshed.push(grant.get('refresh_token')!);
        return Response.json({
          access_token: 'fresh',
          refresh_token: `r${refreshed.length + 1}`,
          expires_in: 3600,
        });
      }),
    );
  }

  it('renews after a reload from the refresh token this tab kept', async () => {
    const refreshed: string[] = [];
    stubTokens(refreshed);
    await holdRefreshToken();
    vi.resetModules();
    const reloaded = await import('./oidcLogin');
    expect(reloaded.heldSessionExpiresIn()).toBeGreaterThan(3500);
    expect(await reloaded.refreshTokens()).toMatchObject({
      accessToken: 'fresh',
    });
    expect(refreshed).toEqual(['r1']);
    reloaded.forgetTokens();
  });

  it('shares the latest refresh token with other tabs and forgets it with them', async () => {
    const refreshed: string[] = [];
    stubTokens(refreshed);
    const tab = new BroadcastChannel('huabu.oidc');
    const heard: { type: string; held?: { refreshToken: string } }[] = [];
    tab.onmessage = (event) => heard.push(event.data);
    try {
      await holdRefreshToken();
      await vi.waitFor(() =>
        expect(heard).toContainEqual(
          expect.objectContaining({
            type: 'held',
            held: expect.objectContaining({ refreshToken: 'r1' }),
          }),
        ),
      );
      // A new tab asks, and is offered the one this tab holds.
      heard.length = 0;
      tab.postMessage({ type: 'want' });
      await vi.waitFor(() =>
        expect(heard).toContainEqual(expect.objectContaining({ type: 'held' })),
      );
      // A tab that rotated it hands on the newer one, which is redeemed next.
      tab.postMessage({
        type: 'held',
        held: { authenticator: ENTRA, refreshToken: 'from-peer' },
      });
      await vi.waitFor(() =>
        expect(sessionStorage.getItem('huabu.oidc.refresh')).toContain(
          'from-peer',
        ),
      );
      await refreshTokens();
      expect(refreshed).toEqual(['from-peer']);
      tab.postMessage({ type: 'forget' });
      await vi.waitFor(() =>
        expect(sessionStorage.getItem('huabu.oidc.refresh')).toBeNull(),
      );
      expect(await refreshTokens()).toBeNull();
    } finally {
      tab.close();
    }
  });

  it('lets two tabs redeem a rotating refresh token one at a time', async () => {
    // The test DOM has no Web Locks; grant requests in order, as browsers do.
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
    let release: (() => void) | undefined;
    const presented: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('openid-configuration'))
          return Response.json({ token_endpoint: 'https://login.example/t' });
        const grant = new URLSearchParams(String(init?.body));
        if (grant.get('grant_type') === 'authorization_code')
          return Response.json({ access_token: 'a0', refresh_token: 'r1' });
        const token = grant.get('refresh_token') ?? '';
        presented.push(token);
        if (token === 'r1')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        const next = Number(token.slice(1)) + 1;
        return Response.json({
          access_token: `a${next}`,
          refresh_token: `r${next}`,
        });
      }),
    );
    await holdRefreshToken();
    vi.resetModules();
    const otherTab = await import('./oidcLogin');
    const first = refreshTokens();
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = otherTab.refreshTokens();
    release?.();
    await Promise.all([first, second]);
    // Auth0 revokes the whole family if a used token is presented again.
    expect(presented).toEqual(['r1', 'r2']);
    otherTab.forgetTokens();
  });
});
