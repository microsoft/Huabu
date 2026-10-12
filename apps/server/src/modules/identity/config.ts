// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { parseStorageProfile } from '../storage/index.js';

/** One entry of Bubble's ordered authenticator list; Bubble validates the rest. */
export type BubbleAuthenticatorEntry = { driver: string } & Record<
  string,
  unknown
>;

export type IdentityConfig =
  | { provider: 'local'; username?: string; password?: string }
  | {
      provider: 'bubble';
      authenticators: BubbleAuthenticatorEntry[];
      /** Principal provisioned as Bubble system owner at startup. */
      owner?: string;
      postgresUrl: string;
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
    };
  }
  if (provider !== 'bubble')
    throw new Error('HUABU_IDENTITY_PROVIDER must be local or bubble');
  if (env.HUABU_BASIC_AUTH_USER || env.HUABU_BASIC_AUTH_PASS) {
    throw new Error(
      'Bubble identity cannot be combined with HUABU_BASIC_AUTH_USER or HUABU_BASIC_AUTH_PASS',
    );
  }
  // Bubble has no durable store other than Postgres.
  const postgresUrl = env.HUABU_POSTGRES_URL;
  if (parseStorageProfile(env).structured.kind !== 'postgres' || !postgresUrl) {
    throw new Error(
      'HUABU_IDENTITY_PROVIDER=bubble requires HUABU_STRUCTURED_BACKEND=postgres and HUABU_POSTGRES_URL',
    );
  }
  const owner = env.HUABU_BUBBLE_OWNER?.trim();
  return {
    provider,
    authenticators: parseBubbleAuthenticators(env.HUABU_BUBBLE_AUTH),
    ...(owner ? { owner } : {}),
    postgresUrl,
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
