// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared pi-ai `Models` collection for the built-in agent.
 *
 * Wraps pi-ai's `builtinModels()` with a {@link CredentialStore} adapter over
 * the runtime {@link SecretStore}, so provider auth — API keys plus GitHub
 * Copilot OAuth — is owned by pi-ai's `Models` manager (locked OAuth refresh,
 * per-model auth resolution, provider-owned login) instead of Huabu's
 * hand-rolled logic.
 *
 * Credential storage stays byte-compatible with the pre-Models layout:
 *   - API-key providers persist the raw key string under
 *     `llm:provider:<id>:api-key` (unchanged; shared with env-secret-store).
 *   - GitHub Copilot persists its OAuth credential as JSON under
 *     `oauth:github-copilot:credentials` (unchanged).
 */

import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import {
  llmProviderApiKeySecretId,
  SECRET_IDS,
} from '../../security/secret-ids.js';
import { getSecret, setSecret } from '../../security/secret-store.js';
import { getLogger } from '../../utils/logger.js';

import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  MutableModels,
  OAuthCredential,
} from '@earendil-works/pi-ai';

const log = getLogger('pi-models');

/** Providers whose credential is stored as an OAuth JSON blob, not a raw key. */
const OAUTH_PROVIDERS = new Set(['github-copilot', 'openai-codex']);

/**
 * Whether a provider authenticates via OAuth (device-code login) rather than
 * a raw API key. OAuth providers persist a `{ access, refresh, … }` JSON blob
 * and resolve their key through `Models.getAuth` (locked refresh).
 */
export function isOAuthProvider(providerId: string): boolean {
  return OAUTH_PROVIDERS.has(providerId);
}

/** All provider ids that authenticate via OAuth (for iteration, e.g. prewarm). */
export function oauthProviderIds(): readonly string[] {
  return [...OAUTH_PROVIDERS];
}

/** SecretStore id that backs a provider's credential. */
export function secretIdFor(providerId: string): string {
  if (providerId === 'github-copilot') return SECRET_IDS.copilotOAuth;
  if (providerId === 'openai-codex') return SECRET_IDS.codexOAuth;
  return llmProviderApiKeySecretId(providerId);
}

/** Read + decode a provider credential from the SecretStore. */
function readCredential(providerId: string): Credential | undefined {
  const raw = getSecret(secretIdFor(providerId));
  if (!raw) return undefined;

  if (OAUTH_PROVIDERS.has(providerId)) {
    try {
      const parsed = JSON.parse(raw) as Partial<OAuthCredential>;
      if (!parsed.refresh || !parsed.access) return undefined;
      // Persisted JSON predates the type-tagged shape; ensure the tag.
      return { ...parsed, type: 'oauth' } as OAuthCredential;
    } catch {
      return undefined;
    }
  }

  return { type: 'api_key', key: raw };
}

/** Encode + persist (or delete) a provider credential to the SecretStore. */
async function writeCredential(
  providerId: string,
  credential: Credential | undefined,
): Promise<void> {
  const id = secretIdFor(providerId);
  if (!credential) {
    await setSecret(id, null);
    return;
  }
  if (credential.type === 'oauth') {
    await setSecret(id, JSON.stringify(credential));
    return;
  }
  // api_key: keep the raw key string so the on-disk format stays compatible
  // with env-secret-store and the /api/llm settings writers.
  await setSecret(id, credential.key ?? null);
}

/**
 * Per-provider serialized read-modify-write, so pi-ai's locked OAuth refresh
 * (`modify` runs the refresh under this lock) cannot double-refresh a rotated
 * token across concurrent requests.
 */
const providerLocks = new Map<string, Promise<unknown>>();

async function withProviderLock<T>(
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = providerLocks.get(providerId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  providerLocks.set(
    providerId,
    previous.then(() => gate),
  );
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * CredentialStore adapter over the runtime SecretStore.
 *
 * `list()` is best-effort: the SecretStore exposes no key enumeration, so we
 * report the OAuth providers whose blob is present. API-key providers are
 * resolved on demand via `read()` during `getAuth()`, which does not depend
 * on `list()`.
 */
export const credentialStore: CredentialStore = {
  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(readCredential(providerId));
  },
  list(): Promise<readonly CredentialInfo[]> {
    const infos: CredentialInfo[] = [];
    for (const providerId of OAUTH_PROVIDERS) {
      if (getSecret(secretIdFor(providerId))) {
        infos.push({ providerId, type: 'oauth' });
      }
    }
    return Promise.resolve(infos);
  },
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return withProviderLock(providerId, async () => {
      const current = readCredential(providerId);
      const next = await fn(current);
      // CredentialStore contract: `fn` returning undefined means "leave the
      // entry unchanged" — NOT delete. pi-ai's locked OAuth refresh returns
      // undefined when a concurrent request already rotated the token, so
      // writing through here would wipe the freshly-refreshed credential and
      // force a re-login. Deletion has its own path (`delete()`).
      if (next === undefined) return current;
      await writeCredential(providerId, next);
      return next;
    });
  },
  delete(providerId: string): Promise<void> {
    return withProviderLock(providerId, () =>
      writeCredential(providerId, undefined),
    );
  },
};

let cachedModels: MutableModels | undefined;

/**
 * The shared pi-ai `Models` collection, with every built-in provider
 * registered and auth backed by the SecretStore CredentialStore adapter.
 */
export function getPiModels(): MutableModels {
  if (!cachedModels) {
    const startedAt = Date.now();
    cachedModels = builtinModels({ credentials: credentialStore });
    log.debug(
      { elapsedMs: Date.now() - startedAt },
      'Initialized pi-ai Models collection',
    );
  }
  return cachedModels;
}
