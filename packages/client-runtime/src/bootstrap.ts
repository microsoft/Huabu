// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export {
  normalizePublicOrigin,
  resolveConfiguredPublicOrigin,
  InvalidPublicOriginError,
} from './public-origin.js';

export interface RuntimeArtifacts {
  daemonEntry: string | null;
  serviceSdkEntry: string | null;
  rfsEntry: string | null;
}

export function resolveServerDataDir(
  repoRoot: string,
  configuredPath?: string,
): string {
  return resolve(repoRoot, configuredPath || 'apps/server/data');
}

export function resolveRuntimeArtifacts(options: {
  repoRoot?: string;
  bundleDir?: string;
  daemonOverride?: string;
}): RuntimeArtifacts {
  const firstExisting = (paths: (string | undefined)[]): string | null =>
    paths.find((path): path is string =>
      Boolean(path && isAbsolute(path) && existsSync(path)),
    ) ?? null;
  const { repoRoot, bundleDir } = options;
  return {
    daemonEntry: firstExisting([
      options.daemonOverride,
      bundleDir && resolve(bundleDir, 'agentlet/index.js'),
      repoRoot &&
        resolve(repoRoot, 'external/agentlet/packages/local/dist/index.js'),
    ]),
    serviceSdkEntry: firstExisting([
      bundleDir && resolve(bundleDir, 'client-runtime/service-sdk.js'),
      repoRoot &&
        resolve(repoRoot, 'packages/client-runtime/dist/service-sdk.js'),
    ]),
    rfsEntry: firstExisting([
      bundleDir && resolve(bundleDir, 'client-runtime/rfs.js'),
      repoRoot && resolve(repoRoot, 'packages/client-runtime/dist/rfs.js'),
    ]),
  };
}

export function buildHuabuBootstrapEnv(
  artifacts: RuntimeArtifacts,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  if (artifacts.serviceSdkEntry)
    env.HUABU_SERVICE_SDK_URL = pathToFileURL(artifacts.serviceSdkEntry).href;
  if (artifacts.rfsEntry) env.HUABU_RFS_ENTRY = artifacts.rfsEntry;
  return Object.freeze(env);
}

export function buildDaemonChildEnv(
  inherited: NodeJS.ProcessEnv,
  token: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    const normalized = platform === 'win32' ? key.toUpperCase() : key;
    if (normalized.startsWith('HUABU_') || normalized === 'AGENTLET_TOKEN')
      continue;
    env[key] = value;
  }
  env.AGENTLET_TOKEN = token;
  return env;
}
