// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import YAML from 'yaml';
import {
  afterSign,
  handoff,
  readReceipt,
  sha256,
  sign,
  signingPaths,
  stages,
} from './esrp-sign.mjs';
import { generateBlockmap, validateRelease } from './esrp-validate.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'huabu-esrp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function setSigningState(t, root) {
  const previous = process.env.HUABU_ESRP_STATE;
  process.env.HUABU_ESRP_STATE = root;
  t.after(() => {
    if (previous === undefined) delete process.env.HUABU_ESRP_STATE;
    else process.env.HUABU_ESRP_STATE = previous;
  });
}

async function receipt(directory, publisher = 'CN=Test Publisher') {
  await writeFile(
    path.join(directory, 'signed.json'),
    JSON.stringify({
      publisher,
      sha256: await sha256(path.join(directory, 'artifact.exe')),
    }),
  );
}

async function ready(directory) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path.join(directory, 'ready'))) {
    assert.ok(Date.now() < deadline, 'Hook must expose its signing input');
    await setTimeout(10);
  }
}

test(
  'Finish handles build completion between polling checks',
  { skip: process.platform !== 'win32' },
  async (t) => {
    for (const scenario of [
      'already-exited',
      'exit-after-condition',
      'exit-during-process-check',
      'failed-after-condition',
      'missing-exit-code',
    ]) {
      await t.test(scenario, async (t) => {
        const root = await temporaryDirectory(t);
        await writeFile(path.join(root, 'pid'), '12345');
        if (scenario === 'already-exited') {
          await writeFile(path.join(root, 'exit-code'), '0');
        }
        const script = `
          $ErrorActionPreference = 'Stop'
          $global:exitChecks = 0
          $global:signatureChecks = 0
          $global:metadataChecks = 0
          function Test-Path {
            param($LiteralPath)
            if ([IO.Path]::GetFileName($LiteralPath) -eq 'exit-code') {
              $global:exitChecks++
              if ($global:exitChecks -gt 5) { throw 'Finish did not terminate' }
              if ($global:exitChecks -eq 1 -and $env:ESRP_TEST_SCENARIO -in @('exit-after-condition', 'failed-after-condition')) {
                [IO.File]::WriteAllText($LiteralPath, $env:ESRP_TEST_EXIT_CODE)
                return $false
              }
            }
            return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath
          }
          function Get-Process {
            param($Id, $ErrorAction)
            if ($Id -ne 12345) { throw 'Unexpected packaging process ID' }
            if ($env:ESRP_TEST_SCENARIO -eq 'exit-during-process-check') {
              [IO.File]::WriteAllText((Join-Path $env:HUABU_ESRP_STATE 'exit-code'), '0')
            }
            return $null
          }
          function Start-Sleep { param($Seconds) }
          function Get-AuthenticodeSignature {
            param($LiteralPath)
            $global:signatureChecks++
            return [pscustomobject]@{
              Status = 'Valid'
              SignerCertificate = [pscustomobject]@{ Subject = 'CN=Test Publisher' }
              TimeStamperCertificate = [pscustomobject]@{ Subject = 'CN=Test Timestamp' }
            }
          }
          function node {
            param($File)
            $global:metadataChecks++
            $global:LASTEXITCODE = 0
          }
          & $env:ESRP_TEST_CONTROLLER -Action Finish
          if ($global:signatureChecks -ne 4 -or $global:metadataChecks -ne 1) {
            throw 'Finish skipped release validation'
          }
          Write-Output 'FINISH_VALIDATED'
        `;
        const result = spawnSync(
          process.env.TF_BUILD ? 'pwsh.exe' : 'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: {
              ...process.env,
              HUABU_ESRP_STATE: root,
              ESRP_TEST_CONTROLLER: path.join(
                import.meta.dirname,
                'esrp-build.ps1',
              ),
              ESRP_TEST_SCENARIO: scenario,
              ESRP_TEST_EXIT_CODE:
                scenario === 'failed-after-condition' ? '7' : '0',
            },
          },
        );
        assert.ifError(result.error);
        const output = `${result.stdout}\n${result.stderr}`;
        if (scenario === 'failed-after-condition') {
          assert.notEqual(result.status, 0, output);
          assert.match(output, /Desktop packaging failed with exit code 7/);
        } else if (scenario === 'missing-exit-code') {
          assert.notEqual(result.status, 0, output);
          assert.match(output, /packaging process is no longer running/);
        } else {
          assert.equal(result.status, 0, output);
          assert.match(output, /FINISH_VALIDATED/);
        }
      });
    }
  },
);

