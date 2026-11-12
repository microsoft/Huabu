// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import YAML from 'yaml';
import { refreshInstallerMetadata } from './esrp-release.mjs';

const pipeline = YAML.parse(
  await readFile(
    new URL('../../../azure-pipelines.yml', import.meta.url),
    'utf8',
  ),
);
const windows = pipeline.jobs.find((job) => job.job === 'Windows');

test('macOS remains enabled by default and can be skipped for Windows signing validation', () => {
  assert.deepEqual(
    pipeline.parameters.find(({ name }) => name === 'buildMacOS'),
    {
      name: 'buildMacOS',
      displayName: 'Build macOS alongside Windows',
      type: 'boolean',
      default: true,
    },
  );
  assert.equal(
    pipeline.jobs.find(({ job }) => job === 'macOS').condition,
    'and(succeeded(), ${{ parameters.buildMacOS }})',
  );
  assert.equal(windows.condition, undefined);
});

async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'huabu-installer-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const version = '1.2.3';
  const name = `Huabu-Setup-${version}.exe`;
  const installer = path.join(output, name);
  await writeFile(installer, randomBytes(128 * 1024));
  const metadata = {
    version,
    files: [
      {
        url: name,
        sha512: 'before-signing',
        size: 1,
        isAdminRightsRequired: true,
      },
    ],
    path: name,
    sha512: 'before-signing',
    releaseDate: '2026-10-19T00:00:00.000Z',
    releaseNotes: 'Preserve release notes',
  };
  const metadataFile = path.join(output, 'latest.yml');
  await writeFile(metadataFile, YAML.stringify(metadata));
  return { output, version, installer, metadata, metadataFile };
}

test('refresh replaces pre-sign hashes and blockmap while preserving release fields and installer bytes', async (t) => {
  const { output, version, installer, metadata, metadataFile } =
    await fixture(t);
  const app = path.join(output, 'win-unpacked', 'Huabu.exe');
  await mkdir(path.dirname(app));
  await writeFile(app, 'unchanged application');
  await refreshInstallerMetadata(output, version);
  const beforeMap = await readFile(`${installer}.blockmap`);
  await appendFile(installer, 'simulated appended Authenticode bytes');
  const bytes = await readFile(installer);
  await refreshInstallerMetadata(output, version);
  const updated = YAML.parse(await readFile(metadataFile, 'utf8'));
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  assert.deepEqual(updated, {
    ...metadata,
    sha512,
    files: [{ ...metadata.files[0], sha512, size: bytes.length }],
  });
  assert.deepEqual(await readFile(installer), bytes);
  assert.equal(await readFile(app, 'utf8'), 'unchanged application');
  const mapBytes = await readFile(`${installer}.blockmap`);
  assert.notDeepEqual(mapBytes, beforeMap);
  const map = JSON.parse(gunzipSync(mapBytes));
  assert.equal(map.version, '2');
  assert.equal(map.files.length, 1);
  assert.equal(map.files[0].offset, 0);
  assert.equal(map.files[0].sizes.length, map.files[0].checksums.length);
  assert.equal(
    map.files[0].sizes.reduce((sum, size) => sum + size, 0),
    bytes.length,
  );
  await refreshInstallerMetadata(output, version);
  assert.deepEqual(await readFile(`${installer}.blockmap`), mapBytes);
});

test('refresh rejects mismatched release assets without rewriting metadata', async (t) => {
  for (const scenario of [
    'version',
    'path',
    'url',
    'multiple-files',
    'web-package',
    'embedded-blockmap',
    'missing-installer',
  ]) {
    await t.test(scenario, async (t) => {
      const { output, version, installer, metadata, metadataFile } =
        await fixture(t);
      if (scenario === 'version') metadata.version = '9.9.9';
      if (scenario === 'path') metadata.path = 'unexpected.exe';
      if (scenario === 'url') metadata.files[0].url = '../unexpected.exe';
      if (scenario === 'multiple-files')
        metadata.files.push({ ...metadata.files[0] });
      if (scenario === 'web-package') metadata.packages = {};
      if (scenario === 'embedded-blockmap') metadata.files[0].blockMapSize = 1;
      if (scenario === 'missing-installer') await rm(installer);
      const original = YAML.stringify(metadata);
      await writeFile(metadataFile, original);
      await assert.rejects(refreshInstallerMetadata(output, version));
      assert.equal(await readFile(metadataFile, 'utf8'), original);
    });
  }
});

