// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./setup.mjs', import.meta.url));

for (const status of [0, 7]) {
  test(`setup handles build exit ${status} without hiding failures`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'huabu-setup-launcher-'));
    try {
      const buildEntry = join(directory, 'build.cjs');
      writeFileSync(
        buildEntry,
        `console.log('test build output'); console.error('test build diagnostic'); process.exit(${status});`,
      );
      const result = spawnSync(process.execPath, [entry, '--help'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          npm_execpath: buildEntry,
          HUABU_DATA_DIR: join(directory, 'data'),
          HUABU_CONFIG_DIR: join(directory, 'config'),
          HUABU_SECRET_BRIDGE: '',
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, status);
      assert.doesNotMatch(result.stderr, /Preparing setup/);
      if (status === 0) {
        assert.match(result.stdout, /Usage: pnpm run setup/);
        assert.doesNotMatch(result.stdout + result.stderr, /test build/);
        assert.doesNotMatch(result.stdout + result.stderr, /injected env/);
      } else {
        assert.match(result.stderr, /Unable to prepare setup/);
        assert.match(result.stderr, /test build output/);
        assert.match(result.stderr, /test build diagnostic/);
        assert.doesNotMatch(result.stdout, /Usage:/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