test('handoff blocks packaging until verified signed bytes are returned', async (t) => {
  const root = await temporaryDirectory(t);
  const original = path.join(root, 'Huabu.exe');
  await writeFile(original, 'unsigned input');
  let finished = false;
  const pending = handoff(original, 'app', root, 5000).then(() => {
    finished = true;
  });
  await ready(path.join(root, 'app'));
  assert.equal(finished, false);
  assert.equal(await readFile(original, 'utf8'), 'unsigned input');
  await writeFile(path.join(root, 'app', 'artifact.exe'), 'signed input');
  await receipt(path.join(root, 'app'));
  await pending;
  assert.equal(await readFile(original, 'utf8'), 'signed input');
  await assert.rejects(handoff(original, 'app', root), /EEXIST/);
});

test('handoff fails closed on unchanged input, corrupted receipt, abort and timeout', async (t) => {
  for (const mode of ['unchanged', 'corrupted', 'abort', 'timeout']) {
    await t.test(mode, async (t) => {
      const root = await temporaryDirectory(t);
      const original = path.join(root, 'Huabu.exe');
      await writeFile(original, 'unsigned');
      const pending = handoff(
        original,
        'app',
        root,
        mode === 'timeout' ? 50 : 5000,
      );
      const rejected = assert.rejects(
        pending,
        /did not change|Invalid ESRP|aborted|Timed out/,
      );
      const directory = path.join(root, 'app');
      await ready(directory);
      if (mode === 'unchanged') await receipt(directory);
      if (mode === 'corrupted') {
        await receipt(directory);
        await writeFile(path.join(directory, 'artifact.exe'), 'tampered');
      }
      if (mode === 'abort') await writeFile(path.join(root, 'abort'), '');
      await rejected;
      assert.equal(await readFile(original, 'utf8'), 'unsigned');
    });
  }
});

test('CI hook rejects unreviewed binaries and repeated signing passes', async (t) => {
  const root = await temporaryDirectory(t);
  setSigningState(t, root);
  await writeFile(
    path.join(root, 'build.json'),
    JSON.stringify({ output: root, version: '1.2.3' }),
  );
  await assert.rejects(
    sign({ path: path.join(root, 'third-party.dll'), hash: 'sha256' }),
    /Unreviewed binary/,
  );
  await assert.rejects(sign({ hash: 'sha1' }), /one SHA-256/);
  await assert.rejects(sign({ hash: 'sha256', isNest: true }), /one SHA-256/);
  assert.equal(
    path.basename(signingPaths(root, '1.2.3').uninstaller),
    'Huabu-Setup-1.2.3.__uninstaller.exe',
  );
});

test('CI hook preserves only the bundled Windows FFmpeg executable', async (t) => {
  const root = await temporaryDirectory(t);
  setSigningState(t, root);
  await writeFile(
    path.join(root, 'build.json'),
    JSON.stringify({ output: root, version: '1.2.3' }),
  );
  const ffmpeg = path.join(
    root,
    'win-unpacked',
    'resources',
    'server',
    'media',
    'win32-x64',
    'ffmpeg.exe',
  );
  await mkdir(path.dirname(ffmpeg), { recursive: true });
  await writeFile(ffmpeg, 'audited third-party FFmpeg bytes');
  const before = await sha256(ffmpeg);
  await sign({ path: ffmpeg, hash: 'sha256' });
  assert.equal(await sha256(ffmpeg), before);
  for (const stage of stages)
    assert.equal(existsSync(path.join(root, stage)), false);
  for (const other of [
    path.join(path.dirname(ffmpeg), 'unexpected.exe'),
    path.join(root, 'win-unpacked', 'resources', 'ffmpeg.exe'),
  ]) {
    await assert.rejects(
      sign({ path: other, hash: 'sha256' }),
      /Unreviewed binary/,
    );
  }
  const base = YAML.parse(
    await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
  );
  assert.ok(
    base.extraResources.some(
      (resource) =>
        resource.from === '../server/dist-bundle/media' &&
        resource.to === 'server/media',
    ),
  );
});

