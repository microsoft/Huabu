// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initStorage: vi.fn(),
  closeStorage: vi.fn(),
  initializeConnectionToken: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./load-env.js', () => ({}));
vi.mock('./setup-proxy.js', () => ({}));
vi.mock('./bind-host.js', () => ({ resolveBindHost: () => '127.0.0.1' }));
vi.mock('./server-port.js', () => ({ resolveServerPort: () => 3001 }));
vi.mock('./connection-token.js', () => ({
  initializeConnectionToken: mocks.initializeConnectionToken,
}));
vi.mock('./modules/agent/oauth.js', () => ({
  prewarmOAuthCredentials: vi.fn(),
}));
vi.mock('./modules/security/deployment-config.js', () => ({
  resolveDeploymentConfig: () => ({ bindScope: 'loopback' }),
}));
vi.mock('./security/deployment-settings.js', () => ({
  readDeploymentSettings: () => null,
  resolveDeploymentEnvironment: () => ({}),
  installDeploymentEnvironment: vi.fn(),
}));
vi.mock('./security/secret-store.js', () => ({
  initializeSecretStore: vi.fn(),
  getPersistedSecret: vi.fn(),
}));
vi.mock('./modules/storage/index.js', () => ({
  initStorage: mocks.initStorage,
  closeStorage: mocks.closeStorage,
  describeUnavailableCapabilities: () => [],
}));
vi.mock('./app.js', () => ({
  app: { listen: mocks.listen, close: mocks.close },
}));
vi.mock('./utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }),
}));

let previousExitCode: typeof process.exitCode;
let previousSignals: Map<
  'SIGINT' | 'SIGTERM',
  ReturnType<typeof process.rawListeners>
>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  previousExitCode = process.exitCode;
  previousSignals = new Map(
    (['SIGINT', 'SIGTERM'] as const).map((signal) => [
      signal,
      process.rawListeners(signal),
    ]),
  );
  mocks.initStorage.mockResolvedValue({
    profile: { structured: { kind: 'postgres' }, blobs: { kind: 'azure' } },
  });
});

afterEach(() => {
  process.exitCode = previousExitCode;
  for (const [signal, listeners] of previousSignals) {
    for (const listener of process.rawListeners(signal)) {
      if (!listeners.includes(listener))
        process.removeListener(
          signal,
          listener as (...args: unknown[]) => void,
        );
    }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function failedBoot() {
  await import('./server.js');
  await vi.waitFor(() => {
    expect(process.exitCode).toBe(1);
    expect(mocks.closeStorage).toHaveBeenCalledOnce();
  });
}

it('closes initialized storage when startup fails before importing the app', async () => {
  mocks.initializeConnectionToken.mockRejectedValue(
    new Error('credential write failed'),
  );
  await failedBoot();
  expect(mocks.closeStorage).toHaveBeenCalledOnce();
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith(
    { err: expect.any(Error) },
    'Failed to start server',
  );
});

it('closes application workers and storage after a failed listen/onReady', async () => {
  mocks.listen.mockRejectedValue(new Error('EADDRINUSE'));
  await failedBoot();
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.closeStorage).toHaveBeenCalledOnce();
});

it('still closes storage when an application close hook fails', async () => {
  mocks.listen.mockRejectedValue(new Error('onReady failed'));
  mocks.close.mockRejectedValue(new Error('close hook failed'));
  await failedBoot();
  expect(mocks.closeStorage).toHaveBeenCalledOnce();
  expect(mocks.error).toHaveBeenCalledWith(
    { err: expect.any(Error) },
    'Failed to clean up server startup',
  );
});

it('forces a failed boot to exit if a resource never closes', async () => {
  mocks.listen.mockRejectedValue(new Error('onReady failed'));
  mocks.close.mockImplementation(() => new Promise(() => {}));
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => undefined as never);
  await import('./server.js');
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(3000);
  expect(exit).toHaveBeenCalledWith(1);
});
