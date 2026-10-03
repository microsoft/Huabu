// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomBytes } from 'node:crypto';

import {
  getAgentletGateway,
  getDaemonAuth,
  getDaemonSupervisor,
} from '@agenetes/agentlet-host';

import { getExternalAgentRuntimeConfig } from './modules/agent/acp/runtime-config.js';
import { SECRET_IDS } from './security/secret-ids.js';
import {
  getPersistedSecret,
  isSecretStoreWritable,
  setSecret,
} from './security/secret-store.js';

import type {
  AgentletConnectionCommandResponse,
  ConnectionTokenConfig,
  ConnectionTokenSource,
} from '@huabu/shared';

/**
 * The global connection token used to authenticate the embedded
 * agentlet transport (L2 `@agenetes/agentlet-host`) and every agent
 * reachback that reuses it (e.g. the `/api/rfs/*` bearer gate).
 *
 * This is L1-owned config injected downward via `mountAgenetes()`.
 * Unlike the previous per-fork mint, it is stable for the lifetime of
 * the server process, so agent reachback credentials survive an
 * agentlet daemon restart.
 *
 * The generated fallback is available during module composition. After the
 * SecretStore initializes, {@link initializeConnectionToken} activates the
 * persisted/environment/generated precedence before the server listens.
 */
let generatedToken: string | null = null;
let activeToken: string | null = null;
let activeSource: ConnectionTokenSource | null = null;
let mutationQueue = Promise.resolve();

function getGeneratedToken(): string {
  generatedToken ??= randomBytes(32).toString('hex');
  return generatedToken;
}

function getEnvironmentToken(): string | null {
  return process.env.HUABU_CONNECTION_TOKEN?.trim() || null;
}

function resolveFallback(): {
  token: string;
  source: Exclude<ConnectionTokenSource, 'stored'>;
} {
  const environment = getEnvironmentToken();
  return environment
    ? { token: environment, source: 'environment' }
    : { token: getGeneratedToken(), source: 'generated' };
}

function activateConnectionToken(
  token: string,
  source: ConnectionTokenSource,
): void {
  activeToken = token;
  activeSource = source;
  getDaemonAuth().setDaemonToken(token);
}

export function getConnectionToken(): string {
  if (activeToken) return activeToken;
  const fallback = resolveFallback();
  activeToken = fallback.token;
  activeSource = fallback.source;
  return activeToken;
}

export function initializeConnectionToken(): ConnectionTokenConfig {
  const stored = getPersistedSecret(SECRET_IDS.agentletConnectionToken);
  if (stored) activateConnectionToken(stored, 'stored');
  else {
    const fallback = resolveFallback();
    activateConnectionToken(fallback.token, fallback.source);
  }
  return getConnectionTokenConfig();
}

export function getConnectionTokenConfig(): ConnectionTokenConfig {
  if (!activeSource) getConnectionToken();
  return {
    source: activeSource ?? 'generated',
    writable: isSecretStoreWritable(),
  };
}

function disconnectAgentlets(): void {
  const gateway = getAgentletGateway();
  for (const connection of gateway?.getAgentlets({ status: 'connected' }) ??
    []) {
    connection.disconnect('connection_token_changed');
  }
}

export function setConnectionToken(
  token: string | null,
): Promise<ConnectionTokenConfig> {
  const mutation = mutationQueue.then(async () => {
    await setSecret(SECRET_IDS.agentletConnectionToken, token);
    const next = token
      ? { token, source: 'stored' as const }
      : resolveFallback();
    const changed = next.token !== getConnectionToken();
    activateConnectionToken(next.token, next.source);
    if (changed) {
      disconnectAgentlets();
      getDaemonSupervisor().restart();
    }
    return getConnectionTokenConfig();
  });
  mutationQueue = mutation.then(
    () => undefined,
    () => undefined,
  );
  return mutation;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

export class InvalidAgentletConnectionOriginError extends Error {}

export function buildAgentletConnectionCommand(
  originValue: string,
): AgentletConnectionCommandResponse {
  const origin = new URL(originValue);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new InvalidAgentletConnectionOriginError(
      'Origin must be an HTTP(S) origin without a path',
    );
  }
  const insecure = origin.protocol === 'http:';
  const endpoint = `${insecure ? 'ws:' : 'wss:'}//${origin.host}/api/acp/agent`;
  const maxAgents = getExternalAgentRuntimeConfig().maxAgents;
  const command = [
    'agentlet daemon',
    `--server ${quotePosix(endpoint)}`,
    `--max-agents ${maxAgents}`,
    `--token ${quotePosix(getConnectionToken())}`,
    ...(insecure ? ['--allow-insecure'] : []),
  ].join(' ');
  return {
    command,
    warnings: [
      ...(isLoopbackHostname(origin.hostname) ? (['loopback'] as const) : []),
      ...(insecure ? (['insecure'] as const) : []),
    ],
  };
}

export function _resetConnectionTokenForTests(): void {
  generatedToken = null;
  activeToken = null;
  activeSource = null;
  mutationQueue = Promise.resolve();
}
