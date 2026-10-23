// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { resolveServerDataDir } from '@huabu/client-runtime';

import { getDataDir } from './data-dir.js';
import { getConfigDir } from './security/private-config.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('instance data directory', () => {
  it('uses the same root-relative override as standalone startup, including dotenv values', () => {
    const env = parse('HUABU_DATA_DIR=./instance-data');
    const expected = resolveServerDataDir(root, env.HUABU_DATA_DIR);
    expect(getDataDir(env)).toBe(expected);
    expect(getConfigDir(env)).toBe(getConfigDir({ HUABU_DATA_DIR: expected }));
  });

  it.each(['.', 'apps/server', 'apps/web'])(
    'resolves the same data and private configuration from %s',
    (directory) => {
      const source = `
        import { getDataDir } from ${JSON.stringify(new URL('./data-dir.ts', import.meta.url).href)};
        import { getConfigDir } from ${JSON.stringify(new URL('./security/private-config.ts', import.meta.url).href)};
        const env = { HUABU_DATA_DIR: './instance-data' };
        console.log(JSON.stringify({ data: getDataDir(env), config: getConfigDir(env) }));
      `;
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          source,
        ],
        { cwd: resolve(root, directory), encoding: 'utf8', timeout: 10_000 },
      );
      const env = { HUABU_DATA_DIR: './instance-data' };
      expect(JSON.parse(output)).toEqual({
        data: resolve(root, 'instance-data'),
        config: getConfigDir(env),
      });
    },
  );
});
