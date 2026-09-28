// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { mediaTargets, prepareVideoMedia } from './prepare-video-media.mjs';
import {
  assertMacArchitecture,
  assertMacConfig,
  assertRedistributable,
  assertSourceChecksum,
} from './build-mac-ffmpeg.mjs';
import { macConfigureArgs } from './video-media-policy.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'huabu-video-media-')),
  );
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), '{}');
  const pkg = path.join(root, 'node_modules', 'ffmpeg-static');
  await mkdir(pkg, { recursive: true });
  await writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      version: '5.3.0',
      'ffmpeg-static': { 'binary-release-tag': 'b6.1.1' },
    }),
  );
  for (const name of ['LICENSE', 'README.md'])
    await writeFile(path.join(pkg, name), `package ${name}`);
  return { root, pkg };
}

async function binaryFixture(binary, arch) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  await writeFile(
    binary,
    Buffer.concat([
      header,
      Buffer.from('GNU General Public License --enable-gpl'),
    ]),
  );
  await writeFile(`${binary}.README`, 'binary source README');
  await writeFile(`${binary}.LICENSE`, 'binary GPL license');
}

test('macOS always prepares both architectures; other platforms keep their target', () => {
  assert.deepEqual(mediaTargets('darwin', 'arm64'), ['arm64', 'x64']);
  assert.deepEqual(mediaTargets('darwin', 'x64'), ['arm64', 'x64']);
  assert.deepEqual(mediaTargets('win32', 'x64'), ['x64']);
  assert.deepEqual(mediaTargets('linux', 'arm64'), ['arm64']);
  assert.throws(() => mediaTargets('../untrusted', 'x64'), /Unsupported/);
});

test('copies audited Windows binaries and notices; reuses complete cache', async () => {
  const { root, pkg } = await fixture();
  if (process.platform === 'win32')
    await binaryFixture(path.join(pkg, 'ffmpeg.exe'), process.arch);
  let calls = 0;
  const runInstaller = async (executable, args, options) => {
    calls++;
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [path.join(pkg, 'install.js')]);
    assert.equal(options.shell, false);
    assert.equal(options.env.npm_config_platform, 'win32');
    assert.equal(options.env.FFMPEG_BINARY_RELEASE, 'b6.1.1');
    assert.equal(
      options.env.FFMPEG_BINARIES_URL,
      'https://github.com/eugeneware/ffmpeg-static/releases/download',
    );
    assert.ok(
      options.env.FFMPEG_BIN.startsWith(
        path.join(root, 'node_modules', '.cache'),
      ),
    );
    await binaryFixture(options.env.FFMPEG_BIN, options.env.npm_config_arch);
  };
  const options = {
    serverRoot: root,
    platform: 'win32',
    arch: 'x64',
    runInstaller,
    runAudit: async () => ({
      stdout: 'GNU General Public License --enable-gpl',
      stderr: '',
    }),
  };
  await prepareVideoMedia(options);
  const initialCalls = calls;
  assert.equal(calls, process.platform === 'win32' ? 0 : 1);
  await prepareVideoMedia(options);
  assert.equal(calls, initialCalls);
  for (const arch of ['x64']) {
    const output = path.join(root, 'dist-bundle', 'media', `win32-${arch}`);
    const binary = await readFile(path.join(output, 'ffmpeg.exe'));
    assert.equal(
      binary.readUInt32LE(4),
      arch === 'arm64' ? 0x0100000c : 0x01000007,
    );
    assert.equal(
      (await stat(path.join(output, 'ffmpeg.exe'))).mode & 0o111,
      process.platform === 'win32' ? 0 : 0o111,
    );
    assert.equal(
      await readFile(path.join(output, 'ffmpeg.exe.LICENSE'), 'utf8'),
      'binary GPL license',
    );
    assert.equal(
      await readFile(path.join(output, 'ffmpeg.exe.README'), 'utf8'),
      'binary source README',
    );
    assert.equal(
      await readFile(path.join(output, 'ffmpeg-static.LICENSE'), 'utf8'),
      'package LICENSE',
    );
    assert.match(
      await readFile(path.join(output, 'SOURCES.txt'), 'utf8'),
      /corresponding.source/,
    );
  }
});

