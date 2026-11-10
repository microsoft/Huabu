// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignInGate } from './SignInGate';
import { AUTH_REQUIRED_EVENT } from '../../api/_client';
import { SESSION_CHANGE_EVENT } from '../../api/identity';
import { useIdentityStore } from '../../store/identityStore';
import * as oidc from '../../utils/oidcLogin';
import { forgetTokens } from '../../utils/oidcLogin';

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
  forgetTokens();
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
  oidc.forgetTokens();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/spaces');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('shows a blocked-popup error over the running app and permits retry', async () => {
  routes['GET /api/identity'] = () => json(MEMBER);
  await mount();
  routes['GET /api/identity'] = () => json({}, 401);
  routes['GET /bubble/v1/auth/authenticators'] = () =>
    json({ authenticators: [ENTRA] });
  await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  for (let i = 0; i < 5; i++) await act(async () => {});
  vi.spyOn(window, 'open').mockReturnValue(null);
  await act(async () => container.querySelector('button')?.click());
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(container.textContent).toContain(
    'The browser blocked the sign-in window',
  );
  await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(container.textContent).toContain(
    'The browser blocked the sign-in window',
  );
  expect(container.textContent).toContain('app');
  expect(container.querySelector('button')?.disabled).toBe(false);
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

/** A peer owns the native session lock until its write finishes or tab closes. */
function holdSessionWrite(): () => void {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const tails = new Map<string, Promise<unknown>>([['huabu.session', barrier]]);
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
  return release;
}

