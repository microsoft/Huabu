// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { InteractiveAuthenticator } from '../api/identity';

/**
 * Browser login against whichever identity provider Bubble discovery names:
 * an OAuth authorization-code flow with PKCE, so no client secret is needed.
 * The Server keeps the access token in its session cookie, which lapses with
 * that token. The refresh token the provider issues renews it in place. It is
 * kept in this tab's `sessionStorage`, so a reload keeps renewing, and is gone
 * when the tab closes or anyone signs out. Huabu tabs share the latest one
 * over a `BroadcastChannel`, so a new tab renews too, and take turns
 * redeeming it under a Web Lock: a provider that rotates refresh tokens
 * (Auth0) revokes the whole family when a used one is presented again.
 */

const PENDING_KEY = 'huabu.oidc.pending';
const PROVIDER_KEY = 'huabu.oidc.provider';
const HELD_KEY = 'huabu.oidc.refresh';
/** Only this non-secret revision is shared durably; tokens stay in sessionStorage. */
const REVISION_KEY = 'huabu.oidc.refresh.revision';
const PEER_CHANNEL = 'huabu.oidc';
const REFRESH_LOCK = 'huabu.oidc.refresh';

class GrantRejectedError extends Error {}
/** A login run in a popup reports back to its opener instead of finishing. */
const POPUP_STATE_PREFIX = 'popup.';
const POPUP_MESSAGE = 'huabu.oidc.popup';

interface PendingLogin {
  state: string;
  verifier: string;
  authenticator: InteractiveAuthenticator;
  returnTo: string;
}

/** What a token endpoint answers, as far as this module reads it. */
export interface SignedInTokens {
  accessToken: string;
  /** Seconds until the access token expires, when the provider says. */
  expiresIn?: number;
  /**
   * Redeemed from a refresh token rather than from a sign-in the person just
   * completed, so it must not undo a sign-out made in another tab.
   */
  renewal?: true;
}

interface HeldRefresh {
  authenticator: InteractiveAuthenticator;
  refreshToken: string;
  /** Matches the shared revision only while this token is the latest one. */
  revision: string;
  /**
   * When the access token this refresh token last produced expires, in epoch
   * milliseconds; absent when the provider did not say.
   */
  expiresAt?: number;
}

/** What Huabu tabs tell each other about the refresh token they share. */
type PeerMessage =
  /** The latest refresh token; adopt it in place of an older one. */
  | { type: 'held'; held: HeldRefresh }
  /** A new or stale tab asks whoever holds the current refresh token. */
  | { type: 'want' }
  /** Someone signed out or in again; the shared refresh token is void. */
  | { type: 'forget' };

function isHeldRefresh(value: unknown): value is HeldRefresh {
  const candidate = value as Partial<HeldRefresh> | null;
  return (
    typeof candidate?.refreshToken === 'string' &&
    typeof candidate.revision === 'string' &&
    typeof candidate.authenticator?.driver === 'string' &&
    typeof candidate.authenticator.issuer === 'string' &&
    typeof candidate.authenticator.clientId === 'string' &&
    (candidate.expiresAt === undefined ||
      typeof candidate.expiresAt === 'number')
  );
}

/** `undefined` means storage is unavailable: only this document may renew. */
function sharedRevision(): string | null | undefined {
  try {
    return localStorage.getItem(REVISION_KEY);
  } catch {
    return undefined;
  }
}

function readStoredHeld(): HeldRefresh | null {
  try {
    const stored: unknown = JSON.parse(
      sessionStorage.getItem(HELD_KEY) ?? 'null',
    );
    return isHeldRefresh(stored) && sharedRevision() !== undefined
      ? stored
      : null;
  } catch {
    return null;
  }
}

let held: HeldRefresh | null = readStoredHeld();
let tokenGeneration = 0;
let refreshing: Promise<SignedInTokens | null> | null = null;
let signedInAuthenticator: InteractiveAuthenticator | null = null;

const peers =
  typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(PEER_CHANNEL)
    : null;

