// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * OAuth providers (GitHub Copilot, OpenAI Codex) — delegates login, token
 * refresh, and logout to pi-ai's `Models` manager (see {@link getPiModels}),
 * which owns the CredentialStore and runs OAuth refresh under a per-provider
 * lock. Credentials live in the runtime SecretStore.
 */

import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { getModels } from '@earendil-works/pi-ai/compat';

import {
  getPiModels,
  isOAuthProvider,
  oauthProviderIds,
  secretIdFor,
} from './pi-models.js';
import { getPersistedSecret, getSecret } from '../../security/secret-store.js';
import { getLogger } from '../../utils/logger.js';

import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  Model,
  OAuthCredential,
} from '@earendil-works/pi-ai';

const log = getLogger('oauth');

// The server is bundled into one ESM file, so pi-ai's filesystem-relative
// OAuth imports are unavailable at runtime. Register statically bundled flows.
registerBunOAuthFlows();

// ==================== Persisted Credentials ====================

export function loadCredentials(
  provider = 'github-copilot',
): OAuthCredential | null {
  try {
    const raw = getSecret(secretIdFor(provider));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OAuthCredential>;
    if (!parsed.refresh || !parsed.access) return null;
    // Persisted JSON predates the type-tagged credential shape; ensure the tag.
    return { ...parsed, type: 'oauth' } as OAuthCredential;
  } catch {
    // Corrupted — fall through
  }
  return null;
}

// ==================== Device Code Flow ====================

interface PendingLoginSession {
  abortController: AbortController;
  userCode: string | null;
  verificationUri: string | null;
  interval: number;
  promise: Promise<Credential>;
  /** OAuth provider this login is for (e.g. `github-copilot`, `openai-codex`). */
  provider: string;
  /** Diagnostic: wall-clock ms when the flow started. */
  startedAt: number;
}

/** In-flight login state — captures the abort controller and auth info for the frontend. */
let pendingLogin: PendingLoginSession | null = null;

/**
 * Start the GitHub Copilot device code flow via pi-ai.
 * Returns { userCode, verificationUri, interval } for the frontend to display.
 */
export async function startDeviceCodeFlow(
  provider = 'github-copilot',
): Promise<{
  userCode: string;
  verificationUri: string;
  interval: number;
}> {
  // Cancel any existing flow
  if (pendingLogin) {
    pendingLogin.abortController.abort();
    pendingLogin = null;
  }

  const abortController = new AbortController();
  const session: PendingLoginSession = {
    abortController,
    userCode: null,
    verificationUri: null,
    interval: 5,
    promise: null!,
    provider,
    startedAt: Date.now(),
  };

  // Promise that resolves once onDeviceCode fires with the device code,
  // or rejects if loginGitHubCopilot fails before that callback ever runs
  // (e.g. github.com is unreachable — pi-ai will throw a fetch error).
  let codeReceived = false;
  const userCodeReady = new Promise<void>((resolveCode, rejectCode) => {
    // login() is async and notifies a `device_code` event once the device
    // code is ready. It resolves with the final credential after the user
    // completes the flow (it polls internally).
    const interaction: AuthInteraction = {
      signal: abortController.signal,
      // Provider-specific prompt handling:
      //  - Codex asks (type: 'select') to choose a login method; pick the
      //    headless device-code flow that matches our userCode UI.
      //  - Copilot's only prompt is the optional GitHub Enterprise domain;
      //    empty selects the public github.com flow.
      prompt: async (prompt: AuthPrompt) =>
        prompt.type === 'select' ? 'device_code' : '',
      notify: (event: AuthEvent) => {
        // Diagnostic: log the full login timeline (device_code → progress
        // "Enabling models..." → complete) so we can see where time goes.
        log.debug(
          {
            provider,
            event: event.type,
            elapsedMs: Date.now() - session.startedAt,
            ...(event.type === 'progress' ? { message: event.message } : {}),
          },
          'oauth login event',
        );
        if (event.type !== 'device_code') return;
        codeReceived = true;
        session.userCode = event.userCode;
        session.verificationUri = event.verificationUri;
        if (typeof event.intervalSeconds === 'number') {
          session.interval = event.intervalSeconds;
        }
        resolveCode();
      },
    };
    const loginPromise = getPiModels().login(provider, 'oauth', interaction);

    session.promise = loginPromise;

    // CRUCIAL: attach a rejection handler to the login promise.
    // Without this, a fetch failure (github.com unreachable, DNS error,
    // signal abort) before `onDeviceCode` fires becomes an unhandled
    // promise rejection that crashes the server's utilityProcess — the
    // frontend then sees `ERR_EMPTY_RESPONSE` instead of a 5xx. After
    // `onDeviceCode` has fired we've already returned 200 to the
    // client, and pollDeviceCode() awaits the same `session.promise`
    // and will surface the same error to its caller, so this handler
    // intentionally only forwards the error during the pre-code phase.
    loginPromise.catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!codeReceived) rejectCode(e);
    });
  });

  pendingLogin = session;

  // Wait for onAuth callback or timeout
  await Promise.race([
    userCodeReady,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Failed to get device code from provider.')),
        30_000,
      ),
    ),
  ]).catch((err) => {
    log.error(
      { err, provider },
      'oauth device-code flow failed before code was issued',
    );
    abortController.abort();
    pendingLogin = null;
    throw err;
  });

  return {
    userCode: session.userCode!,
    verificationUri: session.verificationUri!,
    interval: session.interval,
  };
}

