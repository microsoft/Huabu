// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isIP } from 'node:net';

export interface DeploymentConfig {
  allowedHostsConfigured: boolean;
  basicAuthConfigured: boolean;
  bindHost: string;
  bindScope: 'loopback' | 'network';
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  if (isIP(host) === 4) {
    return host.split('.')[0] === '127';
  }
  return false;
}

export function resolveDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConfig {
  const bindHost = env.HUABU_BIND_HOST ?? '127.0.0.1';
  const userConfigured = Boolean(env.HUABU_BASIC_AUTH_USER);
  const passConfigured = Boolean(env.HUABU_BASIC_AUTH_PASS);
  if (userConfigured !== passConfigured) {
    throw new Error(
      'HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS must be configured together',
    );
  }

  const allowedHostsConfigured = Boolean(env.HUABU_ALLOWED_HOSTS?.trim());
  const bindScope = isLoopbackHost(bindHost) ? 'loopback' : 'network';
  if (bindScope === 'network' && !allowedHostsConfigured) {
    throw new Error(
      'HUABU_ALLOWED_HOSTS is required when HUABU_BIND_HOST is not loopback',
    );
  }
  if (bindScope === 'network' && !userConfigured) {
    throw new Error(
      'HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS are required when HUABU_BIND_HOST is not loopback',
    );
  }

  return {
    allowedHostsConfigured,
    basicAuthConfigured: userConfigured,
    bindHost,
    bindScope,
  };
}
