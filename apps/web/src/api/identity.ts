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
  constructor() {
    super('Identity access denied');
  }
}

/** The caller as the Server resolves it, or `null` when it asks for a login. */
export async function getIdentity(): Promise<IdentityResponse | null> {
  const response = await fetch(`${API_CONFIG.API_URL}/identity`);
  if (response.status === 401) return null;
  if (response.status === 403) throw new IdentityDeniedError();
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
  if (!response.ok) return null;
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

/** Hand an access token to the Server, which keeps it in an HttpOnly cookie. */
export async function startSession(accessToken: string): Promise<void> {
  await apiFetch<void>('/identity/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    fallbackMessage: 'Sign-in was not accepted',
  });
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
  await endSession();
  const { forgetTokens, providerSignOutUrl, heldAuthenticator } =
    await import('../utils/oidcLogin');
  forgetTokens();
  // The provider's own session would otherwise sign the next person straight
  // back in as this one, which matters on a shared computer.
  if (options.providerSignOut) {
    const authenticators = (await listInteractiveAuthenticators()) ?? [];
    const authenticator =
      heldAuthenticator() ??
      (authenticators.length === 1 ? authenticators[0] : null);
    const url = authenticator ? await providerSignOutUrl(authenticator) : null;
    if (url) {
      window.location.assign(url);
      return;
    }
  }
  window.location.assign('/');
}
