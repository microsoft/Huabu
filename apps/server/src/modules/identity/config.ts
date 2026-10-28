// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveAuthenticationMode } from '../../security/deployment-settings.js';

/** One entry of Bubble's ordered authenticator list; Bubble validates the rest. */
export type BubbleAuthenticatorEntry = { driver: string } & Record<
  string,
  unknown
>;

export type IdentityConfig =
  | {
      provider: 'local';
      username?: string;
      password?: string;
      /** Login explicitly disabled: every credential-free caller is the owner. */
      open?: boolean;
    }
  | {
      provider: 'bubble';
      authenticators: BubbleAuthenticatorEntry[];
      /** Principal provisioned as Bubble system owner at startup. */
      owner?: string;
      postgresUrl: string;
      /** Signing out of Huabu also ends the identity provider's session. */
      providerSignOut?: boolean;
    };

export function resolveIdentityConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const provider = env.HUABU_IDENTITY_PROVIDER ?? 'local';
  if (provider === 'local') {
    if (
      Boolean(env.HUABU_BASIC_AUTH_USER) !== Boolean(env.HUABU_BASIC_AUTH_PASS)
    ) {
      throw new Error(
        'HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS must be configured together',
      );
    }
    return {
      provider,
      username: env.HUABU_BASIC_AUTH_USER,
      password: env.HUABU_BASIC_AUTH_PASS,
      ...(resolveAuthenticationMode(env) === 'none' ? { open: true } : {}),
    };
  }
  if (provider !== 'bubble')
    throw new Error('HUABU_IDENTITY_PROVIDER must be local or bubble');
  if (env.HUABU_BASIC_AUTH_USER || env.HUABU_BASIC_AUTH_PASS) {
    throw new Error(
      'Bubble identity cannot be combined with HUABU_BASIC_AUTH_USER or HUABU_BASIC_AUTH_PASS',
    );
  }
  // Bubble has no durable store other than Postgres. It opens its own
  // connection, so Huabu's content may live in any backend.
  const postgresUrl = env.HUABU_POSTGRES_URL;
  if (!postgresUrl) {
    throw new Error(
      'HUABU_IDENTITY_PROVIDER=bubble requires HUABU_POSTGRES_URL',
    );
  }
  const authenticators = parseBubbleAuthenticators(env.HUABU_BUBBLE_AUTH);
  assertSecretsStayHostOwned(env, authenticators);
  const owner = env.HUABU_BUBBLE_OWNER?.trim();
  return {
    provider,
    authenticators,
    ...(owner ? { owner } : {}),
    postgresUrl,
    ...(env.HUABU_SIGN_OUT_PROVIDER === 'true'
      ? { providerSignOut: true }
      : {}),
  };
}

/** Only the list shape is checked; Bubble validates each driver's options. */
function parseBubbleAuthenticators(
  raw: string | undefined,
): BubbleAuthenticatorEntry[] {
  if (!raw?.trim()) return [{ driver: 'local-token' }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (entry): entry is BubbleAuthenticatorEntry =>
        typeof entry?.driver === 'string',
    )
  ) {
    throw new Error(
      'HUABU_BUBBLE_AUTH must be a non-empty JSON list of Bubble authenticators, each with a driver',
    );
  }
  return parsed;
}

/**
 * The embedded Agentlet and every agent it starts inherit the Server's
 * environment except the `HUABU_` namespace, and a master key is a system
 * owner credential. So Bubble's master key must be inline in
 * HUABU_BUBBLE_AUTH or in a `HUABU_` variable it names, never Bubble's own
 * `BUBBLE_MASTER_KEY` default.
 */
function assertSecretsStayHostOwned(
  env: NodeJS.ProcessEnv,
  authenticators: BubbleAuthenticatorEntry[],
): void {
  const leaks =
    env.BUBBLE_MASTER_KEY !== undefined ||
    authenticators.some(
      (entry) =>
        entry.driver === 'master-key' &&
        typeof entry.masterKey !== 'string' &&
        !(
          typeof entry.masterKeyEnvVar === 'string' &&
          entry.masterKeyEnvVar.startsWith('HUABU_')
        ),
    );
  if (leaks) {
    throw new Error(
      'A Bubble master key must not reach agent processes: unset BUBBLE_MASTER_KEY and give the master-key entry "masterKeyEnvVar": "HUABU_BUBBLE_MASTER_KEY" (or another HUABU_ variable)',
    );
  }
}