describe('SignInGate', () => {
  it.each(['identity', 'discovery'])(
    'waits for initial %s recovery before starting the app or replaying edits',
    async (unavailable) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      routes['GET /api/identity'] = () =>
        json({}, unavailable === 'identity' ? 503 : 401);
      routes['GET /bubble/v1/auth/authenticators'] = () => json({}, 503);
      resend.mockClear();
      try {
        await mount();
        expect(container.textContent).not.toContain('app');
        expect(useIdentityStore.getState().identity).toBeNull();
        routes['GET /api/identity'] = () => json(MEMBER);
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        expect(container.textContent).toBe('app');
        expect(useIdentityStore.getState().identity).toEqual(MEMBER);
        expect(resend).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

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

  it('opens a new or reloaded tab on the session another tab can renew', async () => {
    const tab = new BroadcastChannel('huabu.oidc');
    try {
      localStorage.setItem('huabu.oidc.refresh.revision', 'current-peer');
      tab.postMessage({
        type: 'held',
        held: {
          authenticator: ENTRA,
          refreshToken: 'kept',
          expiresAt: 0,
          revision: 'current-peer',
        },
      });
      await vi.waitFor(() =>
        expect(sessionStorage.getItem('huabu.oidc.refresh')).toContain('kept'),
      );
    } finally {
      tab.close();
    }
    routes[
      'GET https://login.example/tenant/v2.0/.well-known/openid-configuration'
    ] = () => json({ token_endpoint: 'https://login.example/token' });
    routes['POST https://login.example/token'] = () =>
      json({
        access_token: 'renewed',
        refresh_token: 'next',
        expires_in: 3600,
      });
    let signedIn = false;
    routes['POST /api/identity/session'] = () => {
      signedIn = true;
      return new Response(null, { status: 204 });
    };
    routes['GET /api/identity'] = () =>
      signedIn ? json(MEMBER) : json({}, 401);
    await mount();
    for (let i = 0; i < 10; i++) await act(async () => {});
    // The lapsed cookie never reaches the sign-in screen.
    expect(container.textContent).toBe('app');
    expect(
      calls.some((call) => call.url === '/bubble/v1/auth/authenticators'),
    ).toBe(false);
  });

  it('admits someone waiting for access when they return to the page', async () => {
    routes['GET /api/identity'] = () => json({ ...MEMBER, member: false });
    await mount();
    expect(container.textContent).toContain('auth.noAccessTitle');
    routes['GET /api/identity'] = () => json(MEMBER);
    await act(async () => window.dispatchEvent(new Event('focus')));
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(container.textContent).toBe('app');
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

  it.each([false, true])(
    "ends a refused account's provider session only where the Server does (%s)",
    async (providerSignOut) => {
      routes['GET /api/identity'] = () =>
        json(
          {
            code: 'IDENTITY_FORBIDDEN',
            ...(providerSignOut ? { providerSignOut } : {}),
          },
          403,
        );
      routes['DELETE /api/identity/session'] = () => json({}, 503);
      routes['GET /bubble/v1/auth/authenticators'] = () =>
        json({ authenticators: [] });
      await mount();
      await act(async () => container.querySelector('button')?.click());
      for (let i = 0; i < 5; i++) await act(async () => {});
      // The Server refused the sign-out, so nothing left the page either way;
      // with provider sign-out on, the provider is looked up only after that.
      expect(container.textContent).toContain('auth.signOutFailed');
      expect(calls.map((call) => call.url)).not.toContain(
        '/bubble/v1/auth/authenticators',
      );
      routes['DELETE /api/identity/session'] = () =>
        new Response(null, { status: 204 });
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, assign });
      await act(async () => container.querySelector('button')?.click());
      for (let i = 0; i < 5; i++) await act(async () => {});
      expect(
        calls.some((call) => call.url === '/bubble/v1/auth/authenticators'),
      ).toBe(providerSignOut);
      expect(assign).toHaveBeenCalledWith('/');
    },
  );

  it('rechecks a running app on its own while the Server is unreachable', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      routes['GET /api/identity'] = () => {
        throw new TypeError('Failed to fetch');
      };
      routes['GET /bubble/v1/auth/authenticators'] = () =>
        json({ authenticators: [ENTRA] });
      await act(async () =>
        window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
      );
      for (let i = 0; i < 5; i++) await act(async () => {});
      // Covered, with a usable sign-in method though none was listed before.
      expect(container.textContent).toContain('auth.signInTitle');
      expect(container.textContent).toContain('auth.continueWith');

      routes['GET /api/identity'] = () => json(MEMBER);
      await act(async () => vi.advanceTimersByTime(2_000));
      for (let i = 0; i < 5; i++) await act(async () => {});
      expect(container.textContent).toBe('app');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the app closed when initial sign-in discovery is malformed', async () => {
    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () =>
      new Response('not json', { status: 200 });
    await mount();
    expect(container.textContent).not.toContain('app');
  });

  it.each([429, 503])(
    'keeps a running Bubble app covered and retries after discovery HTTP %i',
    async (status) => {
      routes['GET /api/identity'] = () => json(MEMBER);
      await mount();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      resend.mockClear();
      try {
        routes['GET /api/identity'] = () => json({}, 401);
        routes['GET /bubble/v1/auth/authenticators'] = () => json({}, status);
        await act(async () =>
          window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
        );
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        expect(container.querySelector('[inert]')).not.toBeNull();
        expect(resend).not.toHaveBeenCalled();

        routes['GET /bubble/v1/auth/authenticators'] = () =>
          json({ authenticators: [ENTRA] });
        await act(async () => vi.advanceTimersByTime(2_000));
        expect(container.textContent).toContain('auth.continueWith');
        expect(container.querySelector('[inert]')).not.toBeNull();
        expect(resend).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('leaves a running local deployment to the browser on a Basic Auth challenge', async () => {
    routes['GET /api/identity'] = () => json({ ...MEMBER, provider: 'local' });
    await mount();
    routes['GET /api/identity'] = () => json({}, 401);
    routes['GET /bubble/v1/auth/authenticators'] = () => json({}, 401);
    await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
    expect(container.textContent).toBe('app');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('resends refused saves when the existing cookie recovers without a refresh token', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resend.mockClear();
    try {
      routes['GET /api/identity'] = () => {
        throw new TypeError('Failed to fetch');
      };
      routes['GET /bubble/v1/auth/authenticators'] = () =>
        json({ authenticators: [ENTRA] });
      await act(async () =>
        window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
      );
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(resend).not.toHaveBeenCalled();

      routes['GET /api/identity'] = () => json(MEMBER);
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(container.textContent).toBe('app');
      expect(container.querySelector('[inert]')).toBeNull();
      expect(resend).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resend old edits when a recovered cookie belongs to another account', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    resend.mockClear();
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => {});
    routes['GET /api/identity'] = () =>
      json({
        ...MEMBER,
        principal: { ...MEMBER.principal, principalId: 'dave' },
      });
    await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
    expect(reload).toHaveBeenCalledOnce();
    expect(resend).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('app');
  });

  it.each(['focus', 'visibilitychange'])(
    'reloads a ready peer on %s when the shared cookie changes account, without replaying edits',
    async (event) => {
      routes['GET /api/identity'] = () => json(MEMBER);
      await mount();
      resend.mockClear();
      const reload = vi
        .spyOn(window.location, 'reload')
        .mockImplementation(() => {});
      routes['GET /api/identity'] = () =>
        json({
          ...MEMBER,
          principal: { ...MEMBER.principal, principalId: 'dave' },
        });
      await act(async () => {
        (event === 'focus' ? window : document).dispatchEvent(new Event(event));
      });
      expect(reload).toHaveBeenCalledOnce();
      expect(resend).not.toHaveBeenCalled();
      expect(useIdentityStore.getState().identity).toEqual(MEMBER);
      expect(container.textContent).not.toContain('app');
    },
  );

  it('blocks a ready peer during foreground verification and retains the same account draft without replay', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await act(async () =>
      root.render(
        <SignInGate>
          <input aria-label="Draft" defaultValue="unsaved draft" />
        </SignInGate>,
      ),
    );
    for (let i = 0; i < 5; i++) await act(async () => {});
    const draft = container.querySelector('input');
    resend.mockClear();
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    );
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('[inert]')).not.toBeNull();
    expect(container.querySelector('input')).toBe(draft);
    await act(async () => finish(json(MEMBER)));
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.querySelector('input')).toBe(draft);
    expect(draft?.value).toBe('unsaved draft');
    expect(resend).not.toHaveBeenCalled();
  });

  it.each(['completed', 'closed'])(
    'blocks a ready peer during a cookie write whose tab %s, then verifies without replaying another account draft',
    async (writer) => {
      routes['GET /api/identity'] = () => json(MEMBER);
      await mount();
      resend.mockClear();
      const reload = vi
        .spyOn(window.location, 'reload')
        .mockImplementation(() => {});
      const peer = new BroadcastChannel('huabu.session');
      const release = holdSessionWrite();
      try {
        const before = calls.length;
        peer.postMessage('changing');
        await vi.waitFor(() =>
          expect(container.querySelector('[inert]')).not.toBeNull(),
        );
        expect(calls).toHaveLength(before);
        routes['GET /api/identity'] = () =>
          json({
            ...MEMBER,
            principal: { ...MEMBER.principal, principalId: 'dave' },
          });
        if (writer === 'completed') peer.postMessage('changed');
        else peer.close();
        await act(async () => release());
        await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
        expect(resend).not.toHaveBeenCalled();
        expect(useIdentityStore.getState().identity).toEqual(MEMBER);
        expect(container.textContent).not.toContain('app');
      } finally {
        release();
        peer.close();
      }
    },
  );

  it('keeps the peer covered when another tab signs out, then resumes only the same principal', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    resend.mockClear();
    const peer = new BroadcastChannel('huabu.session');
    try {
      routes['GET /api/identity'] = () => json({}, 401);
      routes['GET /bubble/v1/auth/authenticators'] = () =>
        json({ authenticators: [ENTRA] });
      peer.postMessage('changing');
      peer.postMessage('changed');
      await vi.waitFor(() =>
        expect(container.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      expect(container.querySelector('[inert]')).not.toBeNull();
      routes['GET /api/identity'] = () => json(MEMBER);
      peer.postMessage('changing');
      peer.postMessage('changed');
      await vi.waitFor(() => expect(container.textContent).toBe('app'));
      expect(container.querySelector('[inert]')).toBeNull();
      expect(resend).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it('keeps a peer without Web Locks covered until a cookie write completes, including foreground checks', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    vi.spyOn(navigator, 'locks', 'get').mockReturnValue(
      undefined as unknown as LockManager,
    );
    resend.mockClear();
    const reload = vi
      .spyOn(window.location, 'reload')
      .mockImplementation(() => {});
    const peer = new BroadcastChannel('huabu.session');
    const before = calls.length;
    try {
      peer.postMessage('changing');
      await vi.waitFor(() =>
        expect(container.querySelector('[inert]')).not.toBeNull(),
      );
      await act(async () => window.dispatchEvent(new Event('focus')));
      expect(calls).toHaveLength(before);
      expect(container.querySelector('[inert]')).not.toBeNull();
      routes['GET /api/identity'] = () =>
        json({
          ...MEMBER,
          principal: { ...MEMBER.principal, principalId: 'dave' },
        });
      peer.postMessage('changed');
      await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
      expect(resend).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it('does not uncover a peer with an identity response from before another tab started changing the cookie', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    const peer = new BroadcastChannel('huabu.session');
    let finish!: (response: Response) => void;
    let release: (() => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => (finish = resolve)),
    );
    try {
      await act(async () => window.dispatchEvent(new Event('focus')));
      release = holdSessionWrite();
      const changing = new Promise<void>((resolve) =>
        window.addEventListener(SESSION_CHANGE_EVENT, () => resolve(), {
          once: true,
        }),
      );
      await act(async () => {
        peer.postMessage('changing');
        await changing;
      });
      await act(async () => finish(json(MEMBER)));
      expect(container.querySelector('[inert]')).not.toBeNull();
      peer.postMessage('changed');
      await act(async () => release?.());
      await vi.waitFor(() =>
        expect(container.querySelector('[inert]')).toBeNull(),
      );
    } finally {
      release?.();
      peer.close();
    }
  });

  it.each([200, 401, 503])(
    'recovers automatically after a peer closes without a terminal notification or new focus event, with identity HTTP %i',
    async (status) => {
      routes['GET /api/identity'] = () => json(MEMBER);
      await mount();
      resend.mockClear();
      const peer = new BroadcastChannel('huabu.session');
      const release = holdSessionWrite();
      peer.postMessage('changing');
      await vi.waitFor(() =>
        expect(container.querySelector('[inert]')).not.toBeNull(),
      );
      peer.close();
      routes['GET /api/identity'] = () => json(MEMBER, status);
      routes['GET /bubble/v1/auth/authenticators'] = () =>
        json({ authenticators: [ENTRA] });
      await act(async () => release());
      expect(resend).not.toHaveBeenCalled();
      if (status === 200) {
        expect(container.querySelector('[inert]')).toBeNull();
      } else {
        expect(container.querySelector('[inert]')).not.toBeNull();
        routes['GET /api/identity'] = () => json(MEMBER);
        await act(async () =>
          window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
        );
        expect(container.querySelector('[inert]')).toBeNull();
        expect(resend).toHaveBeenCalledOnce();
      }
    },
  );

  it('replays drafts only after the newer check that superseded a recovery verifies the same principal', async () => {
    routes['GET /api/identity'] = () => json(MEMBER);
    await mount();
    resend.mockClear();
    let finish!: (response: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(MEMBER))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (finish = resolve)),
      );
    const unsubscribe = useIdentityStore.subscribe(() => {
      unsubscribe();
      window.dispatchEvent(new Event('focus'));
    });
    try {
      await act(async () =>
        window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)),
      );
      expect(container.querySelector('[inert]')).not.toBeNull();
      expect(resend).not.toHaveBeenCalled();
      // The focus check verifies the same person, so the recovery's refused
      // saves are resent there rather than stranded.
      await act(async () => finish(json(MEMBER)));
      await vi.waitFor(() => expect(resend).toHaveBeenCalledOnce());
      expect(container.querySelector('[inert]')).toBeNull();
    } finally {
      unsubscribe();
    }
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

it('reloads on an account change without resuming the old app or replaying edits', async () => {
  routes['GET /api/identity'] = () => json(MEMBER);
  await mount();
  routes['GET /api/identity'] = () => json({}, 401);
  routes['GET /bubble/v1/auth/authenticators'] = () =>
    json({ authenticators: [ENTRA] });
  await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  for (let i = 0; i < 5; i++) await act(async () => {});
  const reload = vi
    .spyOn(window.location, 'reload')
    .mockImplementation(() => {});
  vi.spyOn(oidc, 'signInWithPopup').mockResolvedValue({
    accessToken: 'dave-token',
  });
  routes['POST /api/identity/session'] = () => {
    routes['GET /api/identity'] = () =>
      json({
        ...MEMBER,
        principal: { ...MEMBER.principal, principalId: 'dave' },
      });
    return new Response(null, { status: 204 });
  };
  resend.mockClear();
  await act(async () => container.querySelector('button')?.click());
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(reload).toHaveBeenCalledOnce();
  expect(resend).not.toHaveBeenCalled();
  expect(useIdentityStore.getState().identity?.principal.principalId).toBe(
    'carol',
  );
  expect(container.textContent).not.toContain('app');
});

it('bounds renewal delays and stops when the Server rejects renewed tokens', async () => {
  sessionStorage.setItem(
    'huabu.oidc.pending',
    JSON.stringify({
      state: 'expected',
      verifier: 'v',
      authenticator: ENTRA,
      returnTo: '/spaces',
    }),
  );
  window.history.replaceState(null, '', '/auth/callback?code=c&state=expected');
  routes[
    'GET https://login.example/tenant/v2.0/.well-known/openid-configuration'
  ] = () => json({ token_endpoint: 'https://login.example/token' });
  routes['POST https://login.example/token'] = () =>
    json({
      access_token: 'fresh',
      refresh_token: 'refresh',
      expires_in: 2592000,
    });
  routes['POST /api/identity/session'] = () =>
    new Response(null, { status: 204 });
  routes['GET /api/identity'] = () => json(MEMBER);
  const timer = vi.spyOn(window, 'setTimeout');
  await mount();
  expect(timer.mock.calls.some(([, delay]) => delay === 2 ** 31 - 1)).toBe(
    true,
  );
  routes['POST /api/identity/session'] = () =>
    json({ code: 'IDENTITY_REQUIRED' }, 401);
  routes['GET /api/identity'] = () => json({}, 401);
  routes['GET /bubble/v1/auth/authenticators'] = () =>
    json({ authenticators: [ENTRA] });
  await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  for (let i = 0; i < 15; i++) await act(async () => {});
  expect(calls.filter((c) => c.url === '/api/identity/session')).toHaveLength(
    2,
  );
  expect(container.textContent).toContain('Sign-in was not accepted');
});

it('keeps renewal blocked when the adopted session identity cannot be verified', async () => {
  routes['GET /api/identity'] = () => json(MEMBER);
  await mount();
  routes['GET /api/identity'] = () => json({}, 401);
  routes['GET /bubble/v1/auth/authenticators'] = () =>
    json({ authenticators: [ENTRA] });
  await act(async () => window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT)));
  for (let i = 0; i < 5; i++) await act(async () => {});
  vi.spyOn(oidc, 'signInWithPopup').mockResolvedValue({
    accessToken: 'unknown-account',
  });
  routes['POST /api/identity/session'] = () => {
    routes['GET /api/identity'] = () => {
      throw new Error('Identity service unavailable');
    };
    return new Response(null, { status: 204 });
  };
  resend.mockClear();
  await act(async () => container.querySelector('button')?.click());
  for (let i = 0; i < 5; i++) await act(async () => {});
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[inert]')).not.toBeNull();
  expect(container.textContent).toContain('Identity service unavailable');
  expect(resend).not.toHaveBeenCalled();
});
