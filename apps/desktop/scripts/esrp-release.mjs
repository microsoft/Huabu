// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { createBlockmap } = builderRequire(
  'app-builder-lib/out/targets/differentialUpdateInfoBuilder.js',
);
const { parseDn } = createRequire(require.resolve('electron-updater'))(
  'builder-util-runtime',
);

/**
 * Fail the release unless the installer's signer is one the packaged app will
 * accept as its update publisher.
 *
 * The installed app compares every update's Authenticode signer with the
 * `publisherName` in its own `app-update.yml` and refuses a mismatch. A
 * release signed by anyone else would therefore install, and then never
 * update again. The comparison here is electron-updater's own.
 */
export async function assertExpectedPublisher(output, signerSubject) {
  const config = YAML.parse(
    await readFile(
      path.join(output, 'win-unpacked', 'resources', 'app-update.yml'),
      'utf8',
    ),
  );
  const names = [config?.publisherName ?? []].flat();
  assert.ok(
    names.length > 0 && names.every((name) => typeof name === 'string'),
    'The packaged app names no update publisher',
  );
  const signer = parseDn(signerSubject);
  const accepted = names.some((name) => {
    const expected = parseDn(name);
    return expected.size
      ? [...expected.keys()].every(
          (key) => expected.get(key) === signer.get(key),
        )
      : name === signer.get('CN');
  });
  assert.ok(
    accepted,
    `Installer signed by "${signerSubject}", but the app accepts updates only from: ${names.join(' | ')}`,
  );
  console.log(`Installer signer is an accepted update publisher`);
}

export async function refreshInstallerMetadata(output, version) {
  assert.match(
    version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  const installerName = `Huabu-Setup-${version}.exe`;
  const metadataPath = path.join(output, 'latest.yml');
  const metadata = YAML.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata?.version, version, 'Unexpected release version');
  assert.equal(metadata.path, installerName, 'Unexpected installer path');
  assert.equal(metadata.files?.length, 1, 'Expected one Windows x64 installer');
  assert.equal(
    metadata.files[0].url,
    installerName,
    'Unexpected installer URL',
  );
  assert.equal(
    metadata.packages,
    undefined,
    'NSIS web packages are not supported',
  );
  assert.equal(
    metadata.files[0].blockMapSize,
    undefined,
    'Expected an external blockmap',
  );

  // Signing changes the installer bytes after electron-builder generated its update assets.
  const { size, sha512 } = await createBlockmap(
    path.join(output, installerName),
    null,
    { info: { emitArtifactBuildCompleted: async () => {} } },
  );
  assert.ok(
    size > 0 && typeof sha512 === 'string',
    'Invalid installer metadata',
  );
  metadata.sha512 = sha512;
  metadata.files[0].sha512 = sha512;
  metadata.files[0].size = size;
  await writeFile(metadataPath, YAML.stringify(metadata));
  console.log(`Updated installer hashes and blockmap: ${installerName}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error(
      'Expected the Windows release output directory and the installer signer subject',
    );
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  await assertExpectedPublisher(path.resolve(process.argv[2]), process.argv[3]);
  await refreshInstallerMetadata(path.resolve(process.argv[2]), version);
}
