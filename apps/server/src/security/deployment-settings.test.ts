// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readDeploymentSettings,
  resolveDeploymentEnvironment,
  saveDeploymentSettings,
  deploymentUsernameSchema,
} from './deployment-settings.js';
import { resolveDeploymentConfig } from '../modules/security/deployment-config.js';
import { resolveAllowedHostnames } from '../modules/security/host-guard.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const remote = {
  version: 1 as const,
  remoteAccess: {
    enabled: true as const,
    publicOrigin: 'https://huabu.example:8443',
    workspacePath: join(tmpdir(), 'huabu-test-home'),
  },
};
describe('saved deployment configuration', () => {
  it('keeps a fresh instance local and persists only non-secret choices', () => {
    const directory = mkdtempSync(join(tmpdir(), 'huabu-deployment-'));
    directories.push(directory);
    const env = { HUABU_CONFIG_DIR: directory };
    expect(readDeploymentSettings(env)).toBeNull();
    expect(
      resolveDeploymentConfig(resolveDeploymentEnvironment(env, null, null))
        .bindScope,
    ).toBe('loopback');
    saveDeploymentSettings(remote, env);
    expect(readDeploymentSettings(env)).toEqual(remote);
    expect(
      readFileSync(join(directory, 'deployment.json'), 'utf8'),
    ).not.toContain('password');
    saveDeploymentSettings(
      { version: 1, remoteAccess: { enabled: false } },
      env,
    );
    expect(
      resolveDeploymentConfig(
        resolveDeploymentEnvironment(env, readDeploymentSettings(env), null),
      ).bindScope,
    ).toBe('loopback');
  });
  it('derives network/auth settings and automatically trusts the canonical host', () => {
    const env = resolveDeploymentEnvironment({}, remote, 'private-password');
    expect(resolveDeploymentConfig(env)).toMatchObject({
      bindScope: 'network',
      basicAuthConfigured: true,
      publicOrigin: remote.remoteAccess.publicOrigin,
    });
    expect(env.HUABU_BASIC_AUTH_USER).toBe('owner');
    expect(env.HUABU_BASIC_AUTH_PASS).toBe('private-password');
    expect(env.HUABU_WORKSPACE).toBe(remote.remoteAccess.workspacePath);
    expect(resolveAllowedHostnames(env).has('huabu.example')).toBe(true);
  });
  it('persists custom usernames and retains owner for legacy configurations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'huabu-deployment-'));
    directories.push(directory);
    const env = { HUABU_CONFIG_DIR: directory };
    writeFileSync(join(directory, 'deployment.json'), JSON.stringify(remote));
    const legacy = readDeploymentSettings(env);
    expect(
      resolveDeploymentEnvironment(env, legacy, 'saved-password')
        .HUABU_BASIC_AUTH_USER,
    ).toBe('owner');
    saveDeploymentSettings(
      {
        ...remote,
        remoteAccess: { ...remote.remoteAccess, username: 'alice' },
      },
      env,
    );
    const custom = readDeploymentSettings(env);
    expect(
      resolveDeploymentEnvironment(env, custom, 'saved-password')
        .HUABU_BASIC_AUTH_USER,
    ).toBe('alice');
    expect(
      resolveDeploymentEnvironment(
        {
          ...env,
          HUABU_BASIC_AUTH_USER: 'override',
          HUABU_BASIC_AUTH_PASS: 'override-password',
        },
        custom,
        'saved-password',
      ).HUABU_BASIC_AUTH_USER,
    ).toBe('override');
  });
  it.each(['', ' ', ':', 'name:password', 'name\n', 'name\u0000'])(
    'rejects invalid saved usernames: %j',
    (username) => {
      expect(deploymentUsernameSchema.safeParse(username).success).toBe(false);
      expect(() =>
        saveDeploymentSettings(
          { ...remote, remoteAccess: { ...remote.remoteAccess, username } },
          {},
        ),
      ).toThrow();
    },
  );
  it('preserves an explicit Home override and rejects missing Home on disk but not SQL', () => {
    const home = join(tmpdir(), 'override-home');
    expect(
      resolveDeploymentEnvironment(
        { HUABU_WORKSPACE: home },
        remote,
        'saved-password',
      ).HUABU_WORKSPACE,
    ).toBe(home);
    const noHome = {
      version: 1 as const,
      remoteAccess: {
        enabled: true as const,
        publicOrigin: 'https://huabu.example',
      },
    };
    expect(() =>
      resolveDeploymentEnvironment({}, noHome, 'saved-password'),
    ).toThrow('Home directory');
    expect(
      resolveDeploymentEnvironment(
        { HUABU_STRUCTURED_BACKEND: 'sqlite' },
        noHome,
        'saved-password',
      ).HUABU_WORKSPACE,
    ).toBeUndefined();
    expect(() =>
      resolveDeploymentEnvironment(
        { HUABU_STRUCTURED_BACKEND: 'sqlite' },
        remote,
        'saved-password',
      ),
    ).toThrow('requires disk storage');
  });
  it('preserves explicit overrides and rejects incomplete auth pairs', () => {
    const env = resolveDeploymentEnvironment(
      {
        HUABU_BIND_HOST: '127.0.0.1',
        HUABU_PUBLIC_ORIGIN: 'https://override.example',
        HUABU_BASIC_AUTH_USER: 'custom',
        HUABU_BASIC_AUTH_PASS: 'custom-password',
      },
      remote,
      'saved-password',
    );
    expect(resolveDeploymentConfig(env)).toMatchObject({
      bindScope: 'loopback',
      publicOrigin: 'https://override.example',
    });
    expect(env.HUABU_BASIC_AUTH_USER).toBe('custom');
    expect(env.HUABU_BASIC_AUTH_PASS).toBe('custom-password');
    expect(() =>
      resolveDeploymentConfig(
        resolveDeploymentEnvironment(
          { HUABU_BASIC_AUTH_USER: 'custom' },
          remote,
          'saved-password',
        ),
      ),
    ).toThrow('configured together');
  });
  it.each(['', ' ', '\t', 'relative/home'])(
    'rejects an invalid explicit Home override instead of selecting the saved Home: %j',
    (workspace) => {
      expect(() =>
        resolveDeploymentEnvironment(
          { HUABU_WORKSPACE: workspace },
          remote,
          'saved-password',
        ),
      ).toThrow('absolute Home directory');
    },
  );
  it('preserves whitespace that belongs to an absolute Home path', () => {
    const workspace = `${join(tmpdir(), 'home with spaces')} `;
    expect(
      resolveDeploymentEnvironment(
        { HUABU_WORKSPACE: workspace },
        remote,
        'saved-password',
      ).HUABU_WORKSPACE,
    ).toBe(workspace);
  });
  it('fails closed when the saved password or config is missing/damaged', () => {
    expect(() => resolveDeploymentEnvironment({}, remote, null)).toThrow(
      'no saved password',
    );
    const directory = mkdtempSync(join(tmpdir(), 'huabu-deployment-'));
    directories.push(directory);
    writeFileSync(join(directory, 'deployment.json'), '{broken');
    expect(() =>
      readDeploymentSettings({ HUABU_CONFIG_DIR: directory }),
    ).toThrow();
    writeFileSync(join(directory, 'deployment.json'), '{"version":2}');
    expect(() =>
      readDeploymentSettings({ HUABU_CONFIG_DIR: directory }),
    ).toThrow('Invalid Huabu deployment');
  });

  it('requires an explicit opt-out and never injects saved credentials when login is disabled', () => {
    const settings = {
      ...remote,
      remoteAccess: {
        ...remote.remoteAccess,
        authentication: 'none' as const,
      },
    };
    const env = resolveDeploymentEnvironment({}, settings, null);
    expect(resolveDeploymentConfig(env)).toMatchObject({
      bindScope: 'network',
      authenticationDisabled: true,
      basicAuthConfigured: false,
    });
    expect(env.HUABU_BASIC_AUTH_USER).toBeUndefined();
    expect(env.HUABU_BASIC_AUTH_PASS).toBeUndefined();
    expect(
      resolveDeploymentEnvironment({}, settings, 'saved-password'),
    ).toEqual(env);
    expect(() =>
      resolveDeploymentEnvironment(
        { HUABU_AUTH_MODE: 'basic' },
        settings,
        null,
      ),
    ).toThrow('no saved password');
    const protectedEnv = resolveDeploymentEnvironment(
      {
        HUABU_BASIC_AUTH_USER: 'env-user',
        HUABU_BASIC_AUTH_PASS: 'env-password',
      },
      settings,
      null,
    );
    expect(resolveDeploymentConfig(protectedEnv).basicAuthConfigured).toBe(
      true,
    );
    expect(protectedEnv.HUABU_AUTH_MODE).toBe('basic');
    expect(
      resolveDeploymentEnvironment(
        { HUABU_AUTH_MODE: 'none' },
        remote,
        'saved-password',
      ).HUABU_BASIC_AUTH_PASS,
    ).toBeUndefined();
  });
});
