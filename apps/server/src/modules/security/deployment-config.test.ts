// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { resolveDeploymentConfig } from './deployment-config.js';

describe('resolveDeploymentConfig', () => {
  it('keeps the zero-configuration loopback default', () => {
    expect(resolveDeploymentConfig({})).toEqual({
      allowedHostsConfigured: false,
      basicAuthConfigured: false,
      bindHost: '127.0.0.1',
      bindScope: 'loopback',
    });
  });

  it('requires both Basic Auth values in every deployment', () => {
    expect(() =>
      resolveDeploymentConfig({ HUABU_BASIC_AUTH_USER: 'owner' }),
    ).toThrow(/configured together/);
    expect(() =>
      resolveDeploymentConfig({ HUABU_BASIC_AUTH_PASS: 'secret' }),
    ).toThrow(/configured together/);
  });

  it('requires Basic Auth and a public origin for a network bind', () => {
    expect(() =>
      resolveDeploymentConfig({ HUABU_BIND_HOST: '0.0.0.0' }),
    ).toThrow(/HUABU_BASIC_AUTH/);
    expect(() =>
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_BASIC_AUTH_USER: 'owner',
        HUABU_BASIC_AUTH_PASS: 'secret',
      }),
    ).toThrow(/HUABU_PUBLIC_ORIGIN/);
  });

  it('accepts a fully protected network bind', () => {
    expect(
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_BASIC_AUTH_USER: 'owner',
        HUABU_BASIC_AUTH_PASS: 'secret',
        HUABU_PUBLIC_ORIGIN: 'https://huabu.example:8443/',
      }),
    ).toMatchObject({
      allowedHostsConfigured: true,
      basicAuthConfigured: true,
      bindScope: 'network',
      publicOrigin: 'https://huabu.example:8443',
    });
  });

  it('allows explicitly disabled login but still requires a reachable public origin', () => {
    expect(() =>
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_AUTH_MODE: 'none',
      }),
    ).toThrow('HUABU_PUBLIC_ORIGIN');
    expect(
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_PUBLIC_ORIGIN: 'https://huabu.example',
        HUABU_AUTH_MODE: 'none',
      }),
    ).toMatchObject({
      bindScope: 'network',
      authenticationDisabled: true,
      basicAuthConfigured: false,
    });
  });

  it('rejects invalid or conflicting authentication modes', () => {
    expect(() => resolveDeploymentConfig({ HUABU_AUTH_MODE: 'false' })).toThrow(
      'basic or none',
    );
    expect(() =>
      resolveDeploymentConfig({
        HUABU_AUTH_MODE: 'none',
        HUABU_BASIC_AUTH_USER: 'user',
        HUABU_BASIC_AUTH_PASS: 'password',
      }),
    ).toThrow('conflicts');
  });

  it.each([
    'http://127.0.0.1:3001',
    'http://[::1]:3001',
    'http://localhost.:3001',
  ])('rejects loopback public origin %s for a network bind', (publicOrigin) => {
    expect(() =>
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_ALLOWED_HOSTS: new URL(publicOrigin).hostname,
        HUABU_BASIC_AUTH_USER: 'owner',
        HUABU_BASIC_AUTH_PASS: 'secret',
        HUABU_PUBLIC_ORIGIN: publicOrigin,
      }),
    ).toThrow(/beyond loopback/);
  });

  it('accepts optional additional Host aliases', () => {
    expect(
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_ALLOWED_HOSTS: 'internal.huabu.example',
        HUABU_BASIC_AUTH_USER: 'owner',
        HUABU_BASIC_AUTH_PASS: 'secret',
        HUABU_PUBLIC_ORIGIN: 'https://public.huabu.example',
      }),
    ).toMatchObject({ allowedHostsConfigured: true });
  });

  it('accepts a network deployment protected by Bubble instead of Basic Auth', () => {
    const bubble = {
      HUABU_BIND_HOST: '0.0.0.0',
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_STRUCTURED_BACKEND: 'postgres',
      HUABU_POSTGRES_URL: 'postgres://huabu@db.example/huabu',
    };
    const allowed = { ...bubble, HUABU_PUBLIC_ORIGIN: 'https://huabu.example' };
    expect(resolveDeploymentConfig(allowed)).toMatchObject({
      basicAuthConfigured: false,
      bindScope: 'network',
    });
    expect(() => resolveDeploymentConfig(bubble)).toThrow(
      /HUABU_PUBLIC_ORIGIN/,
    );
    // Bubble's `default` driver trusts the bearer text as the principal id.
    const unverified = { HUABU_BUBBLE_AUTH: '[{"driver":"default"}]' };
    expect(() =>
      resolveDeploymentConfig({ ...allowed, ...unverified }),
    ).toThrow(/default/);
    expect(
      resolveDeploymentConfig({
        ...bubble,
        ...unverified,
        HUABU_BIND_HOST: '127.0.0.1',
      }),
    ).toMatchObject({ bindScope: 'loopback' });
    // Behind a TLS-terminating proxy a loopback listener is still public.
    expect(() =>
      resolveDeploymentConfig({
        ...bubble,
        ...unverified,
        HUABU_BIND_HOST: '127.0.0.1',
        HUABU_PUBLIC_ORIGIN: 'https://huabu.example.com',
      }),
    ).toThrow(/default/);
  });
});
