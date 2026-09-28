// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  macBuildDirectory,
  macCacheRoot,
  macConfigureArgs,
  sourceArchive,
  sourceSha256,
  sourceUrl,
  sourceVersion,
} from './video-media-policy.mjs';

const run = promisify(execFile);
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export function assertSourceChecksum(bytes) {
  if (sha256(bytes) !== sourceSha256)
    throw new Error(
      'FFmpeg source checksum mismatch; remove the corrupt cached tarball and retry.',
    );
}

export function assertRedistributable(text, lgplOnly = false) {
  if (
    /--enable-nonfree|non[- ]?redistributable|not (?:legally )?redistributable/i.test(
      text,
    )
  )
    throw new Error(
      'Refusing nonredistributable FFmpeg (nonfree configuration/license).',
    );
  if (!/GNU\s+(?:Lesser\s+)?General\s+Public\s+License/.test(text))
    throw new Error('FFmpeg license could not be verified.');
  if (
    lgplOnly &&
    (/--enable-gpl|--enable-version3/.test(text) ||
      !/GNU\s+Lesser\s+General\s+Public\s+License/.test(text))
  )
    throw new Error('macOS FFmpeg must be LGPL-2.1-or-later.');
}

export function assertMacArchitecture(bytes, arch) {
  if (
    !['arm64', 'x64'].includes(arch) ||
    bytes.length < 8 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x0100000c : 0x01000007)
  )
    throw new Error(`FFmpeg architecture mismatch: expected darwin-${arch}`);
}

export function assertMacConfig(config) {
  for (const key of ['GPL', 'NONFREE', 'VERSION3', 'NETWORK', 'AUTODETECT']) {
    if (!config.includes(`#define CONFIG_${key} 0`))
      throw new Error(`Unsafe FFmpeg config: ${key}`);
  }
  for (const key of [
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
  ]) {
    if (!config.includes(`#define CONFIG_${key} 1`))
      throw new Error(`Missing FFmpeg component: ${key}`);
  }
}

export async function auditMacBinary(binary, arch) {
  const bytes = await readFile(binary);
  assertMacArchitecture(bytes, arch);
  // Cross-built x64 cannot always run on arm64 (Rosetta is not required).
  // FFmpeg embeds its active configuration and license in the executable.
  const embedded = bytes.toString('latin1');
  assertRedistributable(embedded, true);
  for (const flag of macConfigureArgs(arch)) {
    if (!embedded.replaceAll("'", '').includes(flag))
      throw new Error(`FFmpeg binary is missing pinned flag: ${flag}`);
  }
  const { stdout: dependencies } = await run('/usr/bin/otool', ['-L', binary]);
  const libraries = dependencies
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0]);
  const systemLibraries = [
    '/usr/lib/libSystem.B.dylib',
    '/usr/lib/libz.1.dylib',
    ...['CoreFoundation', 'CoreVideo', 'CoreMedia'].map(
      (name) =>
        `/System/Library/Frameworks/${name}.framework/Versions/A/${name}`,
    ),
  ];
  if (
    !libraries.length ||
    libraries.some((lib) => !systemLibraries.includes(lib))
  )
    throw new Error(`Unexpected FFmpeg dynamic dependencies: ${dependencies}`);
  let execution =
    'Cross-architecture: embedded configuration/license and Mach-O dependencies audited; not executed.';
  if (arch === process.arch) {
    const license = await run(binary, ['-L']);
    const configuration = await run(binary, ['-buildconf']);
    execution = `${license.stdout}${license.stderr}\n${configuration.stdout}${configuration.stderr}`;
    assertRedistributable(execution, true);
  }
  return { sha256: sha256(bytes), dependencies, execution };
}

