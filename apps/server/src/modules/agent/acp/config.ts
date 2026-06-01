/**
 * ACP bridge configuration — `enabled` flag + shared bridge token.
 *
 * Persisted at `data/acp-config.json`. The Settings UI is the *sole*
 * source of truth: there is no `.env`-based override and no
 * environment-variable fallback. Fresh installs default to disabled;
 * the user flips the toggle in Settings → External Agents (ACP) once,
 * the token is auto-generated, and the bundled `bin/agentlet` wrapper
 * reads that token from the JSON file directly.
 *
 * Persistence model: read-through cache + atomic full-file write, same
 * pattern as `data/llm-config.json` (see {@link ../llm.ts}). The file is
 * `chmod 0600` on platforms that support it because it contains the
 * shared bridge secret. The cache is invalidated on every write so
 * subsequent reads in the same process always see the latest value.
 *
 * Security: the WS endpoint `/api/acp/agent` is mounted unconditionally;
 * the security boundary is the in-memory token store, which stays empty
 * while `enabled === false` and therefore rejects every `bridge/hello`.
 * Flipping `enabled` at runtime calls {@link applyAcpConfig} to keep
 * the token store in sync — no server restart required.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { getTokenStore } from './token-store.js';

import type { AcpConfig } from '@sediment/shared';

const TOKEN_BYTES = 32;

interface PersistedConfig {
  enabled: boolean;
  token: string;
}

interface ResolvedConfig extends PersistedConfig {
  source: AcpConfig['source'];
}

/** Resolve `data/acp-config.json` relative to the project root. */
function configFilePath(): string {
  return join(process.cwd(), 'data', 'acp-config.json');
}

/** Generate a 64-char hex string (32 random bytes). */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

let cached: ResolvedConfig | null = null;

/**
 * Read the persisted ACP config. On first call:
 *   1. If `data/acp-config.json` exists and is well-formed → use it
 *      (`source: 'file'`).
 *   2. Otherwise → default disabled, empty token (`source: 'default'`).
 *
 * Subsequent calls return the cached value. Callers that need a fresh
 * read after an external write should call {@link _resetAcpConfigCache}.
 */
export function loadAcpConfig(): AcpConfig {
  if (cached) return { ...cached };

  const path = configFilePath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
      // Defensive: coerce booleans/strings; ignore extra fields.
      const cfg: ResolvedConfig = {
        enabled: parsed.enabled === true,
        token: typeof parsed.token === 'string' ? parsed.token : '',
        source: 'file',
      };
      cached = cfg;
      return { ...cfg };
    } catch {
      // Malformed JSON → fall through to default. We deliberately do
      // not throw or log loudly: the file lives under the user's
      // workspace and may be hand-edited; surfacing it as "disabled"
      // matches the same failure mode as the file simply not existing.
    }
  }

  const cfg: ResolvedConfig = {
    enabled: false,
    token: '',
    source: 'default',
  };
  cached = cfg;
  return { ...cfg };
}

/**
 * Persist a new ACP config to disk and refresh the token store. Returns
 * the newly-effective config (with `source` always set to `'file'`,
 * since the write makes the file the authoritative source).
 *
 * Token rules:
 *   - Enabling for the first time → auto-generate a token if none
 *     exists in the prior config.
 *   - `regenerateToken: true` → always mint a fresh token (rotation).
 *   - Disabling → keep the token in the file so re-enabling later
 *     doesn't require users to re-paste it into `agentlet`.
 */
export function setAcpConfig(update: {
  enabled: boolean;
  regenerateToken?: boolean;
}): AcpConfig {
  const previous = loadAcpConfig();
  let token = previous.token;
  if (update.enabled) {
    if (update.regenerateToken || !token) {
      token = generateToken();
    }
  }
  const next: PersistedConfig = { enabled: update.enabled, token };

  const path = configFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf-8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort — Windows / network drives may not support it.
  }

  cached = { ...next, source: 'file' };
  applyAcpConfig(cached);
  return { ...cached };
}

/**
 * Reconcile the in-memory token store with the persisted config. Called
 * automatically on the first {@link loadAcpConfig} via the token store
 * and again after every {@link setAcpConfig}. Safe to call repeatedly.
 */
export function applyAcpConfig(cfg: AcpConfig): void {
  const store = getTokenStore();
  // Token store doesn't expose a "clear" — emulate by revoking the
  // previous token if it differs from the new one (or if disabled).
  // We hold the last-applied token in a module-level lastApplied to
  // avoid scanning the store.
  const previous = lastApplied;
  if (previous && previous !== cfg.token) {
    store.revoke(previous);
  }
  if (cfg.enabled && cfg.token) {
    store.put(cfg.token, { source: `config:${cfg.source}` });
    lastApplied = cfg.token;
  } else {
    // Disabled OR missing token → revoke whatever we last applied so
    // no agent can connect with stale credentials.
    if (previous) store.revoke(previous);
    lastApplied = null;
  }
}

let lastApplied: string | null = null;

/** Test-only: drop the in-process cache so the next read re-loads from disk. */
export function _resetAcpConfigCache(): void {
  cached = null;
  lastApplied = null;
}
