// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  stat: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ access: mocks.access, stat: mocks.stat }));
vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mocks.resolve }),
}));

import { getVideoFfmpegPath } from './video-ffmpeg.js';
import { macBuildDirectory } from '../../../scripts/video-media-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.join(here, 'media');
const packageRoot = path.resolve('node_modules/ffmpeg-static');
const files = new Set<string>();

beforeEach(() => {
  vi.resetAllMocks();
  files.clear();
  mocks.stat.mockImplementation(async (file: string) => {
    if (!files.has(file)) throw new Error('ENOENT');
    return { isFile: () => file !== media };
  });
  mocks.access.mockResolvedValue(undefined);
  mocks.resolve.mockReturnValue(path.join(packageRoot, 'package.json'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getVideoFfmpegPath', () => {
  it.each([
    ['darwin', 'arm64', 'ffmpeg'],
    ['darwin', 'x64', 'ffmpeg'],
    ['win32', 'x64', 'ffmpeg.exe'],
    ['linux', 'x64', 'ffmpeg'],
  ])('prefers the packaged %s-%s executable', async (platform, arch, name) => {
    vi.stubGlobal('process', { ...process, platform, arch });
    const binary = path.join(media, `${platform}-${arch}`, name);
    files.add(binary);
    expect(await getVideoFfmpegPath()).toBe(binary);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.access).toHaveBeenCalledWith(
      binary,
      platform === 'win32' ? constants.R_OK : constants.X_OK,
    );
  });

  it('resolves the installed package metadata, ignoring environment overrides', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' });
    vi.stubEnv('FFMPEG_BIN', '/untrusted/ffmpeg');
    vi.stubEnv('npm_config_arch', 'untrusted');
    vi.stubEnv('npm_config_platform', 'untrusted');
    const binary = path.join(
      packageRoot,
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
    files.add(binary);
    expect(await getVideoFfmpegPath()).toBe(binary);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(
      'ffmpeg-static/package.json',
    );
  });

  it('fails closed when the bundle only has the other architecture', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'x64' });
    files.add(media);
    files.add(path.join(media, 'darwin-arm64', 'ffmpeg'));
    files.add(path.join(packageRoot, 'ffmpeg'));
    await expect(getVideoFfmpegPath()).rejects.toThrow('darwin-x64');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('reports missing dependency without trying a system executable', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' });
    mocks.resolve.mockImplementation(() => {
      throw new Error('MODULE_NOT_FOUND');
    });
    await expect(getVideoFfmpegPath()).rejects.toThrow(
      'FFmpeg dependency is unavailable',
    );
  });

  it('reports an installed package with no downloaded binary', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' });
    await expect(getVideoFfmpegPath()).rejects.toThrow(
      'pnpm rebuild ffmpeg-static',
    );
  });

  it('rejects non-executable installed files', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' });
    files.add(
      path.join(
        packageRoot,
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
      ),
    );
    mocks.access.mockRejectedValue(new Error('EACCES'));
    await expect(getVideoFfmpegPath()).rejects.toThrow('not executable');
  });

  it('rejects a directory in place of a binary', async () => {
    mocks.stat.mockResolvedValue({ isFile: () => false });
    await expect(getVideoFfmpegPath()).rejects.toThrow(
      'Bundled FFmpeg is missing',
    );
  });

  it.each(['arm64', 'x64'])(
    'uses only the source-build cache on macOS %s',
    async (arch) => {
      vi.stubGlobal('process', { ...process, platform: 'darwin', arch });
      vi.stubEnv('FFMPEG_BIN', '/untrusted/ffmpeg');
      const binary = path.join(macBuildDirectory(arch), 'ffmpeg');
      files.add(binary);
      files.add(path.join(packageRoot, 'ffmpeg'));
      expect(await getVideoFfmpegPath()).toBe(binary);
      expect(mocks.resolve).not.toHaveBeenCalled();
    },
  );

  it('never falls back to the nonfree macOS package binary when the safe cache is absent', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64' });
    files.add(path.join(packageRoot, 'ffmpeg'));
    await expect(getVideoFfmpegPath()).rejects.toThrow('media:prepare');
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
