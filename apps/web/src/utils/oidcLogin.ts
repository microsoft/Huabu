// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { InteractiveAuthenticator } from '../api/identity';

/**
 * Browser login against whichever identity provider Bubble discovery names:
 * an OAuth authorization-code flow with PKCE, so no client secret is needed.
 * The Server keeps the access token in its session cookie. This page keeps a
 * refresh token, when the provider issues one, in memory only: it renews the
 * session in place while the page lives, and is gone with it.
 */

const PENDING_KEY = 'huabu.oidc.pending';
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
}

interface HeldRefresh {
  authenticator: InteractiveAuthenticator;
  refreshToken: string;
}

let held: HeldRefresh | null = null;

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
    // `offline_access` asks for a refresh token, so a lapsing session can be
    // renewed without leaving the page.
    scope: [
      ...new Set([
        ...authenticator.scopes,
        'openid',
        'profile',
        'offline_access',
      ]),
    ].join(' '),
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
  };
  if (!response.ok || !token.access_token)
    throw new Error(
      token.error_description ?? 'Sign-in could not be completed',
    );
  // Providers that rotate refresh tokens send a new one with each use.
  if (token.refresh_token)
    held = { authenticator, refreshToken: token.refresh_token };
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
    window.close();
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
 * A fresh access token from the refresh token this page holds, or `null`
 * when it holds none or the provider refuses it.
 */
export async function refreshTokens(): Promise<SignedInTokens | null> {
  const current = held;
  if (!current) return null;
  try {
    return await requestTokens(current.authenticator, {
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    });
  } catch {
    if (held === current) held = null;
    return null;
  }
}

/** The provider this page signed in with, while it holds a refresh token. */
export function heldAuthenticator(): InteractiveAuthenticator | null {
  return held?.authenticator ?? null;
}

/** Forget the refresh token, as signing out must. */
export function forgetTokens(): void {
  held = null;
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
