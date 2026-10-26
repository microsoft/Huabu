import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  archiveArguments,
  mergeReleaseMetadata,
  packagingOptions,
  validateEntitlements,
  validateSignature,
} from './esrp-macos.mjs';

test('Azure signs and notarizes both architectures before packaging or publishing', async () => {
  const pipeline = YAML.parse(
    await readFile(
      new URL('../../../azure-pipelines.yml', import.meta.url),
      'utf8',
    ),
  );
  const mac = pipeline.jobs.find((job) => job.job === 'macOS');
  assert.equal(mac.pool.vmImage, 'macos-latest');
  const loops = mac.steps.filter((step) =>
    Object.keys(step)[0].includes('each arch'),
  );
  assert.equal(loops.length, 2);
  const tasks = loops.map((loop) => {
    assert.equal(
      Object.keys(loop)[0],
      "${{ each arch in split('arm64,x64', ',') }}",
    );
    return Object.values(loop)[0][0];
  });
  for (const task of tasks) {
    assert.equal(task.task, 'EsrpAppleCodeSigning@1');
    assert.equal(task.inputs.Pattern, 'Huabu.zip');
    assert.equal(task.env.SYSTEM_ACCESSTOKEN, '$(System.AccessToken)');
    assert.equal(
      task.env.ESRP_GATEWAY_API,
      'https://api.esrp.microsoft.com/api/v2',
    );
    assert.equal(
      JSON.parse(task.inputs.inlineOperation)[0].KeyCode,
      'CP-401337-Apple',
    );
  }
  assert.equal(
    JSON.parse(tasks[0].inputs.inlineOperation)[0].OperationCode,
    'MacAppDeveloperSign',
  );
  assert.equal(
    JSON.parse(tasks[1].inputs.inlineOperation)[0].OperationCode,
    'MacAppDeveloperNotarize',
  );
  assert.equal(tasks[1].inputs.NotarizationTimeout, '45');
  const verifyIndex = mac.steps.findIndex((step) =>
    step.bash?.includes(' verify-signed '),
  );
  const packageIndex = mac.steps.findIndex((step) =>
    step.bash?.includes(' package '),
  );
  const publishIndex = mac.steps.findIndex(
    (step) => step.task === 'PublishPipelineArtifact@1',
  );
  assert.ok(
    mac.steps.some((step) =>
      step.bash?.includes('build:desktop:mac --dir --arm64 --x64'),
    ),
  );
  assert.ok(mac.steps.indexOf(loops[0]) < verifyIndex);
  assert.ok(verifyIndex < mac.steps.indexOf(loops[1]));
  assert.ok(
    mac.steps.indexOf(loops[1]) < packageIndex && packageIndex < publishIndex,
  );
  for (const step of mac.steps) {
    assert.notEqual(step.continueOnError, true);
    for (const secret of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      assert.notEqual(step.env?.[secret], `$(${secret})`);
    }
  }
});

const signature =
  'Identifier=com.huabu.app\nAuthority=Developer ID Application: Publisher (ABCDE12345)\nTeamIdentifier=ABCDE12345\nCodeDirectory flags=0x10000(runtime)\nTimestamp=Oct 26, 2026\n';

test('rejects ad-hoc signatures, missing runtime/timestamp, wrong identity or team', () => {
  assert.equal(validateSignature(signature), 'ABCDE12345');
  for (const field of [
    'Authority=Developer ID Application:',
    'TeamIdentifier=',
    'Timestamp=',
    'runtime',
    'com.huabu.app',
  ]) {
    assert.throws(() => validateSignature(signature.replace(field, 'invalid')));
  }
  assert.throws(() => validateSignature(signature, 'OTHER12345'));
});

test('requires Electron JIT entitlements without release debugging', () => {
  validateEntitlements({ 'com.apple.security.cs.allow-jit': true });
  assert.throws(() => validateEntitlements({}));
  assert.throws(() =>
    validateEntitlements({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.get-task-allow': true,
    }),
  );
});

test('archives preserve symlinks and place the app at the ZIP root', () => {
  assert.deepEqual(archiveArguments('/tmp/Huabu.zip'), [
    '-r',
    '-y',
    '/tmp/Huabu.zip',
    'Huabu.app',
  ]);
});

