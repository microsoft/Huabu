// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'tsup';
import { describe, expect, it } from 'vitest';

import bundleConfig from '../tsup.config.js';

const configured =
  typeof bundleConfig === 'function' ? await bundleConfig({}) : bundleConfig;
const configurations = Array.isArray(configured) ? configured : [configured];

describe('server bundle runtime', () => {
  it.each(configurations)(
    'loads prefix-only Node built-ins with the $outDir configuration',
    async (configuration) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'huabu-bundle-test-'));
      try {
        const entry = path.join(directory, 'probe.ts');
        writeFileSync(
          entry,
          `import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(':memory:');
writeFileSync(process.argv[2], JSON.stringify(database.prepare('SELECT 42 AS answer').get()));
database.close();
`,
        );
        const outDir = path.join(directory, 'dist');
        // Exercise the production bundler options with a small real entry.
        // Only redirect artifacts and omit production asset copying.
        await build({
          ...configuration,
          config: false,
          entry: { probe: entry },
          outDir,
          outExtension: () => ({ js: '.mjs' }),
          onSuccess: undefined,
          silent: true,
        });
        const resultFile = path.join(directory, 'result.json');
        execFileSync(
          process.execPath,
          [path.join(outDir, 'probe.mjs'), resultFile],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
          answer: 42,
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
