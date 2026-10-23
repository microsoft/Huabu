// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSetupSummary, readSetupEnvironment } from './setup.js';

describe('setup environment overrides', () => {
  it('distinguishes unconfigured fields from explicit environment ownership', () => {
    expect(readSetupEnvironment({})).toMatchObject({
      remote: undefined,
      origin: undefined,
      credentials: false,
      workspacePath: undefined,
    });
    expect(
      readSetupEnvironment({
        HUABU_BIND_HOST: '127.0.0.1',
        HUABU_ALLOWED_HOSTS: '',
      }),
    ).toMatchObject({ remote: false, allowedHosts: '' });
    expect(
      readSetupEnvironment({
        HUABU_BIND_HOST: '::',
        HUABU_PUBLIC_ORIGIN: 'https://env.example/',
        HUABU_BASIC_AUTH_USER: 'env-user',
        HUABU_BASIC_AUTH_PASS: 'existing-password',
        HUABU_WORKSPACE: join(tmpdir(), 'env-home'),
      }),
    ).toMatchObject({
      remote: true,
      origin: 'https://env.example',
      credentials: true,
      workspacePath: join(tmpdir(), 'env-home'),
    });
  });

  it.each([
    { HUABU_AUTH_MODE: '' },
    { HUABU_AUTH_MODE: 'disabled' },
    {
      HUABU_AUTH_MODE: 'none',
      HUABU_BASIC_AUTH_USER: 'user',
      HUABU_BASIC_AUTH_PASS: 'password',
    },
    { HUABU_BIND_HOST: '' },
    { HUABU_BIND_HOST: 'http://localhost' },
    { HUABU_BIND_HOST: 'localhost:3001' },
    { HUABU_PUBLIC_ORIGIN: '' },
    { HUABU_PUBLIC_ORIGIN: 'https://env.example/path' },
    { HUABU_PUBLIC_ORIGIN: 'http://0.0.0.0:3001' },
    { HUABU_BIND_HOST: '0.0.0.0', HUABU_PUBLIC_ORIGIN: 'https://localhost' },
    { HUABU_BASIC_AUTH_USER: 'only-user' },
    { HUABU_BASIC_AUTH_PASS: 'only-password' },
    { HUABU_BASIC_AUTH_USER: '', HUABU_BASIC_AUTH_PASS: '' },
    { HUABU_BASIC_AUTH_USER: ' ', HUABU_BASIC_AUTH_PASS: 'private-value' },
    {
      HUABU_BASIC_AUTH_USER: 'bad:user',
      HUABU_BASIC_AUTH_PASS: 'private-value',
    },
    { HUABU_BASIC_AUTH_USER: 'user', HUABU_BASIC_AUTH_PASS: 'private\nvalue' },
    { HUABU_WORKSPACE: '' },
    { HUABU_WORKSPACE: './relative' },
    {
      HUABU_WORKSPACE: join(tmpdir(), 'home'),
      HUABU_STRUCTURED_BACKEND: 'sqlite',
    },
    { HUABU_ALLOWED_HOSTS: 'env.example:3001' },
    { HUABU_ALLOWED_HOSTS: 'https://env.example' },
    { SERVER_PORT: 'not-a-port' },
  ])('rejects invalid overrides without a fallback: %j', (env) => {
    expect(() => readSetupEnvironment(env)).toThrow();
  });

  it('accepts hostname and IP aliases without rejecting an empty allowlist', () => {
    expect(
      readSetupEnvironment({
        HUABU_ALLOWED_HOSTS: 'env.example,192.0.2.10,[::1],',
      }).allowedHosts,
    ).toBe('env.example,192.0.2.10,[::1],');
    expect(readSetupEnvironment({ HUABU_ALLOWED_HOSTS: '' }).allowedHosts).toBe(
      '',
    );
  });
});

describe('effective setup summary', () => {
  const settings = {
    version: 1 as const,
    remoteAccess: {
      enabled: true as const,
      username: 'saved-user',
      publicOrigin: 'https://saved.example',
      workspacePath: join(tmpdir(), 'saved-home'),
    },
  };

  it('shows actual values and sources, never passwords', () => {
    const summary = buildSetupSummary(
      {
        HUABU_BIND_HOST: '127.0.0.1',
        HUABU_PUBLIC_ORIGIN: 'https://env.example',
        HUABU_WORKSPACE: join(tmpdir(), 'env-home'),
        HUABU_BASIC_AUTH_USER: 'env-user',
        HUABU_BASIC_AUTH_PASS: 'environment-private-value',
        HUABU_ALLOWED_HOSTS: 'alias.example',
        SERVER_PORT: '4000',
      },
      settings,
      'saved-private-value',
    ).join('\n');
    expect(summary).toContain('Access   Local only · environment');
    expect(summary).toContain('Bind     127.0.0.1 · environment');
    expect(summary).toContain('Port     4000 · environment');
    expect(summary).toContain('Address  https://env.example · environment');
    expect(summary).toContain(
      `Home     ${join(tmpdir(), 'env-home')} · environment`,
    );
    expect(summary).toContain('Login    env-user · environment');
    expect(summary).toContain('Password configured · environment');
    expect(summary).toContain('Aliases  alias.example · environment');
    expect(summary).not.toContain('private-value');
    expect(summary).not.toContain('saved-user');
    expect(summary).not.toContain('saved.example');
  });

  it('retains saved settings for fields not controlled by the environment', () => {
    const summary = buildSetupSummary({}, settings, 'saved-private-value').join(
      '\n',
    );
    expect(summary).toContain('Access   Remote');
    expect(summary).toContain('Address  https://saved.example');
    expect(summary).toContain('Login    saved-user');
    expect(summary).not.toContain('environment');
    expect(summary).not.toContain('saved-private-value');
  });

  it('shows disabled login without saved credentials', () => {
    const summary = buildSetupSummary(
      {},
      {
        ...settings,
        remoteAccess: { ...settings.remoteAccess, authentication: 'none' },
      },
      'saved-private-value',
    ).join('\n');
    expect(summary).toContain('Login    Disabled');
    expect(summary).not.toContain('saved-user');
    expect(summary).not.toContain('Password configured');
    expect(summary).not.toContain('saved-private-value');
  });
});