/** Hold `next` in this tab, and offer it to the others unless it came from them. */
function setHeld(next: HeldRefresh | null, { share = true } = {}): void {
  held = next;
  if (share) {
    try {
      if (next) localStorage.setItem(REVISION_KEY, next.revision);
      else localStorage.removeItem(REVISION_KEY);
    } catch {
      /* Without shared storage, renew only in the document that signed in. */
    }
  }
  try {
    if (next) sessionStorage.setItem(HELD_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(HELD_KEY);
  } catch {
    /* Storage may be disabled; memory still renews this page. */
  }
  if (share && next) post({ type: 'held', held: next });
}

function post(message: PeerMessage): void {
  try {
    peers?.postMessage(message);
  } catch {
    /* A closed channel only loses sharing. */
  }
}

peers?.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as Partial<PeerMessage> | null;
  if (
    message?.type === 'held' &&
    isHeldRefresh(message.held) &&
    message.held.revision === sharedRevision()
  )
    setHeld(message.held, { share: false });
  else if (
    message?.type === 'want' &&
    held &&
    held.revision === sharedRevision()
  )
    post({ type: 'held', held });
  else if (message?.type === 'forget') {
    tokenGeneration += 1;
    refreshing = null;
    setHeld(null, { share: false });
  }
});

// Even a reloaded tab with a stored token may have missed a rotation.
post({ type: 'want' });

/** Under the refresh lock, recover a missed broadcast or refuse the stale token. */
async function currentRefresh(): Promise<HeldRefresh | null> {
  const revision = sharedRevision();
  if (revision === undefined) return held;
  if (!revision) return null;
  if (held?.revision === revision) return held;
  if (!peers) return null;
  return new Promise((resolve) => {
    const finish = (current: HeldRefresh | null) => {
      window.clearTimeout(timer);
      peers.removeEventListener('message', receive);
      resolve(current);
    };
    const receive = () => {
      const latest = sharedRevision();
      if (!latest || held?.revision === latest) finish(latest ? held : null);
    };
    // A closed or suspended peer cannot answer; require sign-in, never replay.
    const timer = window.setTimeout(() => finish(null), 1_000);
    peers.addEventListener('message', receive);
    post({ type: 'want' });
  });
}

/**
 * Run `redeem` while no other Huabu tab redeems the shared refresh token.
 * Browsers without Web Locks redeem at once.
 */
function withRefreshLock<T>(redeem: () => Promise<T>): Promise<T> {
  const locks = (
    navigator as Navigator & {
      locks?: { request: (name: string, cb: () => Promise<T>) => Promise<T> };
    }
  ).locks;
  if (!locks) return redeem();
  return locks.request(REFRESH_LOCK, redeem);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Register this exact URI with the provider; only the sign-in gate handles it. */
export const CALLBACK_PATH = '/auth/callback';

function redirectUri(): string {
  return `${window.location.origin}${CALLBACK_PATH}`;
}

/**
 * The scope sign-in asks for, and asks for again on every refresh. Entra
 * refuses a refresh that names no scope when the app's API is its own
 * audience (AADSTS90009); naming the original scope is valid for every
 * provider (RFC 6749 §6). `offline_access` asks for the refresh token.
 */
function requestedScope(authenticator: InteractiveAuthenticator): string {
  return [
    ...new Set([
      ...authenticator.scopes,
      'openid',
      'profile',
      ...(['entra', 'auth0'].includes(authenticator.driver)
        ? ['offline_access']
        : []),
    ]),
  ].join(' ');
}

async function authorizationUrl(
  authenticator: InteractiveAuthenticator,
  state: string,
  verifier: string,
): Promise<string> {
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: authenticator.clientId,
    redirect_uri: redirectUri(),
    scope: requestedScope(authenticator),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(authenticator.audience ? { audience: authenticator.audience } : {}),
  });
  return `${authenticator.authorizationUrl}?${params}`;
}

