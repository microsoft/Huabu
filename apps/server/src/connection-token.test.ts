// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetConnectionTokenForTests,
  buildAgentletConnectionCommand,
  getConnectionToken,
  initializeConnectionToken,
} from './connection-token.js';
import {
  parseConnectionEnvFile,
  readConnectionConfig,
} from '../../../packages/client-runtime/src/daemon.js';

const mocks = vi.hoisted(() => ({
  persisted: 'managed-stored-token',
  getPersistedSecret: vi.fn(),
  setSecret: vi.fn(),
  setDaemonToken: vi.fn(),
  restart: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('./security/secret-store.js', () => ({
  getPersistedSecret: mocks.getPersistedSecret,
  setSecret: mocks.setSecret,
}));
vi.mock('./modules/agent/acp/runtime-config.js', () => ({
  getExternalAgentRuntimeConfig: () => ({ idleTimeoutSecs: 600, maxAgents: 7 }),
}));
vi.mock('@agenetes/agentlet-host', () => ({
  getDaemonAuth: () => ({ setDaemonToken: mocks.setDaemonToken }),
  getDaemonSupervisor: () => ({ restart: mocks.restart }),
  getAgentletGateway: () => ({
    getAgentlets: () => [{ disconnect: mocks.disconnect }],
  }),
}));

beforeEach(() => {
  _resetConnectionTokenForTests();
  vi.clearAllMocks();
  mocks.getPersistedSecret.mockReturnValue(mocks.persisted);
  vi.stubEnv('HUABU_CONNECTION_TOKEN', '');
  vi.stubEnv('HUABU_PUBLIC_ORIGIN', '');
});
afterEach(() => vi.unstubAllEnvs());

const request = {
  origin: 'https://huabu.example.com',
  shell: 'posix' as const,
  format: 'command' as const,
};

describe('immutable connection token', () => {
  it('prefers environment overrides without persisting or deleting them', async () => {
    vi.stubEnv('HUABU_CONNECTION_TOKEN', 'environment-token');
    await initializeConnectionToken();
    expect(getConnectionToken()).toBe('environment-token');
    expect(mocks.setDaemonToken).toHaveBeenCalledWith('environment-token');
    expect(mocks.getPersistedSecret).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.persisted).toBe('managed-stored-token');
  });
  it('persists a generated token before use and never switches during the process', async () => {
    mocks.getPersistedSecret.mockReturnValue(null);
    await initializeConnectionToken();
    const token = getConnectionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.setSecret).toHaveBeenCalledWith(
      'integration:agentlet:managed-token',
      token,
    );
    vi.stubEnv('HUABU_CONNECTION_TOKEN', 'later-change');
    await initializeConnectionToken();
    await initializeConnectionToken();
    expect(getConnectionToken()).toBe(token);
    expect(mocks.setDaemonToken).toHaveBeenLastCalledWith(token);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    _resetConnectionTokenForTests();
    vi.stubEnv('HUABU_CONNECTION_TOKEN', '  ');
    mocks.getPersistedSecret.mockReturnValue(token);
    await initializeConnectionToken();
    expect(getConnectionToken()).toBe(token);
  });
  it('does not attach or return a token after persistence fails', async () => {
    mocks.getPersistedSecret.mockReturnValue(null);
    mocks.setSecret.mockRejectedValueOnce(new Error('write failed'));
    await expect(initializeConnectionToken()).rejects.toThrow('write failed');
    expect(mocks.setDaemonToken).not.toHaveBeenCalled();
    expect(() => getConnectionToken()).toThrow('initialized and persisted');
  });
  it('keeps a captured env token when env changes, and normalizes surrounding whitespace consistently with the source daemon', async () => {
    vi.stubEnv('HUABU_CONNECTION_TOKEN', '  environment-token  ');
    expect(getConnectionToken()).toBe('environment-token');
    expect(
      readConnectionConfig({
        repoRoot: '/nonexistent-huabu-checkout',
        inherited: {
          HUABU_PUBLIC_ORIGIN: request.origin,
          HUABU_CONNECTION_TOKEN: '  environment-token  ',
        },
      }).token,
    ).toBe(getConnectionToken());
    vi.stubEnv('HUABU_CONNECTION_TOKEN', 'changed');
    await initializeConnectionToken();
    expect(getConnectionToken()).toBe('environment-token');
  });
});

describe('source-daemon copy text', () => {
  it.skipIf(process.platform === 'win32')(
    'uses invocation-scoped env without token argv, and preserves metacharacters in a real POSIX shell',
    () => {
      const token = 'quote\'"$HOME \\n `tick` # literal';
      vi.stubEnv('HUABU_CONNECTION_TOKEN', token);
      const result = buildAgentletConnectionCommand(request);
      expect(result.source).toBe('environment');
      expect(result.warnings).toEqual([]);
      expect(result.content).toContain('pnpm start:daemon --max-agents 7');
      expect(result.content).not.toContain('--token');
      const folder = mkdtempSync(join(tmpdir(), 'huabu-command-'));
      try {
        writeFileSync(
          join(folder, 'pnpm'),
          `#!${process.execPath}
console.log(JSON.stringify({origin: process.env.HUABU_PUBLIC_ORIGIN, token: process.env.HUABU_CONNECTION_TOKEN, args: process.argv.slice(2)}));
`,
          { mode: 0o700 },
        );
        const script = join(folder, 'connection.sh');
        const parentScript = join(folder, 'parent-env.js');
        writeFileSync(
          parentScript,
          'console.log(JSON.stringify({origin: process.env.HUABU_PUBLIC_ORIGIN, token: process.env.HUABU_CONNECTION_TOKEN}));\n',
        );
        writeFileSync(
          script,
          `${result.content}\n"$HUABU_NODE_EXECUTABLE" "$HUABU_PARENT_SCRIPT"\n`,
        );
        const resultText = execFileSync('sh', [script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${folder}:${process.env.PATH}`,
            HUABU_PUBLIC_ORIGIN: 'before-origin',
            HUABU_CONNECTION_TOKEN: 'before-token',
            HUABU_NODE_EXECUTABLE: process.execPath,
            HUABU_PARENT_SCRIPT: parentScript,
          },
        });
        const [child, parent] = resultText
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(child).toEqual({
          origin: request.origin,
          token,
          args: ['start:daemon', '--max-agents', '7'],
        });
        expect(parent).toEqual({
          origin: 'before-origin',
          token: 'before-token',
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
  it('quotes PowerShell literally and restores both previous process env values in finally', () => {
    vi.stubEnv('HUABU_CONNECTION_TOKEN', "token'$HOME`quoted");
    const result = buildAgentletConnectionCommand({
      ...request,
      shell: 'powershell',
    });
    expect(result.content).toContain(
      "$env:HUABU_CONNECTION_TOKEN = 'token''$HOME`quoted'",
    );
    expect(result.content).toContain('} finally {');
    expect(result.content).toContain(
      "SetEnvironmentVariable('HUABU_PUBLIC_ORIGIN', $huabuPreviousOrigin, 'Process')",
    );
    expect(result.content).toContain(
      "SetEnvironmentVariable('HUABU_CONNECTION_TOKEN', $huabuPreviousToken, 'Process')",
    );
    expect(result.content).not.toContain('--token');
  });
  it.each([
    'simple',
    "single'quote",
    'both\'"quotes # with \\n data',
    'with`backtick',
    'all\'"`quotes',
  ])(
    'round-trips private env files through the real daemon parser: %s',
    (token) => {
      vi.stubEnv('HUABU_CONNECTION_TOKEN', token);
      const result = buildAgentletConnectionCommand({
        ...request,
        format: 'env-file',
      });
      expect(parseConnectionEnvFile(result.content)).toEqual({
        HUABU_PUBLIC_ORIGIN: request.origin,
        HUABU_CONNECTION_TOKEN: token,
      });
      expect(result.content).not.toContain('--max-agents');
    },
  );
  it('rejects an unrepresentable env file explicitly without blocking the command format', () => {
    vi.stubEnv('HUABU_CONNECTION_TOKEN', 'all\'"`quotes # with comment');
    expect(() =>
      buildAgentletConnectionCommand({ ...request, format: 'env-file' }),
    ).toThrow('use Copy connection command instead');
    expect(buildAgentletConnectionCommand(request).content).toContain(
      'pnpm start:daemon',
    );
  });
  it('reports HTTP/loopback warnings and a stable managed-token source', () => {
    const result = buildAgentletConnectionCommand({
      ...request,
      origin: 'http://localhost:3001',
    });
    expect(result.warnings).toEqual(['loopback', 'insecure']);
    expect(result.source).toBe('managed');
    expect(result.content).toContain(
      "HUABU_PUBLIC_ORIGIN='http://localhost:3001'",
    );
  });
  it('uses the configured public origin rather than the local browser origin', () => {
    vi.stubEnv('HUABU_PUBLIC_ORIGIN', 'https://public.huabu.example:8443/');
    const result = buildAgentletConnectionCommand({
      ...request,
      origin: 'http://localhost:5173',
    });
    expect(result.content).toContain(
      "HUABU_PUBLIC_ORIGIN='https://public.huabu.example:8443'",
    );
    expect(result.warnings).toEqual([]);
    expect(() =>
      buildAgentletConnectionCommand({
        ...request,
        origin: 'file:///tmp/huabu',
      }),
    ).toThrow('Origin must be an HTTP(S) origin without a path');
  });
  it.each([
    'https://example.com/path',
    'file:///tmp/huabu',
    'https://user:secret@example.com',
    'https://example.com/?x=1',
  ])('rejects invalid root origins: %s', (origin) => {
    expect(() =>
      buildAgentletConnectionCommand({ ...request, origin }),
    ).toThrow('Origin must be an HTTP(S) origin without a path');
  });
});
