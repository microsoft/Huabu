/**
 * GitHub Copilot OAuth — delegates login, token refresh, and logout to
 * pi-ai's `Models` manager (see {@link getPiModels}), which owns the
 * CredentialStore and runs OAuth refresh under a per-provider lock.
 * Credentials live in the runtime SecretStore.
 */

import { getModels } from '@earendil-works/pi-ai/compat';

import { getPiModels } from './pi-models.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
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

// ==================== Persisted Credentials ====================

export function loadCredentials(): OAuthCredential | null {
  try {
    const raw = getSecret(SECRET_IDS.copilotOAuth);
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
  /** Diagnostic: wall-clock ms when the flow started. */
  startedAt: number;
}

/** In-flight login state — captures the abort controller and auth info for the frontend. */
let pendingLogin: PendingLoginSession | null = null;

/**
 * Start the GitHub Copilot device code flow via pi-ai.
 * Returns { userCode, verificationUri, interval } for the frontend to display.
 */
export async function startDeviceCodeFlow(): Promise<{
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
      // pi-ai's only prompt is the GitHub Enterprise domain — return empty
      // for the public github.com flow.
      prompt: async (_prompt: AuthPrompt) => '',
      notify: (event: AuthEvent) => {
        // Diagnostic: log the full login timeline (device_code → progress
        // "Enabling models..." → complete) so we can see where time goes.
        log.debug(
          {
            event: event.type,
            elapsedMs: Date.now() - session.startedAt,
            ...(event.type === 'progress' ? { message: event.message } : {}),
          },
          'copilot login event',
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
    const loginPromise = getPiModels().login(
      'github-copilot',
      'oauth',
      interaction,
    );

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
        () => reject(new Error('Failed to get device code from GitHub.')),
        30_000,
      ),
    ),
  ]).catch((err) => {
    log.error(
      { err },
      'copilot device-code flow failed before code was issued',
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
export async function pollDeviceCode(): Promise<
  'pending' | 'complete' | 'expired'
> {
  if (!pendingLogin) {
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
      { elapsedMs: Date.now() - pendingLogin.startedAt },
      'copilot login complete',
    );
    pendingLogin = null;
    return 'complete';
  }

  return 'pending';
}

// ==================== Credential Access ====================

/**
 * Get a valid Copilot API key, refreshing if expired.
 *
 * Delegates to pi-ai's `Models.getAuth`, which resolves the provider's
 * OAuth credential and runs a locked refresh when the access token has
 * expired, persisting the rotated credential. The Copilot API key is the
 * resolved access token.
 *
 * Errors (network failure, refresh-token expiry, malformed persisted creds,
 * etc.) are logged before being swallowed so the caller — which only knows
 * about "got a key / didn't" — can still surface a useful diagnostic via the
 * server logs. Returning `null` then triggers the upstream "Please log in via
 * Settings." message.
 */
export async function getCopilotApiKey(): Promise<string | null> {
  const startedAt = Date.now();
  try {
    const result = await getPiModels().getAuth('github-copilot');
    const elapsedMs = Date.now() - startedAt;
    const key = result?.auth.apiKey ?? null;
    if (!key) {
      log.warn({ elapsedMs }, 'No usable GitHub Copilot credentials.');
      return null;
    }
    // Diagnostic: per-call timing so a slow first-turn getAuth (lazy OAuth
    // load / token refresh) is visible next to the SSE Connection error.
    log.debug(
      { elapsedMs, source: result?.source },
      'Resolved Copilot API key',
    );
    return key;
  } catch (err) {
    log.error(
      { err, elapsedMs: Date.now() - startedAt },
      'getCopilotApiKey failed',
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
  if (provider !== 'github-copilot') return false;
  return !!loadCredentials();
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
 * Reuses {@link getCopilotApiKey}, which performs the refresh-if-expired
 * dance and persists the rotated credentials — so a successful verify
 * also leaves the on-disk creds fresh for the next caller.
 */
export async function verifyOAuthCredentials(
  provider: string,
): Promise<boolean> {
  if (provider !== 'github-copilot') return false;
  const key = await getCopilotApiKey();
  return key !== null;
}

/**
 * Clear stored OAuth credentials (logout).
 */
export async function logoutOAuth(): Promise<void> {
  if (pendingLogin) {
    pendingLogin.abortController.abort();
    pendingLogin = null;
  }
  // Nothing persisted (e.g. env-only headless / read-only store) → logout is a
  // no-op success; skip the delete a non-writable store would reject.
  if (getPersistedSecret(SECRET_IDS.copilotOAuth) === null) return;
  await getPiModels().logout('github-copilot');
}
