// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isIP } from 'node:net';

import { resolveAllowedHostnames } from './host-guard.js';
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

  const allowedHostsConfigured = Boolean(env.HUABU_ALLOWED_HOSTS?.trim());
  const bindScope = isLoopbackHost(bindHost) ? 'loopback' : 'network';
  const publicOrigin = resolveConfiguredPublicOrigin(env);
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
  if (bindScope === 'network' && publicOrigin) {
    const publicHostname = new URL(publicOrigin).hostname.toLowerCase();
    if (!resolveAllowedHostnames(env).has(publicHostname)) {
      throw new Error(
        'HUABU_PUBLIC_ORIGIN hostname must be included in HUABU_ALLOWED_HOSTS',
      );
    }
  }

  return {
    allowedHostsConfigured,
    basicAuthConfigured: userConfigured,
    bindHost,
    bindScope,
    ...(publicOrigin ? { publicOrigin } : {}),
  };
}