test('electron-builder generates the pre-sign feed without a local certificate', async () => {
  const config = YAML.parse(
    await readFile(
      new URL('../electron-builder.esrp.yml', import.meta.url),
      'utf8',
    ),
  );
  const base = YAML.parse(
    await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
  );
  const { WindowsSignToolManager } = builderRequire(
    'app-builder-lib/out/codeSign/windowsSignToolManager.js',
  );
  const { getAppUpdatePublishConfiguration } = builderRequire(
    'app-builder-lib/out/publish/PublishManager.js',
  );
  const { Platform } = builderRequire('app-builder-lib');
  const manager = new WindowsSignToolManager({
    platformSpecificBuildOptions: config.win,
    getCscLink: () => undefined,
  });
  assert.notEqual(config.win.verifyUpdateCodeSignature, false);
  assert.equal(await manager.computedPublisherName.value, null);
  const appInfo = { updaterCacheDirName: 'huabu-updater', channel: null };
  const feed = await getAppUpdatePublishConfiguration(
    {
      platform: Platform.WINDOWS,
      platformSpecificBuildOptions: config.win,
      config: base,
      info: { config: base, appInfo },
      appInfo,
      expandMacro: (value) => value,
      isForceCodeSigningVerification: true,
      signingManager: { value: Promise.resolve(manager) },
    },
    null,
    1,
    false,
  );
  assert.deepEqual(feed, {
    ...base.publish,
    updaterCacheDirName: 'huabu-updater',
  });
});

test('afterSign preserves the feed and sets the verified publisher before archiving', async (t) => {
  const root = await temporaryDirectory(t);
  setSigningState(t, root);
  await mkdir(path.join(root, 'app'));
  await writeFile(path.join(root, 'app', 'artifact.exe'), 'signed app');
  await receipt(path.join(root, 'app'));
  const resources = path.join(root, 'win-unpacked', 'resources');
  await mkdir(resources, { recursive: true });
  const feed = {
    provider: 'github',
    owner: 'microsoft',
    repo: 'Huabu',
    updaterCacheDirName: 'huabu-updater',
  };
  await writeFile(path.join(resources, 'app-update.yml'), YAML.stringify(feed));
  await afterSign({
    appOutDir: path.dirname(resources),
    electronPlatformName: 'win32',
  });
  assert.deepEqual(
    YAML.parse(await readFile(path.join(resources, 'app-update.yml'), 'utf8')),
    {
      ...feed,
      publisherName: ['CN=Test Publisher'],
    },
  );
  await assert.rejects(
    afterSign({ electronPlatformName: 'darwin' }),
    /Windows-only/,
  );
});

async function releaseFixture(t) {
  const root = await temporaryDirectory(t);
  const output = path.join(root, 'output');
  const version = '1.2.3';
  const files = signingPaths(output, version);
  await writeFile(
    path.join(root, 'build.json'),
    JSON.stringify({ output, version }),
  );
  for (const stage of stages) {
    const directory = path.join(root, stage);
    await mkdir(directory);
    await writeFile(path.join(directory, 'artifact.exe'), `signed ${stage}`);
    await receipt(directory);
    if (stage !== 'uninstaller') {
      await mkdir(path.dirname(files[stage]), { recursive: true });
      await copyFile(path.join(directory, 'artifact.exe'), files[stage]);
    }
  }
  const bytes = await readFile(files.installer);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const metadata = {
    version,
    files: [
      { url: path.basename(files.installer), size: bytes.length, sha512 },
    ],
    path: path.basename(files.installer),
    sha512,
  };
  await writeFile(path.join(output, 'latest.yml'), YAML.stringify(metadata));
  await writeFile(
    path.join(output, 'win-unpacked', 'resources', 'app-update.yml'),
    YAML.stringify({ publisherName: ['CN=Test Publisher'] }),
  );
  await generateBlockmap(files.installer);
  return { root, output, files, metadata };
}

