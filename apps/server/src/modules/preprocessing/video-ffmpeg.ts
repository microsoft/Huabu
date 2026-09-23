// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { macBuildDirectory } from '../../../scripts/video-media-policy.mjs';

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(
      file,
      process.platform === 'win32' ? constants.R_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

/** Resolve app-owned media, the safe macOS source build, or a non-Mac dependency. */
export async function getVideoFfmpegPath(): Promise<string> {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const mediaRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'media',
  );
  const packaged = path.join(
    mediaRoot,
    `${process.platform}-${process.arch}`,
    binaryName,
  );
  if (await isExecutable(packaged)) return packaged;

  // A media resource tree identifies a bundle. Do not hide an incomplete or
  // wrong-architecture package by resolving some ancestor's node_modules.
  const hasMedia = await stat(mediaRoot).then(
    () => true,
    () => false,
  );
  if (hasMedia) {
    throw new Error(
      `Bundled FFmpeg is missing or not executable: ${packaged}. Rebuild the server media resources.`,
    );
  }

  if (process.platform === 'darwin') {
    const cached = path.join(macBuildDirectory(process.arch), 'ffmpeg');
    if (await isExecutable(cached)) return cached;
    throw new Error(
      `Source-built FFmpeg is missing or not executable: ${cached}. Run pnpm --dir apps/server media:prepare with Xcode Command Line Tools installed.`,
    );
  }

  let installed: string;
  try {
    // Resolving metadata does not execute ffmpeg-static's env-sensitive index.js.
    const manifest = createRequire(import.meta.url).resolve(
      'ffmpeg-static/package.json',
    );
    installed = path.join(path.dirname(manifest), binaryName);
  } catch {
    throw new Error(
      'FFmpeg dependency is unavailable. Install the approved ffmpeg-static dependency or rebuild the server media resources.',
    );
  }
  if (await isExecutable(installed)) return installed;
  throw new Error(
    `Installed FFmpeg is missing or not executable: ${installed}. Run pnpm rebuild ffmpeg-static with its install script approved.`,
  );
}
