/**
 * GitHub Copilot OAuth — thin wrapper around pi-ai's OAuth implementation.
 *
 * Delegates the device code flow, token refresh, and request-auth derivation
 * to pi-ai's public GitHub Copilot provider (`provider.auth.oauth`).
 * Credentials use the runtime SecretStore.
 */

import { getModels } from '@earendil-works/pi-ai/compat';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

import { SECRET_IDS } from '../../security/secret-ids.js';
import {
  getPersistedSecret,
  getSecret,
  setSecret,
} from '../../security/secret-store.js';
import { getLogger } from '../../utils/logger.js';

import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Model,
  OAuthAuth,
  OAuthCredential,
} from '@earendil-works/pi-ai';

const log = getLogger('oauth');

/**
 * The GitHub Copilot OAuth flow, sourced from pi-ai's public provider factory.
 * `provider.auth.oauth` is a lazy wrapper that loads the real implementation on
 * first use, so building the provider here is cheap. Memoized so repeated
 * refresh/login calls reuse the same lazy loader.
 */
let cachedCopilotOAuth: OAuthAuth | undefined;
function copilotOAuth(): OAuthAuth {
  if (!cachedCopilotOAuth) {
    const oauth = githubCopilotProvider().auth.oauth;
    if (!oauth) {
      throw new Error('GitHub Copilot OAuth flow is unavailable in pi-ai.');
    }
    cachedCopilotOAuth = oauth;
  }
  return cachedCopilotOAuth;
}

/**
 * Enterprise GHE domain stored on the credential, normalized to a hostname.
 * `undefined` for the public github.com flow.
 */
function copilotEnterpriseDomain(creds: OAuthCredential): string | undefined {
  const raw = (creds as { enterpriseUrl?: unknown }).enterpriseUrl;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Derive the credential-specific Copilot API base URL from an access token's
 * `proxy-ep`. Mirrors pi-ai's internal `getBaseUrlFromToken` so the sync
 * model-override path ({@link applyCopilotModelOverrides}) does not need to
 * await the async `toAuth`. Phase C can replace this with `Models.getAuth`.
 */
function copilotBaseUrlFromToken(
  token: string,
  enterpriseDomain?: string,
): string {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (match) {
    return `https://${match[1].replace(/^proxy\./, 'api.')}`;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return 'https://api.individual.githubcopilot.com';
}

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

export async function saveCredentials(creds: OAuthCredential): Promise<void> {
  await setSecret(SECRET_IDS.copilotOAuth, JSON.stringify(creds));
}

async function clearCredentials(): Promise<void> {
  // Nothing persisted (e.g. env-only headless mode) → logout is a no-op
  // success. Otherwise a deletion failure must surface so the client is
  // never told "logged out" while a valid refresh token remains on disk.
  if (getPersistedSecret(SECRET_IDS.copilotOAuth) === null) return;
  await setSecret(SECRET_IDS.copilotOAuth, null);
}

// ==================== Device Code Flow ====================

interface PendingLoginSession {
  abortController: AbortController;
  userCode: string | null;
  verificationUri: string | null;
  interval: number;
  promise: Promise<OAuthCredential>;
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
    const loginPromise = copilotOAuth().login(interaction);

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
    // Save credentials and clean up
    await saveCredentials(result.creds);
    pendingLogin = null;
    return 'complete';
  }

  return 'pending';
}

// ==================== Credential Access ====================

/**
 * Get a valid Copilot API key, refreshing if expired.
 *
 * The new pi-ai `OAuthAuth` splits refresh (`refresh`) from request-auth
 * derivation (`toAuth`), so expiry detection lives here: an unexpired
 * credential is used as-is, otherwise its refresh token is exchanged and the
 * rotated credential persisted. The Copilot API key is the credential's
 * access token.
 *
 * Errors (network failure, refresh-token expiry, malformed persisted creds,
 * etc.) are logged before being swallowed so the caller — which only knows
 * about "got a key / didn't" — can still surface a useful diagnostic via the
 * server logs. Returning `null` then triggers the upstream "Please log in via
 * Settings." message.
 */
export async function getCopilotApiKey(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds) {
    log.warn('No persisted GitHub Copilot credentials found.');
    return null;
  }

  try {
    const fresh = await ensureFreshCredentials(creds);
    return fresh.access;
  } catch (err) {
    log.error({ err }, 'getCopilotApiKey failed');
    return null;
  }
}

/**
 * Return `creds` when its access token is still valid, otherwise exchange the
 * refresh token via pi-ai and persist the rotated credential. A 60s skew
 * guards against using a token that expires mid-request.
 */
