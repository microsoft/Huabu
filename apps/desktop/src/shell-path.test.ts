// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureShellPath } from './shell-path';

const { execFile, existsSync } = vi.hoisted(() => ({
  execFile: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile }));
vi.mock('node:fs', () => ({ existsSync }));

describe.skipIf(process.platform === 'win32')('ensureShellPath', () => {
  beforeEach(() => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    existsSync.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('adds nvm binaries without an Electron packaging prerequisite', async () => {
    const nvmBin = '/home/user/.nvm/versions/node/v24.22.0/bin';
    execFile.mockImplementation((_shell, _args, _options, callback) => {
      callback(
        null,
        `shell banner\n__HUABU_PATH__:${nvmBin}:/usr/bin:${nvmBin}:/bin`,
      );
    });

    await ensureShellPath();

    expect(execFile).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-ilc', 'printf \'%s\' "__HUABU_PATH__:$PATH"'],
      { timeout: 3_000, windowsHide: true },
      expect.any(Function),
    );
    expect(process.env.PATH).toBe(`${nvmBin}:/usr/bin:/bin`);
  });

  it.each(['zsh', '/missing/shell'])(
    'does not resolve an invalid shell through PATH: %s',
    async (shell) => {
      vi.stubEnv('SHELL', shell);
      existsSync.mockReturnValue(false);
      execFile.mockImplementation((_shell, _args, _options, callback) => {
        callback(null, '__HUABU_PATH__:/usr/bin:/bin');
      });

      await ensureShellPath();

      expect(execFile.mock.calls[0]?.[0]).toBe('/bin/sh');
      expect(process.env.PATH).toBe('/usr/bin:/bin');
    },
  );

  it.each([
    [new Error('shell timed out'), ''],
    [null, 'banner without a PATH marker'],
  ])('preserves PATH and warns when probing fails', async (error, stdout) => {
    execFile.mockImplementation((_shell, _args, _options, callback) => {
      callback(error, stdout);
    });

    await ensureShellPath();

    expect(process.env.PATH).toBe('/usr/bin:/bin');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('login-shell PATH probe failed'),
    );
  });
});
