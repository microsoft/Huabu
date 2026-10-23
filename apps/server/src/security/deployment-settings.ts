// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { normalizePublicOrigin } from '@huabu/client-runtime';

import { ensurePrivateConfigDir, getConfigDir } from './private-config.js';
import { parseStorageProfile } from '../modules/storage/profile.js';
import {
  atomicWriteJson,
  readJsonStrict,
  resolveDirectChildPath,
} from '../utils/fs.js';

export const deploymentUsernameSchema = z
  .string()
  .refine(
    (value) => !/[:\p{Cc}]/u.test(value),
    'Username must not contain colons or control characters.',
  )
  .trim()
  .min(1, 'Enter a login username.');

const authenticationModeSchema = z.enum(['basic', 'none']);

export function resolveAuthenticationMode(
  env: NodeJS.ProcessEnv,
): 'basic' | 'none' {
  const parsed = authenticationModeSchema.safeParse(
    env.HUABU_AUTH_MODE ?? 'basic',
  );
  if (!parsed.success)
    throw new Error('HUABU_AUTH_MODE must be basic or none.');
  if (
    parsed.data === 'none' &&
    (env.HUABU_BASIC_AUTH_USER !== undefined ||
      env.HUABU_BASIC_AUTH_PASS !== undefined)
  ) {
    throw new Error(
      'HUABU_AUTH_MODE=none conflicts with HUABU_BASIC_AUTH_USER / HUABU_BASIC_AUTH_PASS. Remove the credential overrides before disabling login.',
    );
  }
  return parsed.data;
}

const deploymentSettingsSchema = z
  .object({
    version: z.literal(1),
    remoteAccess: z.discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(false) }).strict(),
      z
        .object({
          enabled: z.literal(true),
          authentication: authenticationModeSchema.optional(),
          username: deploymentUsernameSchema.optional(),
          publicOrigin: z
            .string()
            .transform((value) => normalizePublicOrigin(value)),
          workspacePath: z
            .string()
            .min(1)
            .refine(isAbsolute, 'Home directory must be absolute')
            .optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export type DeploymentSettings = z.infer<typeof deploymentSettingsSchema>;

let activeEnvironment: NodeJS.ProcessEnv | null = null;

export function getDeploymentEnvironment(): NodeJS.ProcessEnv {
  return activeEnvironment ?? process.env;
}

export function installDeploymentEnvironment(env: NodeJS.ProcessEnv): void {
  activeEnvironment = Object.freeze({ ...env });
}

export function readDeploymentSettings(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentSettings | null {
  const path = resolveDirectChildPath(getConfigDir(env), 'deployment.json');
  const value = readJsonStrict<unknown>(path);
  if (value === null) return null;
  const parsed = deploymentSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid Huabu deployment configuration: ${path}`);
  }
  return parsed.data;
}

export function saveDeploymentSettings(
  settings: DeploymentSettings,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const parsed = deploymentSettingsSchema.parse(settings);
  atomicWriteJson(
    resolveDirectChildPath(ensurePrivateConfigDir(env), 'deployment.json'),
    parsed,
  );
}

export function resolveDeploymentEnvironment(
  env: NodeJS.ProcessEnv,
  settings: DeploymentSettings | null,
  password: string | null,
): NodeJS.ProcessEnv {
  const remote = settings?.remoteAccess;
  if (!remote?.enabled) return { ...env };
  const overridesAuth =
    env.HUABU_BASIC_AUTH_USER !== undefined ||
    env.HUABU_BASIC_AUTH_PASS !== undefined;
  const authentication = resolveAuthenticationMode({
    ...env,
    HUABU_AUTH_MODE:
      env.HUABU_AUTH_MODE ??
      (overridesAuth ? 'basic' : (remote.authentication ?? 'basic')),
  });
  if (authentication === 'basic' && !overridesAuth && !password) {
    throw new Error(
      'Remote access has no saved password. Run pnpm run setup to configure it.',
    );
  }
  const effective: NodeJS.ProcessEnv = {
    HUABU_BIND_HOST: '0.0.0.0',
    HUABU_PUBLIC_ORIGIN: remote.publicOrigin,
    ...(authentication === 'basic' && !overridesAuth
      ? {
          HUABU_BASIC_AUTH_USER: remote.username ?? 'owner',
          HUABU_BASIC_AUTH_PASS: password ?? undefined,
        }
      : {}),
    ...env,
    HUABU_AUTH_MODE: authentication,
  };
  const disk = parseStorageProfile(env).structured.kind === 'disk';
  if (disk) {
    const workspace = env.HUABU_WORKSPACE ?? remote.workspacePath;
    if (!workspace || !isAbsolute(workspace)) {
      throw new Error(
        'Remote disk access requires an absolute Home directory. Run pnpm run setup or set HUABU_WORKSPACE.',
      );
    }
    effective.HUABU_WORKSPACE = workspace;
  } else if (remote.workspacePath) {
    throw new Error(
      'The saved Home directory requires disk storage. Run pnpm run setup again for this database backend.',
    );
  }
  return effective;
}
