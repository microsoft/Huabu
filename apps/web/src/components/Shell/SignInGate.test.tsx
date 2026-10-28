// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignInGate } from './SignInGate';
import { AUTH_REQUIRED_EVENT } from '../../api/_client';
import { useIdentityStore } from '../../store/identityStore';

// The brand animation draws on a canvas the test DOM does not provide.
vi.mock('../../pages/WorkspaceLoadingScreen', () => ({
  WorkspaceLoadingScreen: () => null,
}));
const unsaved = vi.hoisted(() => vi.fn(() => false));
const resend = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../store/canvasStore', () => ({
  hasUnsavedCanvasEdits: unsaved,
  resendUnsavedCanvasEdits: resend,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(' ')}` : key,
  }),
}));

const MEMBER = {
  provider: 'bubble',
  principal: { principalId: 'carol', kind: 'user', displayName: 'Carol' },
  member: true,
  owner: false,
};
const ENTRA = {
  driver: 'entra',
  interactive: true,
  issuer: 'https://login.example/tenant/v2.0',
  authorizationUrl: 'https://login.example/tenant/authorize',
  clientId: 'spa',
  scopes: ['api://huabu/access'],
};

type Route = (init?: RequestInit) => Response;
let routes: Record<string, Route>;
let calls: Array<{ url: string; init?: RequestInit }>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const key = `${init?.method ?? 'GET'} ${url}`;
      const route = routes[key];
      if (!route) throw new Error(`Unexpected request ${key}`);
      return route(init);
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useIdentityStore.setState({ identity: null });
  sessionStorage.clear();
  window.history.replaceState(null, '', '/spaces');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(strict = false) {
  const gate = (
    <SignInGate>
      <p>app</p>
    </SignInGate>
  );
  await act(async () => {
    root.render(strict ? <StrictMode>{gate}</StrictMode> : gate);
  });
  // Let the identity checks settle.
  for (let i = 0; i < 5; i++) await act(async () => {});
}

describe('SignInGate', () => {
  it('renders the app at once for a resolved member', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    expect(container.textContent).toBe('app');
    expect(useIdentityStore.getState().identity).toEqual(MEMBER);
  });

  it('leaves a login prompt to the browser when the Server does not run Bubble', async () => {
    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () => json({}, 404);
    await mount();
    expect(container.textContent).toBe('app');
  });

  it('explains a Bubble Server that offers no browser login instead of rendering the app', async () => {
    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      json({ authenticators: [{ driver: 'master-key', interactive: false }] });
    await mount();
    expect(container.textContent).toContain('auth.noSignInMethods');
    expect(container.textContent).not.toContain('app');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers each interactive Bubble login and tells a non-member they lack access', async () => {
    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      json({
        authenticators: [ENTRA, { driver: 'master-key', interactive: false }],
      });
    await mount();
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'auth.continueWith Microsoft Entra ID',
    ]);

    routes['GET /api/identity'] = () => json({ ...MEMBER, member: false });
    await act(async () => {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(container.textContent).toContain('auth.noAccessTitle');
    expect(container.textContent).toContain('Carol');
  });

  it('keeps the app, and its unsaved edits, under the sign-in screen when a session lapses', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    expect(container.textContent).toBe('app');

    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      json({ authenticators: [ENTRA] });
    unsaved.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
    // Signing in happens in a popup, so nothing is lost and nothing warns.
    expect(container.textContent).toContain('app');
    expect(container.textContent).toContain('auth.signInTitle');
    expect(container.textContent).not.toContain('auth.signInUnsaved');
  });

  it('renews a lapsing session in place with the refresh token the login gave', async () => {
    sessionStorage.setItem(
      'huabu.oidc.pending',
      JSON.stringify({
        state: 'expected',
        verifier: 'verifier',
        authenticator: ENTRA,
        returnTo: '/canvas/mine',
      }),
    );
    window.history.replaceState(
      null,
      '',
      '/auth/callback?code=the-code&state=expected',
    );
    routes[
      'GET https://login.example/tenant/v2.0/.well-known/openid-configuration'
    ] = () => json({ token_endpoint: 'https://login.example/token' });
    let issued = 0;
    routes['POST https://login.example/token'] = () =>
      json({
        access_token: `access-${++issued}`,
        refresh_token: `refresh-${issued}`,
      });
    routes['POST /api/identity/session'] = () =>
      new Response(null, { status: 204 });
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    expect(container.textContent).toBe('app');

    await act(async () => {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
    const grants = calls
      .filter((call) => call.url === 'https://login.example/token')
      .map((call) =>
        Object.fromEntries(new URLSearchParams(String(call.init?.body))),
      );
    expect(grants[1]).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'spa',
    });
    const sessions = calls.filter(
      (call) => call.url === '/api/identity/session',
    );
    expect(
      new Headers(sessions.at(-1)?.init?.headers).get('Authorization'),
    ).toBe('Bearer access-2');
    // The page never left, and what the lapse refused goes out again.
    expect(container.textContent).toBe('app');
    expect(resend).toHaveBeenCalled();
  });

  it('completes a provider redirect by handing the token to the Server', async () => {
    sessionStorage.setItem(
      'huabu.oidc.pending',
      JSON.stringify({
        state: 'expected',
        verifier: 'verifier',
        authenticator: ENTRA,
        returnTo: '/canvas/mine',
      }),
    );
    window.history.replaceState(
      null,
      '',
      '/auth/callback?code=the-code&state=expected',
    );
    routes[
      'GET https://login.example/tenant/v2.0/.well-known/openid-configuration'
    ] = () => json({ token_endpoint: 'https://login.example/token' });
    routes['POST https://login.example/token'] = () =>
      json({ access_token: 'access' });
    routes['POST /api/identity/session'] = () =>
      new Response(null, { status: 204 });
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();

    expect(container.textContent).toBe('app');
    expect(window.location.pathname).toBe('/canvas/mine');
    const exchange = calls.find(
      (call) => call.url === 'https://login.example/token',
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(exchange?.init?.body))),
    ).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'verifier',
      client_id: 'spa',
      redirect_uri: `${window.location.origin}/auth/callback`,
    });
    const session = calls.find((call) => call.url === '/api/identity/session');
    expect(new Headers(session?.init?.headers).get('Authorization')).toBe(
      'Bearer access',
    );
    expect(sessionStorage.getItem('huabu.oidc.pending')).toBeNull();
  });

  it('tells a refused account it is denied, with a way to sign out', async () => {
    routes['GET /api/identity'] = () => json({}, 403);
    await mount();
    expect(container.textContent).toContain('auth.deniedIntro');
    expect(container.textContent).not.toContain('app');
    expect(
      [...container.querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['auth.signOut']);
  });

  it('falls back to the app when sign-in discovery fails', async () => {
    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      new Response('not json', { status: 200 });
    await mount();
    expect(container.textContent).toBe('app');
  });

  it('stays on the screen and says so when the Server does not confirm sign-out', async () => {
    routes['GET /api/identity'] = () => json({ ...MEMBER, member: false });
    routes['DELETE /api/identity/session'] = () => json({}, 503);
    await mount();
    await act(async () => {
      container.querySelector('button')?.click();
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(container.textContent).toContain('auth.signOutFailed');
    expect(window.location.pathname).toBe('/spaces');
  });

  it('lets only the latest identity check decide', async () => {
    routes['GET /api/identity'] = () => json({}, 401);
    let releaseStale: () => void = () => {};
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      json({ authenticators: [ENTRA] });
    await mount();
    expect(container.textContent).toContain('auth.continueWith');

    // A check still waiting on discovery from before sign-in completed…
    routes['GET /bubble/v1/auth/authenticators'] = () => {
      throw new Error('unreachable');
    };
    const stale = new Promise<Response>((resolve) => {
      releaseStale = () => resolve(json({ authenticators: [ENTRA] }));
    });
    vi.mocked(fetch).mockImplementationOnce(async () => json({}, 401));
    vi.mocked(fetch).mockImplementationOnce(() => stale);
    await act(async () => {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    });
    // …is overtaken by one that finds the session.
    routes['GET /api/identity'] = () => json(MEMBER);
    await act(async () => {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    });
    for (let i = 0; i < 5; i++) await act(async () => {});
    await act(async () => releaseStale());
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(container.textContent).toBe('app');
  });

  it('completes a provider redirect once under StrictMode', async () => {
    sessionStorage.setItem(
      'huabu.oidc.pending',
      JSON.stringify({
        state: 'expected',
        verifier: 'verifier',
        authenticator: ENTRA,
        returnTo: '/canvas/mine',
      }),
    );
    window.history.replaceState(
      null,
      '',
      '/auth/callback?code=the-code&state=expected',
    );
    let session = false;
    routes[
      'GET https://login.example/tenant/v2.0/.well-known/openid-configuration'
    ] = () => json({ token_endpoint: 'https://login.example/token' });
    routes['POST https://login.example/token'] = () =>
      json({ access_token: 'access' });
    routes['POST /api/identity/session'] = () => {
      session = true;
      return new Response(null, { status: 204 });
    };
    routes['GET /api/identity'] = () =>
      session ? json(MEMBER) : json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      json({ authenticators: [ENTRA] });
    await mount(true);
    for (let i = 0; i < 10; i++) await act(async () => {});
    expect(container.textContent).toBe('app');
    expect(
      calls.filter((call) => call.url === 'https://login.example/token'),
    ).toHaveLength(1);
  });

  it('ignores a redirect whose state it did not issue', async () => {
    sessionStorage.setItem(
      'huabu.oidc.pending',
      JSON.stringify({
        state: 'expected',
        verifier: 'v',
        authenticator: ENTRA,
        returnTo: '/',
      }),
    );
    window.history.replaceState(
      null,
      '',
      '/auth/callback?code=forged&state=other',
    );
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    expect(calls.map((call) => call.url)).toEqual(['/api/identity']);
  });
});