/**
 * Poll for the OAuth flow result.
 * pi-ai handles the actual polling internally; we just check if it's done.
 */
export async function pollDeviceCode(
  provider = 'github-copilot',
): Promise<'pending' | 'complete' | 'expired'> {
  if (!pendingLogin || pendingLogin.provider !== provider) {
    throw new Error(
      'No pending OAuth session. Call startDeviceCodeFlow first.',
    );
  }

  // Check if the login promise has settled
  const result = await Promise.race([
    pendingLogin.promise.then((creds) => ({
      status: 'complete' as const,
      creds,
    })),
    new Promise<{ status: 'pending' }>((resolve) =>
      setTimeout(() => resolve({ status: 'pending' }), 500),
    ),
  ]);

  if (result.status === 'complete') {
    // The credential was already persisted by Models.login via the
    // CredentialStore; just clean up the pending session.
    log.debug(
      { provider, elapsedMs: Date.now() - pendingLogin.startedAt },
      'oauth login complete',
    );
    pendingLogin = null;
    return 'complete';
  }

  return 'pending';
}

// ==================== Credential Access ====================

/**
 * Get a valid OAuth access token (used as the API key), refreshing if expired.
 *
 * Delegates to pi-ai's `Models.getAuth`, which resolves the provider's OAuth
 * credential and runs a locked refresh when the access token has expired,
 * persisting the rotated credential. The API key is the resolved access token.
 *
 * Errors (network failure, refresh-token expiry, malformed persisted creds,
 * etc.) are logged before being swallowed so the caller — which only knows
 * about "got a key / didn't" — can still surface a useful diagnostic via the
 * server logs. Returning `null` then triggers the upstream "Please log in via
 * Settings." message.
 */
export async function getOAuthApiKey(
  provider = 'github-copilot',
): Promise<string | null> {
  const startedAt = Date.now();
  try {
    const result = await getPiModels().getAuth(provider);
    const elapsedMs = Date.now() - startedAt;
    const key = result?.auth.apiKey ?? null;
    if (!key) {
      log.warn({ provider, elapsedMs }, 'No usable OAuth credentials.');
      return null;
    }
    // Diagnostic: per-call timing so a slow first-turn getAuth (lazy OAuth
    // load / token refresh) is visible next to the SSE Connection error.
    log.debug(
      { provider, elapsedMs, source: result?.source },
      'Resolved OAuth API key',
    );
    return key;
  } catch (err) {
    log.error(
      { err, provider, elapsedMs: Date.now() - startedAt },
      'getOAuthApiKey failed',
    );
    return null;
  }
}