test('release validation checks signed bytes, metadata and actual blockmap checksums', async (t) => {
  const { root, output, files, metadata } = await releaseFixture(t);
  await validateRelease(root);
  assert.equal(existsSync(path.join(root, 'blockmap-verification.exe')), false);
  metadata.files[0].size++;
  await writeFile(path.join(output, 'latest.yml'), YAML.stringify(metadata));
  await assert.rejects(validateRelease(root));
  metadata.files[0].size--;
  await writeFile(path.join(output, 'latest.yml'), YAML.stringify(metadata));
  const blockmap = JSON.parse(
    gunzipSync(await readFile(`${files.installer}.blockmap`)),
  );
  blockmap.files[0].checksums[0] = 'invalid-checksum';
  await writeFile(
    `${files.installer}.blockmap`,
    gzipSync(JSON.stringify(blockmap)),
  );
  await assert.rejects(validateRelease(root), /Blockmap must match/);
  await writeFile(path.join(root, 'app', 'artifact.exe'), 'tampered');
  await assert.rejects(readReceipt(path.join(root, 'app')), /Invalid ESRP/);
});

test('pipeline uses the v6 contract and an opt-in configuration extending existing targets', async () => {
  const pipeline = YAML.parse(
    await readFile(
      new URL('../../../azure-pipelines.yml', import.meta.url),
      'utf8',
    ),
  );
  const windows = pipeline.jobs.find((job) => job.job === 'Windows');
  const loop = windows.steps.find((step) =>
    Object.keys(step)[0].includes('each stage'),
  );
  const steps = Object.values(loop)[0];
  const task = steps.find((step) => step.task === 'EsrpCodeSigning@6');
  assert.equal(task.inputs.FolderPath, '$(HUABU_ESRP_STATE)\\${{ stage }}');
  assert.equal(task.inputs.Pattern, 'artifact.exe');
  assert.equal(task.inputs.UseMinimatch, true);
  for (const [input, variable] of Object.entries({
    ConnectedServiceName: 'CodeSignConnectedServiceName',
    AppRegistrationClientId: 'CodeSignAppRegistrationClientId',
    AppRegistrationTenantId: 'CodeSignAppRegistrationTenantId',
    AuthAKVName: 'CodeSignKeyVaultName',
    esrpClientId: 'CodeSignEsrpClientId',
    AuthSignCertName: 'CodeSignAuthSignCertificateName',
  }))
    assert.equal(task.inputs[input], `$(${variable})`);
  const operations = JSON.parse(task.inputs.inlineOperation);
  assert.deepEqual(
    operations.map((operation) => operation.operationCode),
    ['SigntoolSign', 'SigntoolVerify'],
  );
  assert.ok(
    operations.every(
      (operation) =>
        operation.keyCode === 'CP-230012' &&
        !Array.isArray(operation.parameters),
    ),
  );
  assert.ok(
    windows.steps.find(
      (step) =>
        step.condition === 'always()' && step.pwsh.includes('-Action Stop'),
    ),
  );
  const config = YAML.parse(
    await readFile(
      new URL('../electron-builder.esrp.yml', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(config.extends, './electron-builder.yml');
  assert.equal(config.forceCodeSigning, true);
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, [
    'sha256',
  ]);
  const { resolveFunction } = builderRequire(
    'app-builder-lib/out/util/resolve.js',
  );
  const hook = new URL('./esrp-sign.mjs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  assert.equal(
    await resolveFunction(
      'commonjs',
      fileURLToPath(hook),
      'sign',
      path.dirname(fileURLToPath(hook)),
    ),
    sign,
  );
  assert.equal(
    await resolveFunction(
      'commonjs',
      fileURLToPath(hook),
      'afterSign',
      path.dirname(fileURLToPath(hook)),
    ),
    afterSign,
  );
});
