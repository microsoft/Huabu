// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomBytes } from 'node:crypto';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
    azureConnectionString: string;
  }
}

/** Vitest owns one service pair; individual tests own schemas and blob containers. */
export default async function setup(project: TestProject) {
  const containers: StartedTestContainer[] = [];
  const stop = async () => {
    const results = await Promise.allSettled(
      containers
        .splice(0)
        .reverse()
        .map((c) => c.stop()),
    );
    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason);
    if (errors.length)
      throw Object.assign(new Error('Storage test container cleanup failed'), {
        errors,
      });
  };
  try {
    const postgres = await new PostgreSqlContainer('postgres:18')
      .withDatabase('huabu_test')
      .withUsername('huabutest')
      .withPassword(randomBytes(24).toString('hex'))
      .withStartupTimeout(120_000)
      .start();
    containers.push(postgres);
    const accountKey = randomBytes(32).toString('base64');
    const azure = await new GenericContainer(
      'mcr.microsoft.com/azure-storage/azurite@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5',
    )
      .withEnvironment({ AZURITE_ACCOUNTS: `huabutest:${accountKey}` })
      .withExposedPorts(10000)
      .withCommand([
        'azurite-blob',
        '--blobHost',
        '0.0.0.0',
        '--skipApiVersionCheck',
      ])
      .withWaitStrategy(
        Wait.forLogMessage('Azurite Blob service successfully listens'),
      )
      .withStartupTimeout(120_000)
      .start();
    containers.push(azure);
    project.provide('postgresUrl', postgres.getConnectionUri());
    project.provide(
      'azureConnectionString',
      `DefaultEndpointsProtocol=http;AccountName=huabutest;AccountKey=${accountKey};BlobEndpoint=http://${azure.getHost()}:${azure.getMappedPort(10000)}/huabutest;`,
    );
    return stop;
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw Object.assign(new Error('Storage test setup and cleanup failed'), {
        errors: [error, cleanupError],
      });
    }
    throw error;
  }
}
