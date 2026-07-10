/**
 * GitHub Copilot OAuth — thin wrapper around pi-ai's OAuth implementation.
 *
 * Delegates the device code flow, token refresh, and model modification
 * to @earendil-works/pi-ai/oauth. Credentials use Electron safeStorage when
 * managed by desktop, or data/oauth-credentials.json in standalone mode.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { getModels } from '@earendil-works/pi-ai';
import {
  getOAuthApiKey,
  getOAuthProvider,
  loginGitHubCopilot,
} from '@earendil-works/pi-ai/oauth';

import { getDataDir } from '../../data-dir.js';
import {
  getDesktopSecret,
  isDesktopSecretBridgeEnabled,
  setDesktopSecret,
} from '../../security/desktop-secret-bridge.js';
import { SECRET_IDS } from '../../security/secret-ids.js';
import { getLogger } from '../../utils/logger.js';

import type { OAuthCredentials } from '@earendil-works/pi-ai';
import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai';

const log = getLogger('oauth');

// ==================== Persisted Credentials ====================

const AUTH_FILE = join(getDataDir(), 'oauth-credentials.json');

export function loadCredentials(): OAuthCredentials | null {
  try {
    if (isDesktopSecretBridgeEnabled()) {
      const raw = getDesktopSecret(SECRET_IDS.copilotOAuth);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as OAuthCredentials;
      return parsed.refresh && parsed.access ? parsed : null;
    }
    if (existsSync(AUTH_FILE)) {
      const raw = readFileSync(AUTH_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as OAuthCredentials;
      if (parsed.refresh && parsed.access) return parsed;
    }
  } catch {
    // Corrupted — fall through
  }
  return null;
}

export async function saveCredentials(creds: OAuthCredentials): Promise<void> {
  if (isDesktopSecretBridgeEnabled()) {
    await setDesktopSecret(SECRET_IDS.copilotOAuth, JSON.stringify(creds));
    return;
  }
  const dir = dirname(AUTH_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2), 'utf-8');
  try {
    chmodSync(AUTH_FILE, 0o600);
  } catch {
    // Non-critical — best effort on platforms that support it
  }
}

async function clearCredentials(): Promise<void> {
  if (isDesktopSecretBridgeEnabled()) {
    await setDesktopSecret(SECRET_IDS.copilotOAuth, null);
    return;
  }
  try {
    if (existsSync(AUTH_FILE)) {
      writeFileSync(AUTH_FILE, '{}', 'utf-8');
    }
  } catch {
    // Ignore
  }
}

// ==================== Device Code Flow ====================

interface PendingLoginSession {
  abortController: AbortController;
  userCode: string | null;
  verificationUri: string | null;
  interval: number;
  promise: Promise<OAuthCredentials>;
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
    // loginGitHubCopilot is async and will call onDeviceCode when the device code is ready
    const loginPromise = loginGitHubCopilot({
      onDeviceCode: (info) => {
        codeReceived = true;
        session.userCode = info.userCode;
        session.verificationUri = info.verificationUri;
        if (typeof info.intervalSeconds === 'number') {
          session.interval = info.intervalSeconds;
        }
        resolveCode();
      },
      onPrompt: async () => {
        // pi-ai asks for enterprise domain — return empty for github.com
        return '';
      },
      onProgress: () => {
        // Optional progress updates, ignored
      },
      signal: abortController.signal,
    });

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
 * Delegates expiry detection and token refresh to pi-ai's getOAuthApiKey.
 *
 * Errors from pi-ai (network failure, refresh-token expiry, malformed
 * persisted creds, etc.) are logged before being swallowed so the caller
 * — which only knows about "got a key / didn't" — can still surface a
 * useful diagnostic via the server logs. Returning `null` then triggers
 * the upstream "Please log in via Settings." message.
 */
export async function getCopilotApiKey(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds) {
    log.warn('No persisted GitHub Copilot credentials found.');
    return null;
  }

  try {
    const result = await getOAuthApiKey('github-copilot', {
      'github-copilot': creds,
    });
    if (!result) {
      log.warn('pi-ai getOAuthApiKey returned no result for github-copilot.');
      return null;
    }
    // Persist potentially refreshed credentials
    await saveCredentials(result.newCredentials);
    return result.apiKey;
  } catch (err) {
    log.error({ err }, 'getCopilotApiKey failed');
    return null;
  }
}

/**
 * Apply pi-ai's modifyModels to set the correct baseUrl and headers on Copilot models.
 * Uses dynamic provider lookup to support future OAuth providers without hardcoding.
 */
export function applyCopilotModelOverrides(models: Model<Api>[]): Model<Api>[] {
  const creds = loadCredentials();
  if (!creds) return models;
  const provider = getOAuthProvider('github-copilot');
  if (!provider?.modifyModels) return models;
  return provider.modifyModels(models, creds);
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
  const seed = getModels('github-copilot' as KnownProvider)[0] as
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

  const seed = getModels('github-copilot' as KnownProvider)[0] as
    | Model<Api>
    | undefined;
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