test('rejects incorrect Mach-O architecture and unsafe/missing config', () => {
  assert.throws(
    () => assertMacArchitecture(Buffer.alloc(8), 'arm64'),
    /architecture mismatch/,
  );
  assert.throws(() => assertMacConfig('#define CONFIG_NONFREE 1'), /Unsafe/);
  assert.throws(() => macConfigureArgs('../untrusted'), /Unsupported/);
  assert.ok(
    macConfigureArgs('x64').includes('--cc=/usr/bin/clang -arch x86_64'),
  );
});

test('thumbnail recipe requires all bounded-sampling filters in generated config', () => {
  const config = [
    ...['GPL', 'NONFREE', 'VERSION3', 'NETWORK', 'AUTODETECT'].map(
      (key) => `#define CONFIG_${key} 0`,
    ),
    ...[
      'FFMPEG',
      'MJPEG_ENCODER',
      'PNG_DECODER',
      'MJPEG_DECODER',
      'H264_DECODER',
      'HEVC_DECODER',
      'VP9_DECODER',
      'MOV_DEMUXER',
      'MATROSKA_DEMUXER',
      'AVI_DEMUXER',
      'FLV_DEMUXER',
      'MPEGTS_DEMUXER',
      'MPEGPS_DEMUXER',
      'MPEGVIDEO_DEMUXER',
      'OGG_DEMUXER',
      'ASF_DEMUXER',
      'IMAGE2PIPE_MUXER',
      'FILE_PROTOCOL',
      'PIPE_PROTOCOL',
      'SCALE_FILTER',
      'FORMAT_FILTER',
      'FPS_FILTER',
      'TRIM_FILTER',
      'THUMBNAIL_FILTER',
    ].map((key) => `#define CONFIG_${key} 1`),
  ].join('\n');
  assert.doesNotThrow(() => assertMacConfig(config));
  for (const filter of ['FPS', 'TRIM', 'THUMBNAIL']) {
    assert.throws(
      () =>
        assertMacConfig(
          config.replace(
            `#define CONFIG_${filter}_FILTER 1`,
            `#define CONFIG_${filter}_FILTER 0`,
          ),
        ),
      new RegExp(`Missing FFmpeg component: ${filter}_FILTER`),
    );
  }
  for (const arch of ['arm64', 'x64']) {
    assert.ok(
      macConfigureArgs(arch).includes(
        '--enable-filter=scale,format,null,fps,trim,thumbnail',
      ),
    );
  }
});

test('fails when the installer omits binary licensing materials', async () => {
  const { root, pkg } = await fixture();
  if (process.platform === 'win32')
    await binaryFixture(path.join(pkg, 'ffmpeg.exe'), process.arch);
  await assert.rejects(
    prepareVideoMedia({
      serverRoot: root,
      platform: 'linux',
      arch:
        process.platform === 'linux' && process.arch === 'x64'
          ? 'arm64'
          : 'x64',
      runInstaller: async (_exe, _args, options) => {
        await writeFile(options.env.FFMPEG_BIN, 'binary only');
      },
    }),
    /missing license/,
  );
});

test('rejects absent installed host binary without falling back to PATH or downloading at runtime', async () => {
  const { root } = await fixture();
  await assert.rejects(
    prepareVideoMedia({
      serverRoot: root,
      platform: 'linux',
      arch: 'x64',
      runInstaller: async () => {
        throw new Error('pnpm rebuild ffmpeg-static');
      },
    }),
    /pnpm rebuild ffmpeg-static/,
  );
});

test('Windows installer output uses ffmpeg.exe with matching notices', async () => {
  const { root, pkg } = await fixture();
  if (process.platform === 'win32')
    await binaryFixture(path.join(pkg, 'ffmpeg.exe'), 'x64');
  await prepareVideoMedia({
    serverRoot: root,
    platform: 'win32',
    arch: 'x64',
    runAudit: async () => ({
      stdout: 'GNU General Public License',
      stderr: '',
    }),
    runInstaller: async (_exe, _args, options) => {
      assert.equal(options.env.npm_config_platform, 'win32');
      assert.equal(path.basename(options.env.FFMPEG_BIN), 'ffmpeg.exe');
      await binaryFixture(options.env.FFMPEG_BIN, 'x64');
    },
  });
  assert.ok(
    (
      await stat(
        path.join(root, 'dist-bundle/media/win32-x64/ffmpeg.exe.LICENSE'),
      )
    ).isFile(),
  );
});

