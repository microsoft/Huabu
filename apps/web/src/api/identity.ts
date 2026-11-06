// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { API_CONFIG } from '../config/api';

import type { IdentityResponse } from '@huabu/shared';

/** One way Bubble accepts a human login, as its credential-free discovery reports it. */
export interface InteractiveAuthenticator {
  driver: string;
  issuer: string;
  authorizationUrl: string;
  clientId: string;
  scopes: string[];
  audience?: string;
}

/** The identity provider refused this account outright, such as a disabled one. */
export class IdentityDeniedError extends Error {
  constructor(
    /** Signing out also ends the provider's session, so another account can sign in. */
    readonly providerSignOut = false,
  ) {
    super('Identity access denied');
  }
}

/** The caller as the Server resolves it, or `null` when it asks for a login. */
export async function getIdentity(): Promise<IdentityResponse | null> {
  const response = await fetch(`${API_CONFIG.API_URL}/identity`);
  if (response.status === 401) return null;
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as {
      providerSignOut?: unknown;
    } | null;
    throw new IdentityDeniedError(body?.providerSignOut === true);
  }
  if (!response.ok)
    throw new Error(`Identity request failed: ${response.status}`);
  return (await response.json()) as IdentityResponse;
}

/**
 * Bubble's browser logins, or `null` when this Server does not run Bubble,
 * which is how a local deployment's login prompt is told apart from Bubble's.
 */
export async function listInteractiveAuthenticators(): Promise<
  InteractiveAuthenticator[] | null
> {
  const response = await fetch(
    `${API_CONFIG.BASE_URL}/bubble/v1/auth/authenticators`,
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Sign-in discovery failed: ${response.status}`);
  const body = (await response.json()) as {
    authenticators?: Array<
      Partial<InteractiveAuthenticator> & { interactive?: boolean }
    >;
  };
  return (body.authenticators ?? []).flatMap((entry) =>
    entry.interactive &&
    entry.driver &&
    entry.issuer &&
    entry.authorizationUrl &&
    entry.clientId
      ? [
          {
            driver: entry.driver,
            issuer: entry.issuer,
            authorizationUrl: entry.authorizationUrl,
            clientId: entry.clientId,
            scopes: entry.scopes ?? [],
            ...(entry.audience ? { audience: entry.audience } : {}),
          },
        ]
      : [],
  );
}

// Logout owns the final cookie write. Token exchanges may finish later, but
// cannot start a session once sign-out has begun.
let signingOut = false;
const adoptions = new Set<Promise<void>>();

/**
 * Every Huabu tab writes the one session cookie. Writes and sign-out's
 * deletion take turns under this Web Lock, so a renewal another tab has in
 * flight finishes before sign-out deletes the cookie, never after it.
 */
const SESSION_LOCK = 'huabu.session';
/**
 * Set, in `localStorage`, when any tab signs this browser out, and cleared
 * by the next sign-in someone completes. Holds only a timestamp. A renewal
 * that reaches the lock after a sign-out finds it and stays signed out.
 */
const SIGNED_OUT_KEY = 'huabu.session.signedOut';

function withSessionLock<T>(write: () => Promise<T>): Promise<T> {
  const locks = (
    navigator as Navigator & {
      locks?: { request: (name: string, cb: () => Promise<T>) => Promise<T> };
    }
  ).locks;
  return locks ? locks.request(SESSION_LOCK, write) : write();
}

function signedOutElsewhere(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) !== null;
  } catch {
    return false;
  }
}

function markSignedOut(signedOut: boolean): void {
  try {
    if (signedOut) localStorage.setItem(SIGNED_OUT_KEY, String(Date.now()));
    else localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* Without storage, the lock alone orders this tab's writes. */
  }
}

/**
 * Hand an access token to the Server, which keeps it in an HttpOnly cookie.
 * A `renewal` redeemed from a refresh token never restores a session that a
 * tab signed out of meanwhile; a sign-in the person completed always may.
 */
export function startSession(
  accessToken: string,
  { renewal = false }: { renewal?: boolean } = {},
): Promise<void> {
  if (signingOut) return Promise.reject(new Error('Sign-out is in progress'));
  const adoption = withSessionLock(async () => {
    if (renewal && signedOutElsewhere())
      throw new Error('Signed out in another tab');
    // Session rejection is handled by the gate; broadcasting another 401 here
    // would recursively start another renewal.
    const response = await fetch(`${API_CONFIG.API_URL}/identity/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error('Sign-in was not accepted');
    if (!renewal) markSignedOut(false);
  });
  adoptions.add(adoption);
  void adoption.then(
    () => adoptions.delete(adoption),
    () => adoptions.delete(adoption),
  );
  return adoption;
}

export async function endSession(): Promise<void> {
  await apiFetch<void>('/identity/session', { method: 'DELETE' });
}

/**
 * End the Server session and start again from the sign-in screen. Rejects,
 * staying put, when the Server did not confirm: the cookie would otherwise
 * admit the same account again on arrival.
 */
export async function signOut(
  options: { providerSignOut?: boolean } = {},
): Promise<void> {
  signingOut = true;
  const { forgetTokens, providerSignOutUrl, heldAuthenticator } =
    await import('../utils/oidcLogin');
  const signedInAuthenticator = heldAuthenticator();
  forgetTokens({ keepProvider: true });
  await Promise.allSettled([...adoptions]);
  try {
    await withSessionLock(async () => {
      markSignedOut(true);
      await endSession();
    });
  } catch (error) {
    // The session survives, so its renewals may continue.
    markSignedOut(false);
    signingOut = false;
    throw error;
  }
  forgetTokens();
  if (options.providerSignOut) {
    const authenticators = signedInAuthenticator
      ? []
      : ((await listInteractiveAuthenticators().catch(() => null)) ?? []);
    const authenticator =
      signedInAuthenticator ??
      (authenticators.length === 1 ? authenticators[0] : null);
    const url = authenticator ? await providerSignOutUrl(authenticator) : null;
    if (url) {
      window.location.assign(url);
      return;
    }
  }
  window.location.assign('/');
}