async function sourceTarball() {
  const root = path.join(macCacheRoot(), 'sources');
  await mkdir(root, { recursive: true });
  const archive = path.join(root, sourceArchive);
  const present = await stat(archive).then(
    () => true,
    () => false,
  );
  if (!present) {
    const staging = await mkdtemp(path.join(root, 'download-'));
    try {
      const download = path.join(staging, sourceArchive);
      await run(
        '/usr/bin/curl',
        [
          '--fail',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--retry',
          '2',
          '--connect-timeout',
          '30',
          '--max-time',
          '600',
          '--output',
          download,
          sourceUrl,
        ],
        { timeout: 1_900_000 },
      );
      assertSourceChecksum(await readFile(download));
      await rename(download, archive);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  assertSourceChecksum(await readFile(archive));
  return archive;
}

/** Compile both targets with Apple's toolchain; no package binary or external codec libraries. */
export async function buildMacFfmpeg(arch) {
  if (process.platform !== 'darwin')
    throw new Error(
      'macOS FFmpeg must be built on macOS with Xcode Command Line Tools.',
    );
  const args = macConfigureArgs(arch);
  const archive = await sourceTarball();
  const directory = macBuildDirectory(arch);
  const binary = path.join(directory, 'ffmpeg');
  const toolchain =
    (await run('/usr/bin/clang', ['--version'])).stdout +
    (await run('/usr/bin/xcrun', ['--show-sdk-version'])).stdout;
  const previous = await readFile(
    path.join(directory, 'BUILD.json'),
    'utf8',
  ).then(JSON.parse, () => null);
  if (previous) {
    const audit = await auditMacBinary(binary, arch);
    if (
      previous.sha256 !== audit.sha256 ||
      previous.sourceSha256 !== sourceSha256 ||
      previous.toolchain !== toolchain
    )
      throw new Error(
        `FFmpeg cache mismatch; remove ${directory} and run media:prepare again.`,
      );
    assertMacConfig(await readFile(path.join(directory, 'config.h'), 'utf8'));
    return { directory, archive, audit };
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const staging = await mkdtemp(`${directory}-`);
  try {
    await run('/usr/bin/tar', ['-xf', archive, '-C', staging]);
    const cwd = path.join(staging, `ffmpeg-${sourceVersion}`);
    const options = {
      cwd,
      timeout: 1_200_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: os.homedir(),
        TMPDIR: os.tmpdir(),
        LC_ALL: 'C',
        SOURCE_DATE_EPOCH: '0',
        ZERO_AR_DATE: '1',
      },
    };
    console.log(
      `[media] configuring LGPL FFmpeg ${sourceVersion} darwin-${arch}`,
    );
    const configured = await run('./configure', args, options);
    await writeFile(
      path.join(staging, 'configure.log'),
      configured.stdout + configured.stderr,
    );
    const config =
      (await readFile(path.join(cwd, 'config.h'), 'utf8')) +
      (await readFile(path.join(cwd, 'config_components.h'), 'utf8'));
    assertMacConfig(config);
    console.log(`[media] compiling darwin-${arch}`);
    const compiled = await run(
      '/usr/bin/make',
      ['-j', String(Math.min(os.availableParallelism(), 8)), 'ffmpeg'],
      options,
    );
    await writeFile(
      path.join(staging, 'make.log'),
      compiled.stdout + compiled.stderr,
    );
    await copyFile(path.join(cwd, 'ffmpeg'), path.join(staging, 'ffmpeg'));
    await chmod(path.join(staging, 'ffmpeg'), 0o755);
    const audit = await auditMacBinary(path.join(staging, 'ffmpeg'), arch);
    await writeFile(path.join(staging, 'config.h'), config);
    for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md'])
      await copyFile(path.join(cwd, name), path.join(staging, name));
    await writeFile(
      path.join(staging, 'BUILD.json'),
      JSON.stringify(
        {
          sourceVersion,
          sourceUrl,
          sourceSha256,
          arch,
          configure: args,
          toolchain,
          ...audit,
        },
        null,
        2,
      ) + '\n',
    );
    // Only build products live in this external cache; the original archive is kept once.
    await rm(cwd, { recursive: true, force: true });
    await rename(staging, directory);
    return { directory, archive, audit };
  } catch (error) {
    // Preserve compiler diagnostics without modifying any source files.
    console.error(
      `[media] build failed; diagnostics/build tree retained at ${staging}`,
    );
    throw error;
  }
}

export async function copyMacSourceMaterials(mediaRoot, archive) {
  const destination = path.join(mediaRoot, 'source');
  await mkdir(destination, { recursive: true });
  await copyFile(archive, path.join(destination, sourceArchive));
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['build-mac-ffmpeg.mjs', 'video-media-policy.mjs'])
    await copyFile(path.join(here, name), path.join(destination, name));
  await writeFile(
    path.join(destination, 'REBUILD.txt'),
    `FFmpeg ${sourceVersion}, unmodified official source.\nSource: ${sourceUrl}\nSHA-256: ${sourceSha256}\nLicense: LGPL-2.1-or-later; see ../darwin-*/COPYING.LGPLv2.1 and LICENSE.md.\nThe full corresponding source and build scripts accompany the executable here (not merely a future offer).\nOn macOS with Node.js and Xcode Command Line Tools, from this directory:\nnode --input-type=module -e 'import { buildMacFfmpeg } from "./build-mac-ffmpeg.mjs"; await buildMacFfmpeg("arm64"); await buildMacFfmpeg("x64");'\nFor an offline rebuild, place the included tarball in ~/Library/Caches/huabu-ffmpeg/sources/ first.\nExact compiler/SDK and configure arguments are recorded per target in BUILD.json. Different SDK/toolchain versions may produce different binary hashes.\nHuabu invokes this standalone executable as a subprocess, not as a linked library. You may rebuild/replace it under the LGPL.\nOnly Apple system libraries/frameworks may be dynamically linked; the exact list is in BUILD.json. No third-party codec libraries are bundled.\nPreserve this source directory and all notices when redistributing. FFmpeg is not relicensed under Huabu's MIT license.\n`,
  );
}