test('preparation uses ad-hoc signing for entitlements, final packaging never re-signs', async () => {
  const config = YAML.parse(
    await readFile(
      new URL('../electron-builder.esrp.yml', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.target, 'dir');
  for (const arch of ['arm64', 'x64']) {
    const options = packagingOptions('/signed/Huabu.app', arch, '/out');
    assert.equal(options.prepackaged, '/signed/Huabu.app');
    assert.equal(options.publish, 'never');
    assert.equal(options.config.mac.identity, null);
    assert.equal(options.config.mac.notarize, false);
    assert.equal(options.config.mac.target, undefined);
  }
  assert.throws(() =>
    packagingOptions('/signed/Huabu.app', 'universal', '/out'),
  );
});

test('installed electron-builder resolves the ESRP overlay and final packaging configuration', async () => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const { getConfig } = builderRequire(
    'app-builder-lib/out/util/config/config.js',
  );
  const desktop = fileURLToPath(new URL('..', import.meta.url));
  const prepared = await getConfig(
    desktop,
    path.join(desktop, 'electron-builder.esrp.yml'),
  );
  assert.equal(prepared.appId, 'com.huabu.app');
  assert.equal(prepared.mac.hardenedRuntime, true);
  assert.equal(prepared.mac.identity, '-');
  assert.equal(prepared.mac.notarize, false);
  assert.equal(prepared.mac.target, 'dir');
  const options = packagingOptions('/signed/Huabu.app', 'arm64', '/release');
  const packaged = await getConfig(desktop, null, options.config);
  assert.equal(packaged.mac.identity, null);
  assert.equal(packaged.mac.notarize, false);
  assert.equal(packaged.directories.output, '/release');
  assert.deepEqual(
    packaged.mac.target.map((target) => target.target),
    ['dmg', 'zip'],
  );
});

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'huabu-apple-release-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directories = [];
  for (const arch of ['arm64', 'x64']) {
    const directory = path.join(root, arch);
    await mkdir(directory);
    const files = [];
    for (const extension of ['zip', 'dmg']) {
      const url = `Huabu-1.2.3-${arch}.${extension}`;
      const bytes = Buffer.from(`signed and stapled ${url}`);
      await writeFile(path.join(directory, url), bytes);
      await writeFile(path.join(directory, `${url}.blockmap`), 'blockmap');
      files.push({
        url,
        size: bytes.length,
        sha512: createHash('sha512').update(bytes).digest('base64'),
      });
    }
    await writeFile(
      path.join(directory, 'latest-mac.yml'),
      YAML.stringify({
        version: '1.2.3',
        files,
        path: files[0].url,
        sha512: files[0].sha512,
        releaseNotes: 'Preserve notes',
      }),
    );
    directories.push(directory);
  }
  return { directories, output: path.join(root, 'release') };
}

test('merges both architectures and preserves final hashes, blockmaps and release notes', async (context) => {
  const { directories, output } = await fixture(context);
  await mergeReleaseMetadata(directories, output, '1.2.3');
  const metadata = YAML.parse(
    await readFile(path.join(output, 'latest-mac.yml'), 'utf8'),
  );
  assert.equal(metadata.files.length, 4);
  assert.equal(metadata.releaseNotes, 'Preserve notes');
  for (const file of metadata.files) {
    assert.equal(
      createHash('sha512')
        .update(await readFile(path.join(output, file.url)))
        .digest('base64'),
      file.sha512,
    );
    assert.equal(
      await readFile(path.join(output, `${file.url}.blockmap`), 'utf8'),
      'blockmap',
    );
  }
});

test('rejects modified artifacts and missing blockmaps before publication', async (context) => {
  const { directories, output } = await fixture(context);
  await writeFile(
    path.join(directories[0], 'Huabu-1.2.3-arm64.zip'),
    'modified',
  );
  await assert.rejects(
    mergeReleaseMetadata(directories, output, '1.2.3'),
    /Incorrect size|Incorrect hash/,
  );
  await assert.rejects(readFile(path.join(output, 'latest-mac.yml')), /ENOENT/);
  const second = await fixture(context);
  await rm(path.join(second.directories[1], 'Huabu-1.2.3-x64.dmg.blockmap'));
  await assert.rejects(
    mergeReleaseMetadata(second.directories, second.output, '1.2.3'),
    /ENOENT/,
  );
});

test('rejects mismatched versions, duplicate filenames and paths', async (context) => {
  const { directories, output } = await fixture(context);
  await assert.rejects(
    mergeReleaseMetadata(directories, output, '9.9.9'),
    /release version/,
  );
  await assert.rejects(
    mergeReleaseMetadata([directories[0], directories[0]], output, '1.2.3'),
    /Duplicate/,
  );
  const filename = path.join(directories[0], 'latest-mac.yml');
  const metadata = YAML.parse(await readFile(filename, 'utf8'));
  metadata.files[0].url = '../outside.zip';
  await writeFile(filename, YAML.stringify(metadata));
  await assert.rejects(
    mergeReleaseMetadata(directories, output, '1.2.3'),
    /basename/,
  );
});
