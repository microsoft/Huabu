// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
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
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertRedistributable,
  buildMacFfmpeg,
  copyMacSourceMaterials,
} from './build-mac-ffmpeg.mjs';

const runFile = promisify(execFile);
const releaseUrl =
  'https://github.com/eugeneware/ffmpeg-static/releases/download';

export function mediaTargets(platform, arch) {
  const supported = {
    darwin: ['arm64', 'x64'],
    linux: ['x64', 'arm64', 'arm', 'ia32'],
    win32: ['x64', 'ia32'],
    freebsd: ['x64'],
  };
  if (!supported[platform]?.includes(arch))
    throw new Error(`Unsupported FFmpeg target: ${platform}-${arch}`);
  // electron-builder creates both macOS installers in a single invocation.
  return platform === 'darwin' ? ['arm64', 'x64'] : [arch];
}

async function hasCompleteBinary(binary) {
  try {
    const files = await Promise.all(
      [binary, `${binary}.README`, `${binary}.LICENSE`].map((file) =>
        stat(file),
      ),
    );
    return files.every((file) => file.isFile() && file.size > 0);
  } catch {
    return false;
  }
}

/** Source-build macOS; audit the pinned package executable on other native hosts. */
export async function prepareVideoMedia({
  serverRoot,
  platform = process.platform,
  arch = process.arch,
  runInstaller = runFile,
  runAudit = runFile,
  buildMac = buildMacFfmpeg,
}) {
  const targets = mediaTargets(platform, arch);
  const mediaRoot = path.join(serverRoot, 'dist-bundle', 'media');
  if (platform === 'darwin') {
    const builds = [];
    for (const target of targets) builds.push(await buildMac(target));
    for (const [index, build] of builds.entries()) {
      const destination = path.join(mediaRoot, `darwin-${targets[index]}`);
      await mkdir(destination, { recursive: true });
      for (const name of [
        'ffmpeg',
        'COPYING.LGPLv2.1',
        'LICENSE.md',
        'BUILD.json',
        'config.h',
      ])
        await copyFile(
          path.join(build.directory, name),
          path.join(destination, name),
        );
      await chmod(path.join(destination, 'ffmpeg'), 0o755);
      // Remove only obsolete generated notices from the replaced package binaries.
      for (const name of [
        'ffmpeg.README',
        'ffmpeg.LICENSE',
        'ffmpeg-static.LICENSE',
        'ffmpeg-static.README.md',
        'ffmpeg-static.package.json',
      ])
        await rm(path.join(destination, name), { force: true });
      await writeFile(
        path.join(destination, 'SOURCES.txt'),
        'FFmpeg LGPL-2.1-or-later. Full corresponding source and rebuild instructions: ../source/REBUILD.txt. Exact build, license audit, and executable SHA-256: BUILD.json.\n',
      );
      console.log(
        `[media] prepared LGPL darwin-${targets[index]} ${build.audit.sha256}`,
      );
    }
    await copyMacSourceMaterials(mediaRoot, builds[0].archive);
    return;
  }
  const manifestPath = createRequire(
    path.join(serverRoot, 'package.json'),
  ).resolve('ffmpeg-static/package.json');
  const packageRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const release = manifest['ffmpeg-static']['binary-release-tag'];
  // A binary upgrade needs an explicit notice/source and decoder compatibility review.
  if (manifest.version !== '5.3.0' || release !== 'b6.1.1')
    throw new Error(
      'Review FFmpeg media packaging before upgrading ffmpeg-static.',
    );
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const targetArch of targets) {
    let binary = path.join(packageRoot, name);
    if (platform !== process.platform || targetArch !== process.arch) {
      const cacheRoot = path.join(
        serverRoot,
        'node_modules',
        '.cache',
        'ffmpeg-static',
        `${manifest.version}-${release}`,
      );
      const cache = path.join(cacheRoot, `${platform}-${targetArch}`);
      binary = path.join(cache, name);
      if (!(await hasCompleteBinary(binary))) {
        await mkdir(cacheRoot, { recursive: true });
        const staging = await mkdtemp(
          path.join(cacheRoot, `${platform}-${targetArch}-`),
        );
        const stagedBinary = path.join(staging, name);
        try {
          await runInstaller(
            process.execPath,
            [path.join(packageRoot, 'install.js')],
            {
              cwd: packageRoot,
              shell: false,
              timeout: 600_000,
              maxBuffer: 4 * 1024 * 1024,
              env: {
                ...process.env,
                CI: '1',
                npm_config_platform: platform,
                npm_config_arch: targetArch,
                FFMPEG_BIN: stagedBinary,
                FFMPEG_BINARY_RELEASE: release,
                FFMPEG_BINARIES_URL: releaseUrl,
              },
            },
          );
          if (!(await hasCompleteBinary(stagedBinary)))
            throw new Error(
              `Incomplete FFmpeg download or missing license for ${platform}-${targetArch}`,
            );
          await rm(cache, { recursive: true, force: true });
          await rename(staging, cache);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
      }
    }
    if (!(await hasCompleteBinary(binary)))
      throw new Error(
        'FFmpeg binary/README/LICENSE missing; run pnpm rebuild ffmpeg-static with its install script approved.',
      );
    assertRedistributable((await readFile(binary)).toString('latin1'));
    // Definitive license checks must run on a compatible host; no warning fallback.
    const license = await runAudit(binary, ['-L'], {
      shell: false,
      timeout: 30_000,
    });
    const configuration = await runAudit(binary, ['-buildconf'], {
      shell: false,
      timeout: 30_000,
    });
    const audit = `${license.stdout}${license.stderr}\n${configuration.stdout}${configuration.stderr}`;
    assertRedistributable(audit);
    const destination = path.join(mediaRoot, `${platform}-${targetArch}`);
    await mkdir(destination, { recursive: true });
    for (const suffix of ['', '.README', '.LICENSE'])
      await copyFile(
        `${binary}${suffix}`,
        path.join(destination, `${name}${suffix}`),
      );
    await chmod(path.join(destination, name), 0o755);
    await writeFile(path.join(destination, 'AUDIT.txt'), audit);
    for (const [source, target] of [
      ['LICENSE', 'ffmpeg-static.LICENSE'],
      ['README.md', 'ffmpeg-static.README.md'],
      ['package.json', 'ffmpeg-static.package.json'],
    ]) {
      await copyFile(
        path.join(packageRoot, source),
        path.join(destination, target),
      );
    }
    await writeFile(
      path.join(destination, 'SOURCES.txt'),
      [
        `FFmpeg binary release tag ${release} (${platform}-${targetArch}), distributed by ffmpeg-static ${manifest.version}. The release tag is not the executable's FFmpeg version.`,
        `Binary and upstream notices: ${releaseUrl}/${release}/`,
        `Build/source release: https://github.com/eugeneware/ffmpeg-static/releases/tag/${release}`,
        'Packaging source: https://github.com/eugeneware/ffmpeg-static/tree/v5.3.0',
        'FFmpeg source releases: https://ffmpeg.org/releases/',
        'Upstream build/provider information: https://github.com/eugeneware/ffmpeg-static#sources-of-the-binaries',
        `Preserved upstream binary README: ${name}.README. It may be generic, not a complete corresponding-source manifest.`,
        `See ${name}.LICENSE for the binary license. ffmpeg-static is GPL-3.0-or-later; its license and README are included separately.`,
        "These separately distributed third-party components are not relicensed under Huabu's MIT license.",
        'Redistributors must satisfy the applicable GPL corresponding-source and notice obligations for the exact binary, including enabled libraries and build scripts. Source links and notices alone do not establish compliance; arrange the required source distribution or valid written offer before release.',
        'FFmpeg licensing guidance: https://ffmpeg.org/legal.html',
        '',
      ].join('\n'),
    );
    console.log(`[media] prepared ${platform}-${targetArch} FFmpeg ${release}`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await prepareVideoMedia({
    serverRoot: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    ),
  });
}
