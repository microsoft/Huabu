/**
 * ACP bridge configuration — `enabled` flag + shared bridge token.
 *
 * Persisted at `data/acp-config.json`. The Settings UI is the *sole*
 * source of truth: no `.env` override, no env-var fallback. Fresh
 * installs default to disabled; the user flips the toggle in
 * Settings → External Agents (ACP) once, the token is auto-generated,
 * and the bundled `bin/agentlet` wrapper reads it from the JSON file.
 *
 * Security: the WS endpoint `/api/acp/agent` is mounted unconditionally;
 * the security boundary is the in-memory token store, which stays empty
 * while `enabled === false` and therefore rejects every `bridge/hello`.
 * Flipping `enabled` at runtime calls {@link applyAcpConfig} to keep
 * the token store in sync — no server restart required.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
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
 * `enabled` is forced to `false` whenever `token` is empty so the API
 * response cannot claim "enabled" while every `bridge/hello` would in
 * fact be rejected.
 */
export function loadAcpConfig(): AcpConfig {
  if (cached) return { ...cached };

  const path = configFilePath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
      const token = typeof parsed.token === 'string' ? parsed.token : '';
      const cfg: ResolvedConfig = {
        enabled: parsed.enabled === true && token !== '',
        token,
        source: 'file',
      };
      cached = cfg;
      return { ...cfg };
    } catch {
      // Malformed JSON → fall through to default. Same failure mode as
      // the file simply not existing.
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
 * Atomic write: create a sibling temp file with mode 0o600 from the
 * start (no write-then-chmod window where the file is briefly 0644),
 * then rename over the target. Failures clean up the temp file.
 */
function writeConfigFile(path: string, payload: PersistedConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Persist a new ACP config to disk and refresh the token store.
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

  writeConfigFile(configFilePath(), next);

  cached = { ...next, source: 'file' };
  applyAcpConfig(cached);
  return { ...cached };
}

/**
 * Reconcile the in-memory token store with the given config: clear all
 * tokens, then install the active one if enabled. Idempotent and
 * race-safe — concurrent callers all converge on the same final state.
 */
export function applyAcpConfig(cfg: AcpConfig): void {
  const store = getTokenStore();
  store.clear();
  if (cfg.enabled && cfg.token) {
    store.put(cfg.token, { source: `config:${cfg.source}` });
  }
}

/** Test-only: drop the in-process cache so the next read re-loads from disk. */
export function _resetAcpConfigCache(): void {
  cached = null;
}
