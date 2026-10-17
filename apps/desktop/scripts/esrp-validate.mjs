// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, readFile, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import YAML from 'yaml';
import { readReceipt, sha256, signingPaths, stages } from './esrp-sign.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { createBlockmap } = builderRequire(
  'app-builder-lib/out/targets/differentialUpdateInfoBuilder.js',
);

export async function generateBlockmap(file) {
  return createBlockmap(file, null, {
    info: { emitArtifactBuildCompleted: async () => {} },
  });
}

export async function validateRelease(root) {
  const { output, version } = JSON.parse(
    await readFile(path.join(root, 'build.json'), 'utf8'),
  );
  const files = signingPaths(output, version);
  const receipts = {};
  for (const stage of stages) {
    receipts[stage] = await readReceipt(path.join(root, stage));
    assert.equal(
      receipts[stage].publisher,
      receipts.app.publisher,
      'All signers must match',
    );
    // electron-builder removes its temporary uninstaller after embedding it.
    if (stage !== 'uninstaller') {
      assert.equal(
        await sha256(files[stage]),
        receipts[stage].sha256.toLowerCase(),
      );
    }
  }
  const bytes = await readFile(files.installer);
  const digest = createHash('sha512').update(bytes).digest('base64');
  const metadata = YAML.parse(
    await readFile(path.join(output, 'latest.yml'), 'utf8'),
  );
  assert.equal(metadata.version, version);
  assert.equal(metadata.path, path.basename(files.installer));
  assert.equal(metadata.sha512, digest);
  assert.equal(metadata.files.length, 1);
  assert.equal(metadata.files[0].url, path.basename(files.installer));
  assert.equal(metadata.files[0].size, bytes.length);
  assert.equal(metadata.files[0].sha512, digest);
  const blockmap = JSON.parse(
    gunzipSync(await readFile(`${files.installer}.blockmap`)),
  );
  assert.equal(blockmap.version, '2');
  assert.ok(blockmap.files.length > 0);
  let offset = 0;
  for (const file of blockmap.files) {
    assert.equal(file.offset, offset);
    assert.equal(file.sizes.length, file.checksums.length);
    offset += file.sizes.reduce((sum, size) => sum + size, 0);
  }
  assert.equal(
    offset,
    bytes.length,
    'Blockmap must cover the complete signed installer',
  );
  const verificationFile = path.join(root, 'blockmap-verification.exe');
  try {
    await copyFile(files.installer, verificationFile);
    await generateBlockmap(verificationFile);
    const expected = JSON.parse(
      gunzipSync(await readFile(`${verificationFile}.blockmap`)),
    );
    assert.deepEqual(
      blockmap,
      expected,
      'Blockmap must match the signed bytes',
    );
  } finally {
    await Promise.all(
      [verificationFile, `${verificationFile}.blockmap`].map(async (file) => {
        try {
          await unlink(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }),
    );
  }
  const feed = YAML.parse(
    await readFile(
      path.join(output, 'win-unpacked', 'resources', 'app-update.yml'),
      'utf8',
    ),
  );
  assert.deepEqual(feed.publisherName, [receipts.app.publisher]);
  console.log(
    'Verified signed binaries, publisher, installer hashes and blockmap coverage',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await validateRelease(process.env.HUABU_ESRP_STATE);
}