test('pipeline signs only the exact final installer using the six original variables', () => {
  const buildIndex = windows.steps.findIndex(
    (step) => step.displayName === 'Build desktop installer',
  );
  const signIndex = windows.steps.findIndex(
    (step) => step.task === 'EsrpCodeSigning@6',
  );
  const refreshIndex = windows.steps.findIndex((step) =>
    step.pwsh?.includes('node .\\apps\\desktop\\scripts\\esrp-release.mjs'),
  );
  const publishIndex = windows.steps.findIndex(
    (step) => step.task === 'PublishPipelineArtifact@1',
  );
  assert.ok(
    buildIndex >= 0 &&
      buildIndex < signIndex &&
      signIndex < refreshIndex &&
      refreshIndex < publishIndex,
  );
  assert.match(
    windows.steps[buildIndex].pwsh,
    /pnpm run build:desktop:win\r?\n/,
  );
  assert.equal(
    windows.steps.filter((step) => step.task?.startsWith('EsrpCodeSigning@'))
      .length,
    1,
  );
  const { inputs } = windows.steps[signIndex];
  assert.equal(
    inputs.FolderPath,
    '$(Build.SourcesDirectory)/../huabu-electron-out',
  );
  assert.equal(inputs.Pattern, '$(WindowsInstallerName)');
  assert.equal(inputs.UseMinimatch, true);
  assert.equal(inputs.useMsiAuthentication, true);
  for (const [input, variable] of Object.entries({
    ConnectedServiceName: 'CodeSignConnectedServiceName',
    AppRegistrationClientId: 'CodeSignAppRegistrationClientId',
    AppRegistrationTenantId: 'CodeSignAppRegistrationTenantId',
    AuthAKVName: 'CodeSignKeyVaultName',
    esrpClientId: 'CodeSignEsrpClientId',
    AuthSignCertName: 'CodeSignAuthSignCertificateName',
  }))
    assert.equal(inputs[input], `$(${variable})`);
  assert.equal(
    inputs.ServiceEndpointUrl,
    'https://api.esrp.microsoft.com/api/v2',
  );
  const operations = JSON.parse(inputs.inlineOperation);
  assert.deepEqual(
    operations.map(({ keyCode, operationCode }) => [keyCode, operationCode]),
    [
      ['CP-230012', 'SigntoolSign'],
      ['CP-230012', 'SigntoolVerify'],
    ],
  );
  assert.ok(operations.every(({ parameters }) => !Array.isArray(parameters)));
  assert.match(operations[0].parameters.TimeStamp, /\/tr .*\/td sha256/);
  assert.ok(
    windows.steps.some((step) =>
      step.pwsh?.includes(
        'variable=WindowsInstallerName]Huabu-Setup-${version}.exe',
      ),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(windows),
    /esrp-client|esrp-sign|esrp-build|electron-builder\.esrp|SYSTEM_ACCESSTOKEN|HUABU_ESRP_STATE|Start-Process/,
  );
});

test('Windows generates the SBOM in the complete release output before publishing', () => {
  const validateIndex = windows.steps.findIndex(
    (step) => step.displayName === 'Validate Windows release assets',
  );
  const manifestSteps = windows.steps.filter(
    (step) => step.task === 'ManifestGeneratorTask@0',
  );
  assert.equal(manifestSteps.length, 1);
  const manifest = manifestSteps[0];
  assert.equal(windows.steps.indexOf(manifest), validateIndex + 1);
  assert.ok(validateIndex >= 0);
  assert.equal(manifest.displayName, 'Generate SBOM');
  assert.deepEqual(manifest.inputs, {
    BuildDropPath: '$(Build.SourcesDirectory)/../huabu-electron-out',
  });
  const publish = windows.steps[validateIndex + 2];
  assert.equal(publish.task, 'PublishPipelineArtifact@1');
  assert.deepEqual(publish.inputs, {
    targetPath: manifest.inputs.BuildDropPath,
    artifact: 'huabu-windows',
    publishLocation: 'pipeline',
  });
});

test(
  'signature gate rejects unsigned, untimestamped or unchanged installers before metadata refresh',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const step = windows.steps.find(
      (step) =>
        step.displayName ===
        'Verify installer signature and refresh update metadata',
    );
    for (const scenario of [
      'valid',
      'invalid',
      'missing-signer',
      'missing-timestamp',
      'unchanged',
      'refresh-failure',
    ]) {
      await t.test(scenario, () => {
        const script = `
        $ErrorActionPreference = 'Stop'
        function Get-AuthenticodeSignature {
          param($LiteralPath)
          [pscustomobject]@{
            Status = $(if ($env:TEST_SCENARIO -eq 'invalid') { 'NotSigned' } else { 'Valid' })
            SignerCertificate = $(if ($env:TEST_SCENARIO -ne 'missing-signer') { [pscustomobject]@{ Subject = 'Test Publisher' } })
            TimeStamperCertificate = $(if ($env:TEST_SCENARIO -ne 'missing-timestamp') { [pscustomobject]@{ Subject = 'Timestamp' } })
          }
        }
        function Get-FileHash {
          param($LiteralPath, $Algorithm)
          @{ Hash = $(if ($env:TEST_SCENARIO -eq 'unchanged') { 'before' } else { 'after' }) }
        }
        function node {
          $global:LASTEXITCODE = $(if ($env:TEST_SCENARIO -eq 'refresh-failure') { 7 } else { 0 })
          Write-Output 'METADATA_REFRESH_CALLED'
        }
        ${step.pwsh}
        Write-Output 'VALIDATED'
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
            timeout: 30000,
            env: {
              ...process.env,
              TEST_SCENARIO: scenario,
              BUILD_SOURCESDIRECTORY: 'C:\\agent\\source',
              WINDOWS_INSTALLER_NAME: 'Huabu-Setup-1.2.3.exe',
              UNSIGNED_INSTALLER_HASH: 'before',
            },
          },
        );
        assert.ifError(result.error);
        if (scenario === 'valid') {
          assert.equal(result.status, 0, result.stderr);
          assert.match(
            result.stdout,
            /METADATA_REFRESH_CALLED[\s\S]*VALIDATED/,
          );
        } else {
          assert.notEqual(result.status, 0);
          assert.doesNotMatch(result.stdout, /VALIDATED/);
          if (scenario === 'refresh-failure') assert.equal(result.status, 7);
          else assert.doesNotMatch(result.stdout, /METADATA_REFRESH_CALLED/);
        }
      });
    }
  },
);
