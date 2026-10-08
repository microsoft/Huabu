// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persisted: null as string | null,
  writable: true,
  setSecret: vi.fn(),
  setDaemonToken: vi.fn(),
  restart: vi.fn(),
  disconnect: vi.fn(),
  maxAgents: 7,
}));

vi.mock('./security/secret-store.js', () => ({
  getPersistedSecret: () => mocks.persisted,
  isSecretStoreWritable: () => mocks.writable,
  setSecret: mocks.setSecret,
}));

vi.mock('./modules/agent/acp/runtime-config.js', () => ({
  getExternalAgentRuntimeConfig: () => ({
    idleTimeoutSecs: 600,
    maxAgents: mocks.maxAgents,
  }),
}));

vi.mock('@agenetes/agentlet-host', () => ({
  getDaemonAuth: () => ({ setDaemonToken: mocks.setDaemonToken }),
  getDaemonSupervisor: () => ({ restart: mocks.restart }),
  getAgentletGateway: () => ({
    getAgentlets: () => [{ disconnect: mocks.disconnect }],
  }),
}));

import {
  _resetConnectionTokenForTests,
  buildAgentletConnectionCommand,
  getConnectionToken,
  initializeConnectionToken,
  setConnectionToken,
} from './connection-token.js';

beforeEach(() => {
  _resetConnectionTokenForTests();
  mocks.persisted = null;
  mocks.writable = true;
  mocks.setSecret.mockResolvedValue(undefined);
  vi.clearAllMocks();
  delete process.env.HUABU_CONNECTION_TOKEN;
  delete process.env.HUABU_PUBLIC_ORIGIN;
});

afterEach(() => {
  delete process.env.HUABU_CONNECTION_TOKEN;
  delete process.env.HUABU_PUBLIC_ORIGIN;
});

describe('connection token resolution', () => {
  it('prefers persisted, environment, then one generated fallback', () => {
    mocks.persisted = 'stored-token';
    expect(initializeConnectionToken()).toEqual({
      source: 'stored',
      writable: true,
    });
    expect(getConnectionToken()).toBe('stored-token');

    _resetConnectionTokenForTests();
    mocks.persisted = null;
    process.env.HUABU_CONNECTION_TOKEN = 'environment-token';
    expect(initializeConnectionToken().source).toBe('environment');
    expect(getConnectionToken()).toBe('environment-token');

    _resetConnectionTokenForTests();
    delete process.env.HUABU_CONNECTION_TOKEN;
    expect(initializeConnectionToken().source).toBe('generated');
    const generated = getConnectionToken();
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    expect(getConnectionToken()).toBe(generated);
  });

  it('persists before switching auth and restarting connected agentlets', async () => {
    initializeConnectionToken();
    await setConnectionToken('new-token');

    expect(mocks.setSecret).toHaveBeenCalledWith(
      'integration:agentlet:connection-token',
      'new-token',
    );
    expect(mocks.setDaemonToken).toHaveBeenLastCalledWith('new-token');
    expect(mocks.disconnect).toHaveBeenCalledWith('connection_token_changed');
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(getConnectionToken()).toBe('new-token');
  });

  it('keeps the active token when persistence fails', async () => {
    process.env.HUABU_CONNECTION_TOKEN = 'old-token';
    initializeConnectionToken();
    mocks.setSecret.mockRejectedValueOnce(new Error('write failed'));

    await expect(setConnectionToken('new-token')).rejects.toThrow(
      'write failed',
    );
    expect(getConnectionToken()).toBe('old-token');
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it('clears to the environment fallback', async () => {
    mocks.persisted = 'stored-token';
    process.env.HUABU_CONNECTION_TOKEN = 'environment-token';
    initializeConnectionToken();

    await setConnectionToken(null);

    expect(getConnectionToken()).toBe('environment-token');
    expect(mocks.setDaemonToken).toHaveBeenLastCalledWith('environment-token');
  });
});

describe('Agentlet connection command', () => {
  it('derives secure and insecure endpoints and reports warnings', () => {
    process.env.HUABU_CONNECTION_TOKEN = "token'quoted";
    initializeConnectionToken();

    expect(buildAgentletConnectionCommand('https://huabu.example.com')).toEqual(
      {
        command:
          "agentlet daemon --server 'wss://huabu.example.com/api/acp/agent' --max-agents 7 --token 'token'\"'\"'quoted'",
        warnings: [],
      },
    );
    expect(buildAgentletConnectionCommand('http://localhost:3001')).toEqual({
      command:
        "agentlet daemon --server 'ws://localhost:3001/api/acp/agent' --max-agents 7 --token 'token'\"'\"'quoted' --allow-insecure",
      warnings: ['loopback', 'insecure'],
    });
  });

  it('rejects origins with paths or unsupported protocols', () => {
    expect(() =>
      buildAgentletConnectionCommand('https://example.com/path'),
    ).toThrow('Origin must be an HTTP(S) origin without a path');
    expect(() => buildAgentletConnectionCommand('file:///tmp/huabu')).toThrow(
      'Origin must be an HTTP(S) origin without a path',
    );
  });

  it('uses the configured public origin instead of the browser origin', () => {
    process.env.HUABU_CONNECTION_TOKEN = 'token';
    process.env.HUABU_PUBLIC_ORIGIN = 'https://public.huabu.example:8443/';
    initializeConnectionToken();

    expect(
      buildAgentletConnectionCommand('http://localhost:5173'),
    ).toMatchObject({
      command:
        "agentlet daemon --server 'wss://public.huabu.example:8443/api/acp/agent' --max-agents 7 --token 'token'",
      warnings: [],
    });
  });
});
