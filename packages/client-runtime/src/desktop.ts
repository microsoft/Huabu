// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { agentletConnectionCredentialsSchema } from '@huabu/shared';

import { readConnectionEnvironment } from './connection-env.js';
import { normalizePublicOrigin } from './public-origin.js';

export {
  buildDaemonChildEnv,
  buildHuabuBootstrapEnv,
  resolveRuntimeArtifacts,
} from './bootstrap.js';

export function resolveDesktopServerOrigin(
  argv: readonly string[],
  options: {
    repoRoot?: string;
    cwd?: string;
    inherited?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    externalServerUrl?: string;
  } = {},
): string | undefined {
  let envFile: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (
      argument === '--server' ||
      argument.startsWith('--server=') ||
      argument === '--server_url' ||
      argument.startsWith('--server_url=')
    ) {
      throw new Error(
        'The --server option has been removed. Set HUABU_PUBLIC_ORIGIN in the environment or use --env-file <path> instead.',
      );
    }
    if (argument === '--env-file' || argument.startsWith('--env-file=')) {
      if (envFile !== undefined)
        throw new Error('The --env-file option may be specified only once.');
      const value =
        argument === '--env-file'
          ? argv[++index]
          : argument.slice('--env-file='.length);
      if (!value?.trim() || value.startsWith('--'))
        throw new Error('--env-file requires a non-empty path');
      envFile = value;
    }
  }
  const connection = readConnectionEnvironment({
    ...options,
    envFile,
    keys: ['HUABU_PUBLIC_ORIGIN'],
  });
  const rawOrigin = connection.HUABU_PUBLIC_ORIGIN;
  if (rawOrigin === undefined) return undefined;
  const origin = normalizePublicOrigin(rawOrigin);
  if (options.externalServerUrl?.trim()) {
    throw new Error(
      'HUABU_PUBLIC_ORIGIN cannot be combined with the internal EXTERNAL_SERVER_URL development configuration. Remove the origin from the selected connection source for HMR, or use start:desktop for remote mode.',
    );
  }
  return origin;
}

export async function readDesktopDeviceInfo(
  daemonEntry: string,
): Promise<{ agentletId: string; displayName: string; version: string }> {
  const identity: { resolveDeviceIdentity(): unknown; version: unknown } =
    await import(
      pathToFileURL(join(dirname(daemonEntry), 'device-info.js')).href
    );
  const agentletId = identity.resolveDeviceIdentity();
  if (typeof agentletId !== 'string' || !agentletId.trim()) {
    throw new Error('The local runtime returned an invalid device identity.');
  }
  if (typeof identity.version !== 'string' || !identity.version.trim()) {
    throw new Error('The local runtime returned an invalid device version.');
  }
  return {
    agentletId,
    displayName: `${hostname()}: ${process.platform} ${process.arch}`,
    version: identity.version,
  };
}

export async function fetchDesktopAgentCredential(
  origin: string,
  fetchImpl: typeof fetch,
): Promise<readonly [token: string, maxAgents: number]> {
  const response = await fetchImpl(
    new URL('/api/acp/connection-credentials', origin),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: new URL(origin).origin,
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Device authorization failed (HTTP ${response.status}). Sign in to the server and try again.`,
    );
  }
  const parsed = agentletConnectionCredentialsSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error(
      'The server returned invalid device connection credentials.',
    );
  }
  return [parsed.data.token, parsed.data.maxAgents];
}
