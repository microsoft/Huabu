// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { agentletConnectionCredentialsSchema } from '@huabu/shared';

export {
  buildDaemonChildEnv,
  buildHuabuBootstrapEnv,
  resolveRuntimeArtifacts,
} from './bootstrap.js';

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
