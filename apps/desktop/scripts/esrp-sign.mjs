// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import YAML from 'yaml';

export const stages = ['app', 'elevate', 'uninstaller', 'installer'];

export function signingPaths(output, version) {
  const installer = `Huabu-Setup-${version}`;
  return {
    app: path.resolve(output, 'win-unpacked', 'Huabu.exe'),
    elevate: path.resolve(output, 'win-unpacked', 'resources', 'elevate.exe'),
    uninstaller: path.resolve(output, `${installer}.__uninstaller.exe`),
    installer: path.resolve(output, `${installer}.exe`),
  };
}

function stateRoot() {
  const root = process.env.HUABU_ESRP_STATE;
  if (!root || !path.isAbsolute(root)) {
    throw new Error(
      'HUABU_ESRP_STATE must be an absolute CI signing directory',
    );
  }
  return root;
}

export async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export async function readReceipt(directory) {
  const receipt = JSON.parse(
    await readFile(path.join(directory, 'signed.json'), 'utf8'),
  );
  if (
    typeof receipt.publisher !== 'string' ||
    !receipt.publisher.trim() ||
    typeof receipt.sha256 !== 'string' ||
    receipt.sha256.toLowerCase() !==
      (await sha256(path.join(directory, 'artifact.exe')))
  ) {
    throw new Error('Invalid ESRP signature verification receipt');
  }
  return receipt;
}

export async function handoff(file, stage, root, timeoutMs = 30 * 60 * 1000) {
  if (!stages.includes(stage)) {
    throw new Error(`Unexpected ESRP signing stage: ${stage}`);
  }
  const directory = path.join(root, stage);
  // A fresh directory prevents an earlier build's signature from being reused.
  await mkdir(directory);
  const artifact = path.join(directory, 'artifact.exe');
  const unsignedHash = await sha256(file);
  await copyFile(file, artifact);
  await writeFile(path.join(directory, 'ready.tmp'), unsignedHash);
  await rename(
    path.join(directory, 'ready.tmp'),
    path.join(directory, 'ready'),
  );
  console.log(`Waiting for ESRP signing: ${stage} (${path.basename(file)})`);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path.join(directory, 'signed.json'))) {
    if (existsSync(path.join(root, 'abort'))) {
      throw new Error(`ESRP signing aborted: ${stage}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ESRP signing: ${stage}`);
    }
    await setTimeout(500);
  }
  const receipt = await readReceipt(directory);
  if (receipt.sha256.toLowerCase() === unsignedHash) {
    throw new Error(`ESRP did not change the signing input: ${stage}`);
  }
  await copyFile(artifact, file);
}

export async function sign(configuration) {
  if (configuration.hash !== 'sha256' || configuration.isNest) {
    throw new Error('ESRP requires one SHA-256 signing operation per file');
  }
  const root = stateRoot();
  const { output, version } = JSON.parse(
    await readFile(path.join(root, 'build.json'), 'utf8'),
  );
  const resolvedPath = path.resolve(configuration.path);
  const ffmpeg = path.resolve(
    output,
    'win-unpacked',
    'resources',
    'server',
    'media',
    'win32-x64',
    'ffmpeg.exe',
  );
  if (resolvedPath === ffmpeg) {
    console.log(
      'Preserving audited third-party FFmpeg bytes without re-signing',
    );
    return;
  }
  const stage = Object.entries(signingPaths(output, version)).find(
    ([, file]) => file === resolvedPath,
  )?.[0];
  if (!stage) {
    throw new Error(
      `Unreviewed binary requested signing: ${configuration.path}`,
    );
  }
  await handoff(configuration.path, stage, root);
}

export async function afterSign({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'win32') {
    throw new Error('The ESRP packaging configuration is Windows-only');
  }
  const { publisher } = await readReceipt(path.join(stateRoot(), 'app'));
  const feedPath = path.join(appOutDir, 'resources', 'app-update.yml');
  const feed = YAML.parse(await readFile(feedPath, 'utf8'));
  if (!feed || feed.provider !== 'github') {
    throw new Error('Expected the existing GitHub desktop update feed');
  }
  // Remote signing cannot expose a local certificate to electron-builder.
  // Use the verified signer's subject for electron-updater's publisher check.
  feed.publisherName = [publisher];
  await writeFile(feedPath, YAML.stringify(feed));
}
