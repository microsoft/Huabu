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
      { accessToken: 'renewed' },
      { accessToken: 'renewed' },
    ]);
    expect(await refreshTokens()).toEqual({ accessToken: 'third' });
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

  it('logs out the selected provider when multiple providers are configured', async () => {
    const assign = vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE')
          return new Response(null, { status: 204 });
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
        return Response.json({ access_token: 'initial', refresh_token: 'r1' });
      }),
    );
    await holdRefreshToken();
    await signOut({ providerSignOut: true });
    expect(assign).toHaveBeenCalledWith(
      expect.stringContaining('https://login.example/logout?'),
    );
    expect(heldAuthenticator()).toBeNull();
  });
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
    expect(bodies[1]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh',
    });
  });

  it('fails plainly when the browser blocks the window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(signInWithPopup(ENTRA)).rejects.toThrow(/blocked/);
  });
});