/** The provider's OpenID metadata, as far as this module reads it. */
async function providerMetadata(
  authenticator: InteractiveAuthenticator,
): Promise<{ token_endpoint?: string; end_session_endpoint?: string }> {
  const metadata = await fetch(
    `${authenticator.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  if (!metadata.ok) throw new Error('Could not reach the sign-in provider');
  return (await metadata.json()) as {
    token_endpoint?: string;
    end_session_endpoint?: string;
  };
}

async function requestTokens(
  authenticator: InteractiveAuthenticator,
  grant: Record<string, string>,
): Promise<SignedInTokens> {
  const generation = tokenGeneration;
  const revision = sharedRevision();
  const { token_endpoint: tokenEndpoint } =
    await providerMetadata(authenticator);
  if (!tokenEndpoint)
    throw new Error('The sign-in provider has no token endpoint');
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: authenticator.clientId, ...grant }),
  });
  const token = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !token.access_token) {
    // The provider answered and refused: the same request would fail again.
    // Timeouts, rate limits and server errors may pass, so they keep it.
    const refused =
      token.error === 'invalid_grant' ||
      (typeof token.error === 'string' &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429);
    throw new (refused ? GrantRejectedError : Error)(
      token.error_description ?? 'Sign-in could not be completed',
    );
  }
  // A missed sign-out/sign-in broadcast must not restore the former token.
  if (revision !== sharedRevision())
    throw new Error('Sign-in changed during the token exchange');
  // Providers that rotate refresh tokens send a new one with each use.
  if (generation === tokenGeneration) {
    signedInAuthenticator = authenticator;
    try {
      sessionStorage.setItem(PROVIDER_KEY, JSON.stringify(authenticator));
    } catch {
      /* Storage may be disabled. */
    }
    const expiry =
      typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
        ? { expiresAt: Date.now() + token.expires_in * 1000 }
        : {};
    if (token.refresh_token)
      setHeld({
        authenticator,
        refreshToken: token.refresh_token,
        revision: crypto.randomUUID(),
        ...expiry,
      });
    else if (grant.grant_type === 'authorization_code') setHeld(null);
    else if (held) setHeld({ ...held, ...expiry });
  }
  return {
    accessToken: token.access_token,
    ...(typeof token.expires_in === 'number'
      ? { expiresIn: token.expires_in }
      : {}),
  };
}

function exchangeCode(
  authenticator: InteractiveAuthenticator,
  code: string,
  verifier: string,
): Promise<SignedInTokens> {
  forgetTokens();
  return requestTokens(authenticator, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
}

/** Leave for the provider's login page; the browser returns to the callback. */
export async function beginLogin(
  authenticator: InteractiveAuthenticator,
): Promise<void> {
  const pending: PendingLogin = {
    state: randomToken(),
    verifier: randomToken(),
    authenticator,
    returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  window.location.assign(
    await authorizationUrl(authenticator, pending.state, pending.verifier),
  );
}

/**
 * Finish a login the provider has just redirected back from, returning its
 * tokens, or `null` when this page load is not such a return. In a sign-in
 * popup, hand the provider's answer to the page that opened it and close.
 */
export async function completeLogin(): Promise<SignedInTokens | null> {
  const url = new URL(window.location.href);
  if (url.pathname !== CALLBACK_PATH) return null;
  const state = url.searchParams.get('state');
  if (state?.startsWith(POPUP_STATE_PREFIX) && window.opener) {
    (window.opener as Window).postMessage(
      {
        type: POPUP_MESSAGE,
        state,
        code: url.searchParams.get('code'),
        error:
          url.searchParams.get('error_description') ??
          url.searchParams.get('error'),
      },
      window.location.origin,
    );
    // The opener closes us after consuming the message. Closing here races
    // its closed-window poll and can discard a successful login.
    return null;
  }
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!state || !raw) return null;
  const pending = JSON.parse(raw) as PendingLogin;
  if (pending.state !== state) return null;
  sessionStorage.removeItem(PENDING_KEY);
  // The provider's parameters leave the address bar whatever happens next.
  window.history.replaceState(null, '', pending.returnTo);

  const error = url.searchParams.get('error');
  if (error)
    throw new Error(url.searchParams.get('error_description') ?? error);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The sign-in response carried no code');
  return exchangeCode(pending.authenticator, code, pending.verifier);
}

/**
 * Sign in again in a popup, leaving this page and its unsaved edits in
 * place. The verifier never leaves this page's memory; the popup only carries
 * the provider's code back.
 */
export async function signInWithPopup(
  authenticator: InteractiveAuthenticator,
): Promise<SignedInTokens> {
  const state = `${POPUP_STATE_PREFIX}${randomToken()}`;
  const verifier = randomToken();
  const popup = window.open(
    'about:blank',
    'huabu-sign-in',
    'popup,width=520,height=680',
  );
  if (!popup) throw new Error('The browser blocked the sign-in window');
  popup.location.href = await authorizationUrl(authenticator, state, verifier);
  const code = await new Promise<string>((resolve, reject) => {
    const closedPoll = window.setInterval(() => {
      if (!popup.closed) return;
      cleanup();
      reject(new Error('The sign-in window was closed'));
    }, 500);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        state?: string;
        code?: string | null;
        error?: string | null;
      };
      if (
        event.origin !== window.location.origin ||
        data?.type !== POPUP_MESSAGE ||
        data.state !== state
      )
        return;
      cleanup();
      popup.close?.();
      if (data.code) resolve(data.code);
      else reject(new Error(data.error ?? 'Sign-in could not be completed'));
    };
    const cleanup = () => {
      window.clearInterval(closedPoll);
      window.removeEventListener('message', onMessage);
    };
    window.addEventListener('message', onMessage);
  });
  return exchangeCode(authenticator, code, verifier);
}

/**
 * A fresh access token from the refresh token this tab holds, or that
 * another Huabu tab offers; `null` when there is none or the provider
 * refuses it.
 */
export function refreshTokens(): Promise<SignedInTokens | null> {
  if (refreshing) return refreshing;
  const generation = tokenGeneration;
  const attempt = (async () => {
    try {
      return await withRefreshLock(async () => {
        const current = await currentRefresh();
        if (!current || generation !== tokenGeneration) return null;
        try {
          const tokens = await requestTokens(current.authenticator, {
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
            scope: requestedScope(current.authenticator),
          });
          return generation === tokenGeneration
            ? { ...tokens, renewal: true as const }
            : null;
        } catch (error) {
          if (error instanceof GrantRejectedError && held === current)
            setHeld(null);
          return null;
        }
      });
    } finally {
      if (generation === tokenGeneration) refreshing = null;
    }
  })();
  refreshing = attempt;
  return attempt;
}

/**
 * Seconds until the session this tab's refresh token last renewed expires,
 * or `null` when it holds none or the provider gave no lifetime. A reload
 * schedules its next renewal from it.
 */
export function heldSessionExpiresIn(): number | null {
  if (held?.expiresAt === undefined) return null;
  return (held.expiresAt - Date.now()) / 1000;
}

/** The provider this page signed in with, retained until sign-out. */
export function heldAuthenticator(): InteractiveAuthenticator | null {
  if (signedInAuthenticator) return signedInAuthenticator;
  try {
    const raw = sessionStorage.getItem(PROVIDER_KEY);
    if (!raw) return null;
    const provider = JSON.parse(raw) as InteractiveAuthenticator;
    return typeof provider.driver === 'string' &&
      typeof provider.issuer === 'string' &&
      typeof provider.clientId === 'string'
      ? provider
      : null;
  } catch {
    return null;
  }
}

/** Forget the refresh token, as signing out must. */
export function forgetTokens({
  keepProvider = false,
}: { keepProvider?: boolean } = {}): void {
  tokenGeneration += 1;
  setHeld(null);
  post({ type: 'forget' });
  if (!keepProvider) {
    signedInAuthenticator = null;
    try {
      sessionStorage.removeItem(PROVIDER_KEY);
    } catch {
      /* Storage may be disabled. */
    }
  }
  refreshing = null;
}

/**
 * Where to send the browser to end the provider's own session, or `null`
 * when the provider advertises no logout endpoint.
 */
export async function providerSignOutUrl(
  authenticator: InteractiveAuthenticator,
): Promise<string | null> {
  const { end_session_endpoint: endpoint } = await providerMetadata(
    authenticator,
  ).catch(() => ({
    end_session_endpoint: undefined,
  }));
  if (!endpoint) return null;
  const params = new URLSearchParams({
    client_id: authenticator.clientId,
    post_logout_redirect_uri: `${window.location.origin}/`,
  });
  return `${endpoint}?${params}`;
}
