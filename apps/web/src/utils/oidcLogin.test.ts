// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshTokens, signInWithPopup } from './oidcLogin';

const ENTRA = {
  driver: 'entra',
  interactive: true as const,
  issuer: 'https://login.example/tenant/v2.0',
  authorizationUrl: 'https://login.example/tenant/authorize',
  clientId: 'spa',
  scopes: ['api://huabu/access'],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
