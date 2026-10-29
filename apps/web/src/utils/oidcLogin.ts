// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { InteractiveAuthenticator } from '../api/identity';

/**
 * Browser login against whichever identity provider Bubble discovery names:
 * an OAuth authorization-code flow with PKCE, so no client secret is needed.
 * Only the access token's handover to the Server outlives the redirect; the
 * Server keeps it, and this module keeps nothing once the login completes.
 */

const PENDING_KEY = 'huabu.oidc.pending';

interface PendingLogin {
  state: string;
  verifier: string;
  authenticator: InteractiveAuthenticator;
  returnTo: string;
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

/** Leave for the provider's login page; the browser returns to the callback. */
export async function beginLogin(
  authenticator: InteractiveAuthenticator,
): Promise<void> {
  const verifier = randomToken();
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  const pending: PendingLogin = {
    state: randomToken(),
    verifier,
    authenticator,
    returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: authenticator.clientId,
    redirect_uri: redirectUri(),
    scope: [...new Set([...authenticator.scopes, 'openid', 'profile'])].join(
      ' ',
    ),
    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(authenticator.audience ? { audience: authenticator.audience } : {}),
  });
  window.location.assign(`${authenticator.authorizationUrl}?${params}`);
}

/**
 * Finish a login the provider has just redirected back from, returning its
 * access token, or `null` when this page load is not such a return.
 */
export async function completeLogin(): Promise<string | null> {
  const url = new URL(window.location.href);
  if (url.pathname !== CALLBACK_PATH) return null;
  const state = url.searchParams.get('state');
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

  const metadata = await fetch(
    `${pending.authenticator.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  );
  if (!metadata.ok) throw new Error('Could not reach the sign-in provider');
  const { token_endpoint: tokenEndpoint } = (await metadata.json()) as {
    token_endpoint?: string;
  };
  if (!tokenEndpoint)
    throw new Error('The sign-in provider has no token endpoint');

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: pending.authenticator.clientId,
      code_verifier: pending.verifier,
    }),
  });
  const token = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !token.access_token)
    throw new Error(
      token.error_description ?? 'Sign-in could not be completed',
    );
  return token.access_token;
}