test('license guard rejects nonfree flags, nonredistributable text and unknown licenses', () => {
  for (const text of [
    'GNU General Public License --enable-nonfree',
    'This version is not legally redistributable.',
    'nonredistributable',
    'unknown',
  ])
    assert.throws(() => assertRedistributable(text));
  assert.doesNotThrow(() =>
    assertRedistributable(
      'GNU Lesser General Public\nLicense version 2.1',
      true,
    ),
  );
  assert.throws(
    () =>
      assertRedistributable('GNU General Public License --enable-gpl', true),
    /LGPL/,
  );
});

test('source pin fails closed for corrupt downloads and cached archives', () => {
  assert.throws(
    () => assertSourceChecksum(Buffer.from('not the official source')),
    /checksum mismatch/,
  );
});

test('packaging fails on embedded nonfree configuration before executing it', async () => {
  const { root, pkg } = await fixture();
  const installed = path.join(pkg, 'ffmpeg.exe');
  if (process.platform === 'win32') {
    await binaryFixture(installed, 'x64');
    await writeFile(installed, 'GNU General Public License --enable-nonfree');
  }
  await assert.rejects(
    prepareVideoMedia({
      serverRoot: root,
      platform: 'win32',
      arch: 'x64',
      runInstaller: async (_exe, _args, options) => {
        await binaryFixture(options.env.FFMPEG_BIN, 'x64');
        await writeFile(
          options.env.FFMPEG_BIN,
          'GNU General Public License --enable-nonfree',
        );
      },
      runAudit: async () => {
        throw new Error('must not execute a rejected binary');
      },
    }),
    /nonredistributable/,
  );
  await assert.rejects(
    stat(path.join(root, 'dist-bundle/media/win32-x64/ffmpeg.exe')),
  );
});

test('packaging fails on nonfree -L output before copying a binary', async () => {
  const { root, pkg } = await fixture();
  if (process.platform === 'win32')
    await binaryFixture(path.join(pkg, 'ffmpeg.exe'), process.arch);
  await assert.rejects(
    prepareVideoMedia({
      serverRoot: root,
      platform: 'win32',
      arch: 'x64',
      runInstaller: async (_exe, _args, options) =>
        binaryFixture(options.env.FFMPEG_BIN, 'x64'),
      runAudit: async () => ({
        stdout: 'This version is not legally redistributable.',
        stderr: '--enable-nonfree',
      }),
    }),
    /nonredistributable/,
  );
  await assert.rejects(
    stat(path.join(root, 'dist-bundle/media/win32-x64/ffmpeg.exe')),
  );
});

test('macOS uses source builds without resolving or running the package installer', async () => {
  const { root } = await fixture();
  const targets = [];
  const buildMac = async (arch) => {
    targets.push(arch);
    const directory = path.join(root, arch);
    await mkdir(directory);
    for (const name of [
      'ffmpeg',
      'COPYING.LGPLv2.1',
      'LICENSE.md',
      'BUILD.json',
      'config.h',
    ])
      await writeFile(path.join(directory, name), `safe ${arch}`);
    const archive = path.join(root, 'source.tar.xz');
    await writeFile(archive, 'fixture source');
    return { directory, archive, audit: { sha256: arch } };
  };
  await prepareVideoMedia({
    serverRoot: root,
    platform: 'darwin',
    arch: 'arm64',
    buildMac,
    runInstaller: async () => {
      throw new Error('must not use package');
    },
  });
  assert.deepEqual(targets, ['arm64', 'x64']);
  for (const arch of targets) {
    const destination = path.join(root, 'dist-bundle/media', `darwin-${arch}`);
    assert.equal(
      await readFile(path.join(destination, 'ffmpeg'), 'utf8'),
      `safe ${arch}`,
    );
    assert.match(
      await readFile(path.join(destination, 'SOURCES.txt'), 'utf8'),
      /corresponding source/,
    );
    await assert.rejects(stat(path.join(destination, 'ffmpeg-static.LICENSE')));
  }
  assert.match(
    await readFile(
      path.join(root, 'dist-bundle/media/source/REBUILD.txt'),
      'utf8',
    ),
    /unmodified official source/,
  );
});
