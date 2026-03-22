/**
 * GitHub Copilot OAuth — thin wrapper around pi-ai's OAuth implementation.
 *
 * Delegates the device code flow, token refresh, and model modification
 * to @mariozechner/pi-ai/oauth. Credentials are persisted to
 * data/oauth-credentials.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  githubCopilotOAuthProvider,
  loginGitHubCopilot,
} from '@mariozechner/pi-ai/oauth';

import type { OAuthCredentials } from '@mariozechner/pi-ai';
import type { Api, Model } from '@mariozechner/pi-ai';

// ==================== Persisted Credentials ====================

const AUTH_FILE = join(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '..',
  '..',
  '..',
  '..',
  'data',
  'oauth-credentials.json',
);

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

  // loginGitHubCopilot is async and will call onAuth when the device code is ready
  const loginPromise = new Promise<OAuthCredentials>((resolve, reject) => {
    loginGitHubCopilot({
      onAuth: (url, instructions) => {
        // instructions contains "Enter code: XXXX-XXXX"
        const codeMatch = instructions?.match(/:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
        session.userCode = codeMatch?.[1] ?? null;
        session.verificationUri = url;
      },
      onPrompt: async () => {
        // pi-ai asks for enterprise domain — return empty for github.com
        return '';
      },
      onProgress: () => {
        // Optional progress updates, ignored
      },
      signal: abortController.signal,
    })
      .then(resolve)
      .catch(reject);
  });

  session.promise = loginPromise;
  pendingLogin = session;

  // Wait for onAuth to be called (the login function will call it after getting the device code)
  // We poll briefly since onAuth is called synchronously within loginGitHubCopilot
  const maxWait = 30_000;
  const start = Date.now();
  while (!session.userCode && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 200));
    // Check if login already failed
    if (!pendingLogin || pendingLogin !== session) {
      throw new Error('OAuth flow was cancelled.');
    }
  }

  if (!session.userCode || !session.verificationUri) {
    abortController.abort();
    pendingLogin = null;
    throw new Error('Failed to get device code from GitHub.');
  }

  return {
    userCode: session.userCode,
    verificationUri: session.verificationUri,
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
 * Uses pi-ai's token refresh mechanism.
 */
export async function getCopilotApiKey(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  // Token still valid
  if (Date.now() < creds.expires) {
    return githubCopilotOAuthProvider.getApiKey(creds);
  }

  // Refresh via pi-ai
  try {
    const refreshed = await githubCopilotOAuthProvider.refreshToken(creds);
    saveCredentials(refreshed);
    return githubCopilotOAuthProvider.getApiKey(refreshed);
  } catch {
    return null;
  }
}

/**
 * Apply pi-ai's modifyModels to set the correct baseUrl and headers on Copilot models.
 */
export function applyCopilotModelOverrides(models: Model<Api>[]): Model<Api>[] {
  const creds = loadCredentials();
  if (!creds || !githubCopilotOAuthProvider.modifyModels) return models;
  return githubCopilotOAuthProvider.modifyModels(models, creds);
}

/**
 * Check if we have persisted OAuth credentials.
 */
export function hasOAuthCredentials(provider: string): boolean {
  if (provider !== 'github-copilot') return false;
  return !!loadCredentials();
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
