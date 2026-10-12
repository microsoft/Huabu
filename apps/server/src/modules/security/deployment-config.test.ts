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

  it('requires allowed hosts and Basic Auth for a network bind', () => {
    expect(() =>
      resolveDeploymentConfig({ HUABU_BIND_HOST: '0.0.0.0' }),
    ).toThrow(/HUABU_ALLOWED_HOSTS/);
    expect(() =>
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_ALLOWED_HOSTS: 'huabu.example',
      }),
    ).toThrow(/HUABU_BASIC_AUTH/);
  });

  it('accepts a fully protected network bind', () => {
    expect(
      resolveDeploymentConfig({
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_ALLOWED_HOSTS: 'huabu.example',
        HUABU_BASIC_AUTH_USER: 'owner',
        HUABU_BASIC_AUTH_PASS: 'secret',
      }),
    ).toMatchObject({
      allowedHostsConfigured: true,
      basicAuthConfigured: true,
      bindScope: 'network',
    });
  });

  it('accepts a network deployment protected by Bubble instead of Basic Auth', () => {
    const bubble = {
      HUABU_BIND_HOST: '0.0.0.0',
      HUABU_IDENTITY_PROVIDER: 'bubble',
      HUABU_STRUCTURED_BACKEND: 'postgres',
      HUABU_POSTGRES_URL: 'postgres://huabu@db.example/huabu',
    };
    const allowed = { ...bubble, HUABU_ALLOWED_HOSTS: 'huabu.example' };
    expect(resolveDeploymentConfig(allowed)).toMatchObject({
      basicAuthConfigured: false,
      bindScope: 'network',
    });
    expect(() => resolveDeploymentConfig(bubble)).toThrow(
      /HUABU_ALLOWED_HOSTS/,
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
  });
});