/**
 * The Copilot client headers (`Editor-Version`, `Copilot-Integration-Id`, …)
 * that the gateway requires for IDE auth. These live on pi-ai's static model
 * registry entries; pi-ai's `modifyModels` only rewrites `baseUrl`, so models
 * we build manually for ids newer than the bundled registry (e.g.
 * `claude-opus-4.8`) must copy them explicitly — otherwise chat requests fail
 * with `400 missing Editor-Version header for IDE auth`.
 *
 * Returns an empty object if no static Copilot model is available.
 */
export function getCopilotStaticHeaders(): Record<string, string> {
  const seed = getModels('github-copilot')[0] as
    | (Model<Api> & { headers?: Record<string, string> })
    | undefined;
  return seed?.headers ? { ...seed.headers } : {};
}

/**
 * Check whether persisted OAuth credentials exist on disk.
 *
 * Synchronous and cheap — it does NOT verify the credentials still work.
 * Use this for fast guards (e.g. "do we have anything to log out?") where
 * the cost of a network call is unjustified. For an authoritative check
 * (one that catches revoked or unrefreshable tokens), use
 * {@link verifyOAuthCredentials}.
 */
export function hasOAuthCredentials(provider: string): boolean {
  if (!isOAuthProvider(provider)) return false;
  return !!loadCredentials(provider);
}

/**
 * Verify that persisted OAuth credentials are usable RIGHT NOW.
 *
 * Returns `true` only if either:
 *   - the access token is still valid, OR
 *   - the refresh token successfully produced a fresh access token.
 *
 * Returns `false` when no credentials are stored, or when the refresh
 * fails (revoked / expired refresh token, network error, etc.). In the
 * latter case the caller should prompt the user to re-login.
 *
 * Reuses {@link getOAuthApiKey}, which performs the refresh-if-expired
 * dance and persists the rotated credentials — so a successful verify
 * also leaves the on-disk creds fresh for the next caller.
 */
export async function verifyOAuthCredentials(
  provider: string,
): Promise<boolean> {
  if (!isOAuthProvider(provider)) return false;
  const key = await getOAuthApiKey(provider);
  return key !== null;
}

/**
 * Clear stored OAuth credentials (logout).
 */
export async function logoutOAuth(provider = 'github-copilot'): Promise<void> {
  if (pendingLogin && pendingLogin.provider === provider) {
    pendingLogin.abortController.abort();
    pendingLogin = null;
  }
  // Nothing persisted (e.g. env-only headless / read-only store) → logout is a
  // no-op success; skip the delete a non-writable store would reject.
  if (getPersistedSecret(secretIdFor(provider)) === null) return;
  await getPiModels().logout(provider);
}

/**
 * Warm up OAuth access tokens in the background for every logged-in OAuth
 * provider.
 *
 * The first `getAuth` for a provider after startup is the slow one: pi-ai
 * lazily imports the provider's OAuth module and, when the cached access token
 * has expired, runs a token refresh that also refetches the account's
 * available model ids. On a fresh (or dev-reloaded) server that cost lands on
 * the user's first `/api/llm/config` or first chat turn. Resolving it here,
 * off the request path, means that first user action is instant.
 *
 * Fire-and-forget and best-effort: only providers with stored credentials are
 * touched, and {@link getOAuthApiKey} already swallows + logs its own errors.
 */
export function prewarmOAuthCredentials(): void {
  for (const provider of oauthProviderIds()) {
    if (!hasOAuthCredentials(provider)) continue;
    void getOAuthApiKey(provider);
  }
}
