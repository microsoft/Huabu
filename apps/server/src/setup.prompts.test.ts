// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as prompts from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveDeploymentSettings } from './security/deployment-settings.js';
import { readPersistedSecret } from './security/secret-store.js';
import { promptDeployment } from './setup.js';

import type * as SecretStore from './security/secret-store.js';

vi.mock('@clack/prompts', () => ({
  CANCEL_SYMBOL: Symbol.for('huabu-setup-cancel'),
  isCancel: (value: unknown) => value === Symbol.for('huabu-setup-cancel'),
  confirm: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('./security/secret-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SecretStore>()),
  readPersistedSecret: vi.fn(),
}));

let directory: string;
let env: NodeJS.ProcessEnv & {
  HUABU_CONFIG_DIR: string;
  HUABU_DATA_DIR: string;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readPersistedSecret).mockResolvedValue(null);
  directory = mkdtempSync(join(tmpdir(), 'huabu-setup-prompts-'));
  env = {
    HUABU_CONFIG_DIR: join(directory, 'config'),
    HUABU_DATA_DIR: join(directory, 'data'),
  };
  vi.mocked(prompts.confirm).mockResolvedValue(true);
  vi.mocked(prompts.text)
    .mockResolvedValueOnce('https://huabu.example/')
    .mockResolvedValueOnce(join(directory, 'home'))
    .mockResolvedValueOnce('alice');
  vi.mocked(prompts.password).mockResolvedValue('private-test-password');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('interactive setup prompts', () => {
  it.each([false, true])(
    'keeps a saved password unless explicitly choosing to change it: %s',
    async (changePassword) => {
      vi.mocked(readPersistedSecret).mockResolvedValue(
        'saved-private-password',
      );
      vi.mocked(prompts.confirm).mockImplementation(async (options) =>
        options.message === 'Change login password?' ? changePassword : true,
      );
      const input = await promptDeployment(env);
      expect(input.username).toBe('alice');
      expect(prompts.confirm).toHaveBeenCalledWith({
        message: 'Change login password?',
        initialValue: false,
      });
      expect(prompts.password).toHaveBeenCalledTimes(changePassword ? 2 : 0);
      if (changePassword) {
        expect(input.password).toBe('private-test-password');
      } else {
        expect(input).not.toHaveProperty('password');
      }
      expect(
        JSON.stringify({
          input,
          prompts: vi.mocked(prompts.password).mock.calls,
          log: vi.mocked(prompts.log.info).mock.calls,
        }),
      ).not.toContain('saved-private-password');
    },
  );

  it('surfaces saved-password read failures without asking for a replacement', async () => {
    vi.mocked(readPersistedSecret).mockRejectedValue(
      new Error('Unable to decrypt saved credentials'),
    );
    await expect(promptDeployment(env)).rejects.toThrow(
      'Unable to decrypt saved credentials',
    );
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it('cancels at the password-change choice without saving', async () => {
    vi.mocked(readPersistedSecret).mockResolvedValue('saved-password');
    vi.mocked(prompts.confirm).mockImplementation(async (options) =>
      options.message === 'Change login password?'
        ? prompts.CANCEL_SYMBOL
        : true,
    );
    await expect(promptDeployment(env)).rejects.toThrow();
    expect(existsSync(env.HUABU_CONFIG_DIR)).toBe(false);
    expect(existsSync(env.HUABU_DATA_DIR)).toBe(false);
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it('defaults to local access without asking remote questions', async () => {
    vi.mocked(prompts.confirm).mockResolvedValue(false);
    expect(await promptDeployment(env)).toEqual({ remote: false });
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: 'Allow remote access?',
      initialValue: false,
    });
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it('prefills saved remote settings and retains them when accepting the defaults', async () => {
    const saved = {
      enabled: true as const,
      username: 'saved-user',
      publicOrigin: 'https://saved.example',
      workspacePath: join(directory, 'saved-home'),
    };
    saveDeploymentSettings({ version: 1, remoteAccess: saved }, env);
    vi.mocked(prompts.confirm).mockImplementation(
      async (options) => options.initialValue ?? false,
    );
    vi.mocked(prompts.text)
      .mockReset()
      .mockImplementation(async (options) => options.initialValue ?? '');

    expect(await promptDeployment(env)).toEqual({
      remote: true,
      origin: saved.publicOrigin,
      workspacePath: saved.workspacePath,
      username: saved.username,
      password: 'private-test-password',
      allowHttp: false,
    });
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: 'Allow remote access?',
      initialValue: true,
    });
    for (const [message, initialValue] of [
      ['Server address', saved.publicOrigin],
      ['Home directory', saved.workspacePath],
      ['Login username', saved.username],
    ]) {
      expect(prompts.text).toHaveBeenCalledWith(
        expect.objectContaining({ message, initialValue }),
      );
    }
    expect(prompts.password).toHaveBeenCalledTimes(2);
  });

  it('retains saved local mode when accepting the default', async () => {
    saveDeploymentSettings(
      { version: 1, remoteAccess: { enabled: false } },
      env,
    );
    vi.mocked(prompts.confirm).mockImplementation(
      async (options) => options.initialValue ?? false,
    );
    expect(await promptDeployment(env)).toEqual({ remote: false });
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: 'Allow remote access?',
      initialValue: false,
    });
    expect(prompts.text).not.toHaveBeenCalled();
  });

  it('displays fully environment-managed remote settings without prompting or copying the password', async () => {
    Object.assign(env, {
      HUABU_BIND_HOST: '0.0.0.0',
      HUABU_PUBLIC_ORIGIN: 'https://env.example',
      HUABU_WORKSPACE: join(directory, 'env-home'),
      HUABU_BASIC_AUTH_USER: 'env-user',
      HUABU_BASIC_AUTH_PASS: 'private-environment-password',
      HUABU_ALLOWED_HOSTS: 'alias.example',
      SERVER_PORT: '4000',
    });
    expect(await promptDeployment(env)).toEqual({
      remote: true,
      origin: 'https://env.example',
      allowHttp: false,
      workspacePath: undefined,
    });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.password).not.toHaveBeenCalled();
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Access mode\nRemote (0.0.0.0) · environment',
    );
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Server address\nhttps://env.example · environment',
    );
    expect(prompts.log.info).toHaveBeenCalledWith(
      `Home directory\n${join(directory, 'env-home')} · environment`,
    );
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Login credentials\nenv-user\nPassword configured · environment',
    );
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Additional host aliases\nalias.example · environment',
    );
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Server port\n4000 · environment',
    );
    expect(
      JSON.stringify(vi.mocked(prompts.log.info).mock.calls),
    ).not.toContain('private-environment-password');
  });

  it('does not offer remote access when the environment fixes a loopback bind', async () => {
    env.HUABU_BIND_HOST = '127.0.0.1';
    env.HUABU_PUBLIC_ORIGIN = 'https://env.example';
    env.HUABU_BASIC_AUTH_USER = 'env-user';
    env.HUABU_BASIC_AUTH_PASS = 'private-environment-password';
    expect(await promptDeployment(env)).toEqual({ remote: false });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.password).not.toHaveBeenCalled();
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Access mode\nLocal only (127.0.0.1) · environment',
    );
    expect(prompts.log.info).toHaveBeenCalledWith(
      'Login credentials\nenv-user\nPassword configured · environment',
    );
  });

  it('skips environment-managed credentials for SQL storage too', async () => {
    Object.assign(env, {
      HUABU_STRUCTURED_BACKEND: 'sqlite',
      HUABU_BIND_HOST: '0.0.0.0',
      HUABU_PUBLIC_ORIGIN: 'https://env.example',
      HUABU_BASIC_AUTH_USER: 'env-user',
      HUABU_BASIC_AUTH_PASS: 'private-environment-password',
    });
    expect(await promptDeployment(env)).toMatchObject({ remote: true });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it.each(['address', 'credentials', 'home'])(
    'skips only the environment-managed %s field',
    async (field) => {
      if (field === 'address') env.HUABU_PUBLIC_ORIGIN = 'https://env.example';
      if (field === 'credentials') {
        env.HUABU_BASIC_AUTH_USER = 'env-user';
        env.HUABU_BASIC_AUTH_PASS = 'private-environment-password';
      }
      if (field === 'home') env.HUABU_WORKSPACE = join(directory, 'env-home');
      vi.mocked(prompts.text)
        .mockReset()
        .mockImplementation(async (options) => {
          if (options.message === 'Server address')
            return 'https://huabu.example';
          if (options.message === 'Home directory')
            return join(directory, 'home');
          if (options.message === 'Login username') return 'alice';
          throw new Error('Unexpected prompt');
        });
      await promptDeployment(env);
      const messages = vi
        .mocked(prompts.text)
        .mock.calls.map(([options]) => options.message);
      expect(messages.includes('Server address')).toBe(field !== 'address');
      expect(messages.includes('Home directory')).toBe(field !== 'home');
      expect(messages.includes('Login username')).toBe(field !== 'credentials');
      expect(prompts.password).toHaveBeenCalledTimes(
        field === 'credentials' ? 0 : 2,
      );
    },
  );

  it('rejects incomplete environment credentials before asking any questions', async () => {
    env.HUABU_BASIC_AUTH_USER = 'env-user';
    await expect(promptDeployment(env)).rejects.toThrow('configured together');
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it('collects remote choices with normalized addresses and masked passwords', async () => {
    expect(await promptDeployment(env)).toEqual({
      remote: true,
      origin: 'https://huabu.example',
      workspacePath: join(directory, 'home'),
      password: 'private-test-password',
      username: 'alice',
      allowHttp: false,
    });
    expect(prompts.password).toHaveBeenCalledTimes(2);
    for (const [options] of vi.mocked(prompts.password).mock.calls) {
      expect(options.mask).toBe('*');
    }
    expect(prompts.confirm).toHaveBeenCalledTimes(2);
    expect(existsSync(env.HUABU_CONFIG_DIR)).toBe(false);
  });

  it('validates addresses, absolute Homes, passwords, and confirmation inline', async () => {
    await promptDeployment(env);
    const [address, home, username] = vi.mocked(prompts.text).mock.calls;
    const [password, confirmation] = vi.mocked(prompts.password).mock.calls;
    for (const [options] of [address, home, username, password, confirmation]) {
      expect(typeof options.validate).toBe('function');
      if (typeof options.validate !== 'function')
        throw new Error('Expected a validation callback');
      if (options === address[0]) {
        expect(options.validate('not-an-origin')).toContain('HTTP');
        expect(options.validate('https://huabu.example')).toBeUndefined();
      } else if (options === home[0]) {
        expect(options.validate('./relative')).toContain('absolute');
        expect(options.validate(join(directory, 'home'))).toBeUndefined();
      } else if (options === username[0]) {
        expect(options.validate('')).toBeUndefined();
        expect(options.validate(' ')).toContain('username');
        expect(options.validate('alice:secret')).toContain('colons');
        expect(options.validate('alice\n')).toContain('control');
        expect(options.validate('alice')).toBeUndefined();
      } else if (options === password[0]) {
        expect(options.validate('')).toContain('non-empty');
        expect(options.validate('a')).toBeUndefined();
        expect(options.validate('a'.repeat(11))).toBeUndefined();
        expect(options.validate('a'.repeat(12))).toBeUndefined();
        expect(options.validate('a'.repeat(1024))).toBeUndefined();
        expect(options.validate('a'.repeat(8192))).toBeUndefined();
      } else {
        expect(options.validate('different-password')).toContain(
          'do not match',
        );
        expect(options.validate('private-test-password')).toBeUndefined();
      }
    }
  });

  it.each([undefined, 'saved-user'])(
    'allows skipping the username and defaults to %s',
    async (savedUsername) => {
      if (savedUsername) {
        saveDeploymentSettings(
          {
            version: 1,
            remoteAccess: {
              enabled: true,
              username: savedUsername,
              publicOrigin: 'https://huabu.example',
              workspacePath: join(directory, 'home'),
            },
          },
          env,
        );
      }
      vi.mocked(prompts.text)
        .mockReset()
        .mockResolvedValueOnce('https://huabu.example')
        .mockResolvedValueOnce(join(directory, 'home'))
        .mockResolvedValueOnce('');
      const username = savedUsername ?? 'owner';
      expect(await promptDeployment(env)).toMatchObject({ username });
      expect(prompts.text).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: 'Login username',
          defaultValue: username,
          placeholder: username,
          initialValue: username,
        }),
      );
    },
  );

  it.each(['prompt', 'environment'])(
    'warns about HTTP from %s without an extra confirmation',
    async (source) => {
      if (source === 'environment')
        env.HUABU_PUBLIC_ORIGIN = 'http://192.0.2.10:3001';
      vi.mocked(prompts.text)
        .mockReset()
        .mockImplementation(async (options) => {
          if (options.message === 'Server address')
            return 'http://192.0.2.10:3001';
          if (options.message === 'Home directory')
            return join(directory, 'home');
          if (options.message === 'Login username') return 'alice';
          throw new Error('Unexpected prompt');
        });
      expect(await promptDeployment(env)).toMatchObject({
        origin: 'http://192.0.2.10:3001',
        allowHttp: true,
      });
      expect(prompts.log.warn).toHaveBeenCalledWith(
        'HTTP sends passwords and data without encryption.',
      );
      expect(prompts.log.warn).toHaveBeenCalledTimes(1);
      expect(
        vi
          .mocked(prompts.confirm)
          .mock.calls.map(([options]) => options.message),
      ).toEqual(['Allow remote access?', 'Require login?']);
    },
  );

  it.each(['override', 'sqlite'])(
    'skips the Home prompt for %s',
    async (mode) => {
      if (mode === 'override') env.HUABU_WORKSPACE = join(directory, 'managed');
      else env.HUABU_STRUCTURED_BACKEND = 'sqlite';
      vi.mocked(prompts.text)
        .mockReset()
        .mockResolvedValueOnce('https://huabu.example')
        .mockResolvedValueOnce('alice');
      expect(await promptDeployment(env)).toMatchObject({
        workspacePath: undefined,
      });
      expect(prompts.text).toHaveBeenCalledTimes(2);
    },
  );

  it('skips credentials only after explicitly confirming access without login', async () => {
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const input = await promptDeployment(env);
    expect(input).toMatchObject({ remote: true, login: false });
    expect(input).not.toHaveProperty('username');
    expect(input).not.toHaveProperty('password');
    expect(prompts.text).toHaveBeenCalledTimes(2);
    expect(prompts.password).not.toHaveBeenCalled();
    expect(prompts.confirm).toHaveBeenLastCalledWith({
      message: 'Continue without login?',
      initialValue: false,
    });
    expect(prompts.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('full owner access'),
    );
  });

  it('cancels without saving when access without login is not confirmed', async () => {
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    await expect(promptDeployment(env)).rejects.toThrow();
    expect(existsSync(env.HUABU_CONFIG_DIR)).toBe(false);
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it('defaults to the saved no-login choice but requires fresh risk confirmation', async () => {
    saveDeploymentSettings(
      {
        version: 1,
        remoteAccess: {
          enabled: true,
          authentication: 'none',
          publicOrigin: 'https://saved.example',
          workspacePath: join(directory, 'home'),
        },
      },
      env,
    );
    vi.mocked(prompts.confirm)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async (options) => options.initialValue ?? true)
      .mockResolvedValueOnce(true);
    expect(await promptDeployment(env)).toMatchObject({ login: false });
    expect(prompts.confirm).toHaveBeenCalledWith({
      message: 'Require login?',
      initialValue: false,
    });
    expect(prompts.confirm).toHaveBeenLastCalledWith({
      message: 'Continue without login?',
      initialValue: false,
    });
  });

  it.each(['disk', 'sqlite'])(
    'skips environment-managed no-login inputs for %s',
    async (backend) => {
      Object.assign(env, {
        HUABU_BIND_HOST: '0.0.0.0',
        HUABU_PUBLIC_ORIGIN: 'https://env.example',
        HUABU_AUTH_MODE: 'none',
        HUABU_STRUCTURED_BACKEND: backend,
        ...(backend === 'disk'
          ? { HUABU_WORKSPACE: join(directory, 'home') }
          : {}),
      });
      expect(await promptDeployment(env)).toMatchObject({ login: false });
      expect(prompts.confirm).not.toHaveBeenCalled();
      expect(prompts.text).not.toHaveBeenCalled();
      expect(prompts.password).not.toHaveBeenCalled();
      expect(prompts.log.info).toHaveBeenCalledWith(
        'Login\nDisabled · environment',
      );
    },
  );

  it.each([
    'mode',
    'address',
    'home',
    'login',
    'username',
    'password',
    'confirmation',
  ])('cancels at %s without saving configuration', async (stage) => {
    if (stage === 'mode') {
      vi.mocked(prompts.confirm).mockResolvedValueOnce(prompts.CANCEL_SYMBOL);
    } else if (stage === 'login') {
      vi.mocked(prompts.confirm)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(prompts.CANCEL_SYMBOL);
    } else if (['address', 'home', 'username'].includes(stage)) {
      vi.mocked(prompts.text).mockReset();
      if (stage !== 'address') {
        vi.mocked(prompts.text).mockResolvedValueOnce('https://huabu.example');
      }
      if (stage === 'username') {
        vi.mocked(prompts.text).mockResolvedValueOnce(join(directory, 'home'));
      }
      vi.mocked(prompts.text).mockResolvedValueOnce(prompts.CANCEL_SYMBOL);
    } else {
      vi.mocked(prompts.password).mockReset();
      if (stage === 'confirmation') {
        vi.mocked(prompts.password).mockResolvedValueOnce(
          'private-test-password',
        );
      }
      vi.mocked(prompts.password).mockResolvedValueOnce(prompts.CANCEL_SYMBOL);
    }
    await expect(promptDeployment(env)).rejects.toThrow();
    expect(existsSync(env.HUABU_CONFIG_DIR)).toBe(false);
    expect(existsSync(env.HUABU_DATA_DIR)).toBe(false);
  });
});
