/**
 * GitHub Copilot OAuth — Device Code Flow
 *
 * Implements the GitHub device-code OAuth flow to obtain a Copilot API token.
 * Tokens are persisted to data/llm-config.json alongside the provider config.
 *
 * Flow:
 *  1. POST /login/device/code → { device_code, user_code, verification_uri }
 *  2. User visits verification_uri and enters user_code
 *  3. Poll /login/oauth/access_token until access_token is returned
 *  4. Exchange GitHub token for Copilot token via internal API
 *  5. Persist both tokens; Copilot token auto-refreshes when expired
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ==================== Constants ====================

// Public client ID for GitHub Copilot (from VS Code extension / pi coding agent)
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

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

export interface OAuthCredentials {
  provider: string;
  /** GitHub OAuth access token (long-lived). */
  githubToken: string;
  /** Copilot API token (short-lived, ~30 min). */
  copilotToken: string;
  /** Copilot token expiry (unix ms). */
  copilotExpires: number;
  /** Copilot API endpoint. */
  endpoint: string;
}

function loadCredentials(): OAuthCredentials | null {
  try {
    if (existsSync(AUTH_FILE)) {
      const raw = readFileSync(AUTH_FILE, 'utf-8');
      return JSON.parse(raw) as OAuthCredentials;
    }
  } catch {
    // Corrupted — fall through
  }
  return null;
}

function saveCredentials(creds: OAuthCredentials): void {
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

/** In-flight device code session (exists only while user is authorizing). */
let pendingSession: {
  deviceCode: string;
  interval: number;
  expiresAt: number;
} | null = null;

/**
 * Step 1: Request a device code from GitHub.
 * Returns { userCode, verificationUri, interval } for the frontend to display.
 */
export async function startDeviceCodeFlow(): Promise<{
  userCode: string;
  verificationUri: string;
  interval: number;
}> {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user',
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  pendingSession = {
    deviceCode: data.device_code,
    interval: data.interval,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: data.interval,
  };
}

/**
 * Step 2: Poll GitHub for the OAuth token.
 * Returns 'pending' while waiting, 'complete' on success, 'expired' if timed out.
 */
export async function pollDeviceCode(): Promise<
  'pending' | 'complete' | 'expired'
> {
  if (!pendingSession) {
    throw new Error(
      'No pending OAuth session. Call startDeviceCodeFlow first.',
    );
  }

  if (Date.now() > pendingSession.expiresAt) {
    pendingSession = null;
    return 'expired';
  }

  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      device_code: pendingSession.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token poll failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error === 'authorization_pending') {
    return 'pending';
  }

  if (data.error === 'slow_down') {
    // GitHub wants us to slow down — increase interval
    pendingSession.interval += 5;
    return 'pending';
  }

  if (data.error === 'expired_token') {
    pendingSession = null;
    return 'expired';
  }

  if (data.error) {
    pendingSession = null;
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error('No access token in GitHub response');
  }

  // Got the GitHub token — exchange for Copilot token
  const githubToken = data.access_token;
  pendingSession = null;

  const copilot = await fetchCopilotToken(githubToken);

  saveCredentials({
    provider: 'github-copilot',
    githubToken,
    copilotToken: copilot.token,
    copilotExpires: copilot.expires,
    endpoint: copilot.endpoint,
  });

  return 'complete';
}

// ==================== Copilot Token ====================

interface CopilotTokenResult {
  token: string;
  expires: number;
  endpoint: string;
}

async function fetchCopilotToken(
  githubToken: string,
): Promise<CopilotTokenResult> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': 'Sediment/1.0',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to get Copilot token (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    token: string;
    expires_at: number;
    endpoints?: { api?: string };
  };

  return {
    token: data.token,
    expires: data.expires_at * 1000, // convert seconds to ms
    endpoint: data.endpoints?.api ?? 'https://api.githubcopilot.com',
  };
}

/**
 * Get a valid Copilot API token, refreshing if expired.
 * Returns null if no credentials are stored.
 */
export async function getCopilotApiKey(): Promise<string | null> {
  const creds = loadCredentials();
  if (!creds?.githubToken) return null;

  // Token still valid (with 60s buffer)
  if (creds.copilotToken && Date.now() < creds.copilotExpires - 60_000) {
    return creds.copilotToken;
  }

  // Refresh
  try {
    const copilot = await fetchCopilotToken(creds.githubToken);
    const updated: OAuthCredentials = {
      ...creds,
      copilotToken: copilot.token,
      copilotExpires: copilot.expires,
      endpoint: copilot.endpoint,
    };
    saveCredentials(updated);
    return updated.copilotToken;
  } catch {
    // GitHub token might be revoked
    return null;
  }
}

/**
 * Get the Copilot API endpoint URL.
 */
export function getCopilotEndpoint(): string {
  const creds = loadCredentials();
  return creds?.endpoint ?? 'https://api.githubcopilot.com';
}

/**
 * Check if we have persisted OAuth credentials.
 */
export function hasOAuthCredentials(provider: string): boolean {
  const creds = loadCredentials();
  return !!creds?.githubToken && creds.provider === provider;
}

/**
 * Clear stored OAuth credentials (logout).
 */
export function logoutOAuth(): void {
  clearCredentials();
}

/**
 * Get the polling interval for the current session.
 */
export function getPollInterval(): number {
  return pendingSession?.interval ?? 5;
}
