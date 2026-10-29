// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isIP } from 'node:net';

import { resolveConfiguredPublicOrigin } from './public-origin.js';
import {
  getDeploymentEnvironment,
  resolveAuthenticationMode,
} from '../../security/deployment-settings.js';
import { resolveIdentityConfig } from '../identity/config.js';

export interface DeploymentConfig {
  allowedHostsConfigured: boolean;
  basicAuthConfigured: boolean;
  authenticationDisabled?: boolean;
  bindHost: string;
  bindScope: 'loopback' | 'network';
  publicOrigin?: string;
}

export function isLoopbackHost(host: string): boolean {
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
  env: NodeJS.ProcessEnv = getDeploymentEnvironment(),
): DeploymentConfig {
  const identity = resolveIdentityConfig(env);
  const bindHost = env.HUABU_BIND_HOST ?? '127.0.0.1';
  const authenticationDisabled = resolveAuthenticationMode(env) === 'none';
  const userConfigured = Boolean(env.HUABU_BASIC_AUTH_USER);

  const publicOrigin = resolveConfiguredPublicOrigin(env);
  const allowedHostsConfigured = Boolean(
    publicOrigin || env.HUABU_ALLOWED_HOSTS?.trim(),
  );
  const bindScope = isLoopbackHost(bindHost) ? 'loopback' : 'network';
  // Bubble identity replaces Basic Auth as the network login.
  if (
    bindScope === 'network' &&
    !userConfigured &&
    !authenticationDisabled &&
    identity.provider === 'local'
  ) {
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

  // Bubble's `default` driver trusts the bearer text as the principal id. A
  // loopback listener behind a proxy is still reachable from its public
  // origin, so either one beyond loopback rules it out.
  if (
    (bindScope === 'network' ||
      (publicOrigin && !isLoopbackHost(new URL(publicOrigin).hostname))) &&
    identity.provider === 'bubble' &&
    identity.authenticators.some((entry) => entry.driver === 'default')
  ) {
    throw new Error(
      'The Bubble "default" authenticator verifies nothing and is not allowed when HUABU_BIND_HOST or HUABU_PUBLIC_ORIGIN is not loopback',
    );
  }

  return {
    allowedHostsConfigured,
    basicAuthConfigured: userConfigured,
    ...(authenticationDisabled ? { authenticationDisabled: true } : {}),
    bindHost,
    bindScope,
    ...(publicOrigin ? { publicOrigin } : {}),
  };
}
