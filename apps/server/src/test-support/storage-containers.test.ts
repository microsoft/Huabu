// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, expect, it, vi } from 'vitest';

import setup from './storage-containers.js';

import type { TestProject } from 'vitest/node';
const fake = vi.hoisted(() => {
  const postgres = {
    stop: vi.fn(),
    getConnectionUri: () => 'postgresql://test',
  };
  const azure = {
    stop: vi.fn(),
    getHost: () => 'docker-host',
    getMappedPort: () => 32100,
  };
  return {
    postgres,
    azure,
    pgStart: vi.fn(),
    azureStart: vi.fn(),
    image: vi.fn(),
  };
});
vi.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: class {
    constructor(image: string) {
      fake.image(image);
    }
    withDatabase() {
      return this;
    }
    withUsername() {
      return this;
    }
    withPassword() {
      return this;
    }
    withStartupTimeout() {
      return this;
    }
    start() {
      return fake.pgStart();
    }
  },
}));
vi.mock('testcontainers', () => ({
  GenericContainer: class {
    withEnvironment() {
      return this;
    }
    withExposedPorts() {
      return this;
    }
    withCommand() {
      return this;
    }
    withWaitStrategy() {
      return this;
    }
    withStartupTimeout() {
      return this;
    }
    start() {
      return fake.azureStart();
    }
  },
  Wait: { forLogMessage: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  fake.pgStart.mockResolvedValue(fake.postgres);
  fake.azureStart.mockResolvedValue(fake.azure);
});
const project = () => ({ provide: vi.fn() }) as unknown as TestProject;
it('provides mapped endpoints and tears down both containers exactly once', async () => {
  const p = project();
  const stop = await setup(p);
  expect(fake.image).toHaveBeenCalledWith('postgres:18');
  expect(p.provide).toHaveBeenCalledWith('postgresUrl', 'postgresql://test');
  expect(p.provide).toHaveBeenCalledWith(
    'azureConnectionString',
    expect.stringContaining('http://docker-host:32100/huabutest'),
  );
  await stop();
  await stop();
  expect(fake.postgres.stop).toHaveBeenCalledOnce();
  expect(fake.azure.stop).toHaveBeenCalledOnce();
});
it('cleans the first container when starting the second fails', async () => {
  const failure = new Error('Azurite unavailable');
  fake.azureStart.mockRejectedValue(failure);
  await expect(setup(project())).rejects.toBe(failure);
  expect(fake.postgres.stop).toHaveBeenCalledOnce();
});
it('attempts all cleanup and reports teardown errors', async () => {
  const stop = await setup(project());
  fake.azure.stop.mockRejectedValue(new Error('stop failed'));
  await expect(stop()).rejects.toThrow('Storage test container cleanup failed');
  expect(fake.postgres.stop).toHaveBeenCalledOnce();
});
it('preserves startup and cleanup errors together', async () => {
  fake.azureStart.mockRejectedValue(new Error('start failed'));
  fake.postgres.stop.mockRejectedValue(new Error('stop failed'));
  await expect(setup(project())).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'start failed' }),
      expect.objectContaining({
        message: 'Storage test container cleanup failed',
      }),
    ],
  });
});
