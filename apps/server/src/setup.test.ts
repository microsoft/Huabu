// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readDeploymentSettings,
  resolveDeploymentEnvironment,
} from './security/deployment-settings.js';
import { SECRET_IDS } from './security/secret-ids.js';
import { getPersistedSecret } from './security/secret-store.js';
import {
  buildSetupSummary,
  configureDeployment,
  validateSetupPassword,
} from './setup.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'huabu-setup-'));
  directories.push(directory);
  return {
    HUABU_CONFIG_DIR: join(directory, 'config'),
    HUABU_DATA_DIR: join(directory, 'data'),
  };
}
describe('setup', () => {
  it.each([1, 11, 12, 1024, 1025, 8192])(
    'accepts non-empty passwords of length %i',
    (length) => {
      expect(() => validateSetupPassword('a'.repeat(length))).not.toThrow();
    },
  );
  it.each(['', 'password-with\nnewline', 'password\u0000'])(
    'rejects unsafe password input',
    (password) => {
      expect(() => validateSetupPassword(password)).toThrow('non-empty');
    },
  );
  it('rejects incomplete or unsafe remote setup before saving anything', async () => {
    const env = fixture();
    for (const input of [
      { remote: true, origin: 'https://huabu.example' },
      { remote: true, password: 'a-long-private-password' },
      {
        remote: true,
        origin: 'http://192.168.1.50:3001',
        password: 'a-long-private-password',
      },
      {
        remote: true,
        origin: 'https://localhost:3001',
        password: 'a-long-private-password',
      },
      { remote: true, origin: 'https://huabu.example', password: '' },
      {
        remote: true,
        origin: 'https://huabu.example',
        login: false,
        password: 'unused-password',
      },
      {
        remote: true,
        origin: 'http://0.0.0.0:3001',
        password: 'a-long-private-password',
        allowHttp: true,
      },
      {
        remote: true,
        origin: 'https://huabu.example',
        password: 'a-long-private-password',
        workspacePath: './relative-home',
      },
      ...['', ' ', 'name:password', 'name\n', 'name\u0000'].map((username) => ({
        remote: true,
        origin: 'https://huabu.example',
        password: 'a-long-private-password',
        username,
      })),
    ]) {
      await expect(configureDeployment(input, env)).rejects.toThrow();
    }
    expect(existsSync(env.HUABU_CONFIG_DIR)).toBe(false);
    expect(existsSync(env.HUABU_DATA_DIR)).toBe(false);
    await expect(
      configureDeployment(
        { remote: false },
        { ...env, HUABU_BIND_HOST: '0.0.0.0' },
      ),
    ).rejects.toThrow('controls the access mode');
    await expect(
      configureDeployment(
        {
          remote: true,
          origin: 'https://huabu.example',
          password: 'private-test-password',
        },
        { ...env, HUABU_BIND_HOST: '127.0.0.1' },
      ),
    ).rejects.toThrow('controls the access mode');
  });
  it('saves remote choices separately from the encrypted password and can disable remote access', async () => {
    const env = fixture();
    const password = 'a-long-private-password';
    await configureDeployment(
      { remote: true, origin: 'https://huabu.example/', password },
      env,
    );
    const settings = readDeploymentSettings(env);
    expect(settings?.remoteAccess).toEqual({
      enabled: true,
      username: 'owner',
      publicOrigin: 'https://huabu.example',
      workspacePath: join(env.HUABU_DATA_DIR, 'workspace'),
    });
    expect(existsSync(join(env.HUABU_DATA_DIR, 'workspace'))).toBe(true);
    expect(getPersistedSecret(SECRET_IDS.remoteAccessPassword)).toBe(password);
    for (const path of [
      join(env.HUABU_CONFIG_DIR, 'deployment.json'),
      join(env.HUABU_DATA_DIR, 'encrypted-secrets.json'),
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain(password);
    }
    expect(
      resolveDeploymentEnvironment(env, settings, password)
        .HUABU_BASIC_AUTH_PASS,
    ).toBe(password);
    const ciphertext = readFileSync(
      join(env.HUABU_DATA_DIR, 'encrypted-secrets.json'),
      'utf8',
    );
    await configureDeployment(
      {
        remote: true,
        origin: 'https://updated.example',
        username: 'updated-user',
      },
      env,
    );
    expect(readDeploymentSettings(env)?.remoteAccess).toMatchObject({
      username: 'updated-user',
      publicOrigin: 'https://updated.example',
    });
    expect(getPersistedSecret(SECRET_IDS.remoteAccessPassword)).toBe(password);
    expect(
      readFileSync(join(env.HUABU_DATA_DIR, 'encrypted-secrets.json'), 'utf8'),
    ).toBe(ciphertext);
    await expect(
      configureDeployment(
        { remote: true, origin: 'https://updated.example', password: '' },
        env,
      ),
    ).rejects.toThrow('non-empty');
    expect(getPersistedSecret(SECRET_IDS.remoteAccessPassword)).toBe(password);
    await configureDeployment({ remote: false }, env);
    expect(readDeploymentSettings(env)?.remoteAccess).toEqual({
      enabled: false,
    });
    expect(existsSync(join(env.HUABU_CONFIG_DIR, '.env'))).toBe(false);
    const override = {
      ...env,
      HUABU_WORKSPACE: join(env.HUABU_DATA_DIR, 'existing-home'),
    };
    await configureDeployment(
      { remote: true, origin: 'https://huabu.example', password },
      override,
    );
    expect(readDeploymentSettings(env)?.remoteAccess).toEqual({
      enabled: true,
      username: 'owner',
      publicOrigin: 'https://huabu.example',
    });
    expect(existsSync(override.HUABU_WORKSPACE)).toBe(true);
    await expect(
      configureDeployment(
        { remote: true, origin: 'https://huabu.example', password },
        { ...override, HUABU_STRUCTURED_BACKEND: 'sqlite' },
      ),
    ).rejects.toThrow('Remove that override');
    await configureDeployment(
      { remote: true, origin: 'https://huabu.example', password },
      { ...env, HUABU_STRUCTURED_BACKEND: 'sqlite' },
    );
    expect(readDeploymentSettings(env)?.remoteAccess).toEqual({
      enabled: true,
      username: 'owner',
      publicOrigin: 'https://huabu.example',
    });
    await configureDeployment(
      {
        remote: true,
        origin: 'https://huabu.example',
        password,
        username: ' alice ',
      },
      { ...env, HUABU_STRUCTURED_BACKEND: 'sqlite' },
    );
    expect(readDeploymentSettings(env)?.remoteAccess).toMatchObject({
      username: 'alice',
    });
    await configureDeployment(
      { remote: true, origin: 'https://huabu.example', login: false },
      { ...env, HUABU_STRUCTURED_BACKEND: 'sqlite' },
    );
    const withoutLogin = readDeploymentSettings(env);
    expect(withoutLogin?.remoteAccess).toMatchObject({
      authentication: 'none',
      username: 'alice',
    });
    expect(getPersistedSecret(SECRET_IDS.remoteAccessPassword)).toBe(password);
    expect(
      resolveDeploymentEnvironment(
        { ...env, HUABU_STRUCTURED_BACKEND: 'sqlite' },
        withoutLogin,
        password,
      ),
    ).toMatchObject({ HUABU_AUTH_MODE: 'none' });
    await expect(
      configureDeployment(
        { remote: true, login: false },
        {
          ...env,
          HUABU_BASIC_AUTH_USER: 'env-user',
          HUABU_BASIC_AUTH_PASS: 'env-password',
        },
      ),
    ).rejects.toThrow('control login');
    const environmentPassword = 'environment-private-password';
    const environment = {
      ...env,
      HUABU_PUBLIC_ORIGIN: 'https://env.example',
      HUABU_WORKSPACE: join(env.HUABU_DATA_DIR, 'env-home'),
      HUABU_BASIC_AUTH_USER: 'env-user',
      HUABU_BASIC_AUTH_PASS: environmentPassword,
    };
    await configureDeployment({ remote: true }, environment);
    expect(getPersistedSecret(SECRET_IDS.remoteAccessPassword)).toBe(password);
    expect(readDeploymentSettings(env)?.remoteAccess).toMatchObject({
      username: 'alice',
      publicOrigin: 'https://huabu.example',
    });
    const summary = buildSetupSummary(
      environment,
      readDeploymentSettings(env),
      password,
    ).join('\n');
    expect(summary).toContain('Address  https://env.example · environment');
    expect(summary).toContain('Login    env-user · environment');
    expect(summary).not.toContain(environmentPassword);
    expect(
      readFileSync(join(env.HUABU_CONFIG_DIR, 'deployment.json'), 'utf8'),
    ).not.toContain(environmentPassword);
    await configureDeployment(
      { remote: true, origin: 'https://huabu.example', password },
      { ...env, HUABU_STRUCTURED_BACKEND: 'sqlite' },
    );
    expect(readDeploymentSettings(env)?.remoteAccess).toMatchObject({
      username: 'alice',
    });
  });
});