async function ensureFreshCredentials(
  creds: OAuthCredential,
): Promise<OAuthCredential> {
  const SKEW_MS = 60_000;
  if (
    typeof creds.expires === 'number' &&
    creds.expires - SKEW_MS > Date.now()
  ) {
    return creds;
  }
  const refreshed = (await copilotOAuth().refresh(creds)) as OAuthCredential;
  await saveCredentials(refreshed);
  return refreshed;
}

/**
 * Set the credential-specific Copilot proxy `baseUrl` on each model.
 *
 * pi-ai's `OAuthAuth.toAuth` derives this baseUrl (plus the access-token api
 * key) but is async; this sync path only needs the baseUrl, which is a pure
 * function of the stored access token, so we derive it directly via
 * {@link copilotBaseUrlFromToken}. Headers are applied separately from the
 * static registry ({@link getCopilotStaticHeaders}), matching the previous
 * `modifyModels` behavior which only rewrote `baseUrl`.
 */
export function applyCopilotModelOverrides(models: Model<Api>[]): Model<Api>[] {
  const creds = loadCredentials();
  if (!creds?.access) return models;
  const baseUrl = copilotBaseUrlFromToken(
    creds.access,
    copilotEnterpriseDomain(creds),
  );
  return models.map((model) => ({ ...model, baseUrl }));
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

/** Shape of a single entry in Copilot's `GET /models` response. */
interface CopilotModelEntry {
  id?: string;
  name?: string;
  capabilities?: {
    type?: string;
    supports?: { vision?: boolean };
  };
  model_picker_enabled?: boolean;
}

/** A chat model the current account is entitled to, per Copilot's `/models`. */
export interface CopilotLiveModel {
  id: string;
  name: string;
  /** Whether the model accepts image input. */
  vision: boolean;
}

/**
 * Resolve the live Copilot API endpoint + auth headers for the current
 * account.
 *
 * pi-ai's `modifyModels` only rewrites `baseUrl` (from the token's
 * `proxy-ep`), so we seed it with a *real* static Copilot model — whose
 * registry entry already carries the required client headers
 * (`Copilot-Integration-Id`, `Editor-Version`, …) — rather than a bare
 * probe. Without those headers Copilot rejects the `/models` request.
 *
 * Returns `null` when not authenticated.
 */
async function resolveCopilotRequestContext(): Promise<{
  apiKey: string;
  baseUrl: string;
  headers: Record<string, string>;
} | null> {
  const apiKey = await getCopilotApiKey();
  if (!apiKey) return null;

  const seed = getModels('github-copilot')[0] as Model<Api> | undefined;
  if (!seed) return null;

  const [resolved] = applyCopilotModelOverrides([seed]);
  const baseUrl =
    resolved?.baseUrl ??
    seed.baseUrl ??
    'https://api.individual.githubcopilot.com';
  const headers =
    (resolved as { headers?: Record<string, string> } | undefined)?.headers ??
    {};
  return { apiKey, baseUrl, headers };
}

/**
 * Fetch the chat models the *current account* is actually entitled to, by
 * calling Copilot's `GET /models` endpoint (the same source VS Code's
 * model picker uses).
 *
 * Mirrors VS Code's picker: only chat models flagged `model_picker_enabled`
 * are returned, which both surfaces brand-new models and drops the dated
 * snapshot / internal noise the endpoint also lists.
 *
 * Returns the entitled chat models on success, or `null` when
 * unauthenticated, unreachable, or the response is unusable — letting
 * callers fall back to the static pi-ai catalog instead of showing an
 * empty list.
 */
export async function fetchEntitledCopilotModels(): Promise<
  CopilotLiveModel[] | null
> {
  const ctx = await resolveCopilotRequestContext();
  if (!ctx) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${ctx.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: {
        ...ctx.headers,
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn(
        { status: res.status },
        'Copilot /models returned non-OK HTTP status',
      );
      return null;
    }
    const json = (await res.json()) as { data?: CopilotModelEntry[] };
    const entries = Array.isArray(json.data) ? json.data : [];
    const seen = new Set<string>();
    const models: CopilotLiveModel[] = [];
    for (const entry of entries) {
      if (!entry.id) continue;
      // Match VS Code's picker: chat-capable AND explicitly picker-enabled.
      const type = entry.capabilities?.type;
      if (type && type !== 'chat') continue;
      if (entry.model_picker_enabled !== true) continue;
      // Copilot can list multiple snapshot rows per id; keep the first.
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      models.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        vision: entry.capabilities?.supports?.vision === true,
      });
    }
    return models.length > 0 ? models : null;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch Copilot /models');
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
  await clearCredentials();
}
