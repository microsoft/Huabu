/**
 * GitHub Copilot OAuth — thin wrapper around pi-ai's OAuth implementation.
 *
 * Delegates the device code flow, token refresh, and model modification
 * to @earendil-works/pi-ai/oauth. Credentials are persisted to
 * data/oauth-credentials.json.
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  getOAuthApiKey,
  getOAuthProvider,
  loginGitHubCopilot,
} from '@earendil-works/pi-ai/oauth';

import { getDataDir } from '../../data-dir.js';

import type { OAuthCredentials } from '@earendil-works/pi-ai';
import type { Api, Model } from '@earendil-works/pi-ai';

// ==================== Persisted Credentials ====================

const AUTH_FILE = join(getDataDir(), 'oauth-credentials.json');

export function loadCredentials(): OAuthCredentials | null {
  try {
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

export function saveCredentials(creds: OAuthCredentials): void {
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

function clearCredentials(): void {
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

  // Promise that resolves once onDeviceCode fires with the device code
  const userCodeReady = new Promise<void>((resolveCode) => {
    // loginGitHubCopilot is async and will call onDeviceCode when the device code is ready
    const loginPromise = loginGitHubCopilot({
      onDeviceCode: (info) => {
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
    saveCredentials(result.creds);
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
    console.warn('[oauth] No persisted GitHub Copilot credentials found.');
    return null;
  }

  try {
    const result = await getOAuthApiKey('github-copilot', {
      'github-copilot': creds,
    });
    if (!result) {
      console.warn(
        '[oauth] pi-ai getOAuthApiKey returned no result for github-copilot.',
      );
      return null;
    }
    // Persist potentially refreshed credentials
    saveCredentials(result.newCredentials);
    return result.apiKey;
  } catch (err) {
    console.error('[oauth] getCopilotApiKey failed:', err);
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
export function logoutOAuth(): void {
  if (pendingLogin) {
    pendingLogin.abortController.abort();
    pendingLogin = null;
  }
  clearCredentials();
}
