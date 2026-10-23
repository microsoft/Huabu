// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomBytes } from 'node:crypto';

import { getDaemonAuth } from '@agenetes/agentlet-host';
import { parse } from 'dotenv';

import { getExternalAgentRuntimeConfig } from './modules/agent/acp/runtime-config.js';
import {
  normalizePublicOrigin,
  resolveConfiguredPublicOrigin,
} from './modules/security/public-origin.js';
import { SECRET_IDS } from './security/secret-ids.js';
import { getPersistedSecret, setSecret } from './security/secret-store.js';

import type {
  AgentletConnectionCommandResponse,
  AgentletConnectionCommandRequest,
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
 * Environment overrides win over the automatically managed credential.
 * Historical Settings overrides remain ignored and retained.
 */
let generatedToken: string | null = null;
let activeToken: string | null = null;
let activeSource: ConnectionTokenSource | null = null;

function getGeneratedToken(): string {
  generatedToken ??= randomBytes(32).toString('hex');
  return generatedToken;
}

function getEnvironmentToken(): string | null {
  return process.env.HUABU_CONNECTION_TOKEN?.trim() || null;
}

export function getConnectionToken(): string {
  if (activeToken) return activeToken;
  const environment = getEnvironmentToken();
  const stored = environment
    ? null
    : getPersistedSecret(SECRET_IDS.managedConnectionToken);
  if (!environment && !stored) {
    throw new Error(
      'Connection token must be initialized and persisted before use',
    );
  }
  activeToken = environment ?? stored;
  activeSource = environment ? 'environment' : 'managed';
  if (!activeToken) throw new Error('Connection token is unavailable');
  return activeToken;
}

export async function initializeConnectionToken(): Promise<void> {
  if (!activeToken) {
    const environment = getEnvironmentToken();
    if (environment) {
      activeToken = environment;
      activeSource = 'environment';
    } else {
      const stored = getPersistedSecret(SECRET_IDS.managedConnectionToken);
      const token = stored ?? getGeneratedToken();
      if (!stored) await setSecret(SECRET_IDS.managedConnectionToken, token);
      activeToken = token;
      activeSource = 'managed';
    }
  }
  getDaemonAuth().setDaemonToken(getConnectionToken());
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
export class InvalidAgentletConnectionEnvFileError extends Error {}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function dotenvValue(key: string, value: string): string {
  for (const quote of ["'", '`', '"', '']) {
    if (quote && value.includes(quote)) continue;
    const line = `${key}=${quote}${value}${quote}\n`;
    if (parse(line)[key] === value) return line;
  }
  throw new InvalidAgentletConnectionEnvFileError(
    'This credential cannot be represented safely in a dotenv file; use Copy connection command instead',
  );
}

export function buildAgentletConnectionCommand(
  request: AgentletConnectionCommandRequest,
): AgentletConnectionCommandResponse {
  let normalizedOrigin: string;
  try {
    const browserOrigin = normalizePublicOrigin(request.origin);
    normalizedOrigin = resolveConfiguredPublicOrigin() ?? browserOrigin;
  } catch {
    throw new InvalidAgentletConnectionOriginError(
      'Origin must be an HTTP(S) origin without a path',
    );
  }
  const origin = new URL(normalizedOrigin);
  const insecure = origin.protocol === 'http:';
  const token = getConnectionToken();
  let content: string;
  if (request.format === 'env-file') {
    content =
      dotenvValue('HUABU_PUBLIC_ORIGIN', normalizedOrigin) +
      dotenvValue('HUABU_CONNECTION_TOKEN', token);
  } else if (request.shell === 'posix') {
    const maxAgents = getExternalAgentRuntimeConfig().maxAgents;
    content = `HUABU_PUBLIC_ORIGIN=${quotePosix(normalizedOrigin)} HUABU_CONNECTION_TOKEN=${quotePosix(token)} pnpm start:daemon --max-agents ${maxAgents}`;
  } else {
    const maxAgents = getExternalAgentRuntimeConfig().maxAgents;
    content = [
      '& {',
      "  $huabuPreviousOrigin = [Environment]::GetEnvironmentVariable('HUABU_PUBLIC_ORIGIN', 'Process')",
      "  $huabuPreviousToken = [Environment]::GetEnvironmentVariable('HUABU_CONNECTION_TOKEN', 'Process')",
      '  try {',
      `    $env:HUABU_PUBLIC_ORIGIN = ${quotePowerShell(normalizedOrigin)}`,
      `    $env:HUABU_CONNECTION_TOKEN = ${quotePowerShell(token)}`,
      `    pnpm start:daemon --max-agents ${maxAgents}`,
      '  } finally {',
      "    [Environment]::SetEnvironmentVariable('HUABU_PUBLIC_ORIGIN', $huabuPreviousOrigin, 'Process')",
      "    [Environment]::SetEnvironmentVariable('HUABU_CONNECTION_TOKEN', $huabuPreviousToken, 'Process')",
      '  }',
      '}',
    ].join('\n');
  }
  return {
    content,
    source: activeSource ?? 'generated',
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
}
