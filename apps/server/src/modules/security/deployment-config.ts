// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isIP } from 'node:net';

import { resolveConfiguredPublicOrigin } from './public-origin.js';

export interface DeploymentConfig {
  allowedHostsConfigured: boolean;
  basicAuthConfigured: boolean;
  bindHost: string;
  bindScope: 'loopback' | 'network';
  publicOrigin?: string;
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  const withoutTrailingDot = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  const normalized =
    withoutTrailingDot.startsWith('[') && withoutTrailingDot.endsWith(']')
      ? withoutTrailingDot.slice(1, -1)
      : withoutTrailingDot;
  if (normalized === 'localhost') return true;
  if (normalized === '::1') return true;
  if (isIP(normalized) === 4) {
    return normalized.split('.')[0] === '127';
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

  const publicOrigin = resolveConfiguredPublicOrigin(env);
  const allowedHostsConfigured = Boolean(
    publicOrigin || env.HUABU_ALLOWED_HOSTS?.trim(),
  );
  const bindScope = isLoopbackHost(bindHost) ? 'loopback' : 'network';
  if (bindScope === 'network' && !userConfigured) {
    throw new Error(
      'HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS are required when HUABU_BIND_HOST is not loopback',
    );
  }
  if (bindScope === 'network' && !publicOrigin) {
    throw new Error(
      'HUABU_PUBLIC_ORIGIN is required when HUABU_BIND_HOST is not loopback',
    );
  }
  if (
    bindScope === 'network' &&
    publicOrigin &&
    isLoopbackHost(new URL(publicOrigin).hostname)
  ) {
    throw new Error(
      'HUABU_PUBLIC_ORIGIN must be reachable beyond loopback when HUABU_BIND_HOST is not loopback',
    );
  }
  return {
    allowedHostsConfigured,
    basicAuthConfigured: userConfigured,
    bindHost,
    bindScope,
    ...(publicOrigin ? { publicOrigin } : {}),
  };
}
