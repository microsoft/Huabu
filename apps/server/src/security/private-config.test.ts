// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { getDataDir } from '../data-dir.js';
import { getConfigDir, resolveStandaloneMasterKey } from './private-config.js';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'huabu-private-config-'));
  directories.push(directory);
  return {
    HUABU_CONFIG_DIR: join(directory, 'config'),
    HUABU_DATA_DIR: join(directory, 'data'),
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('private standalone master key', () => {
  it('creates a stable 32-byte key outside the data directory', () => {
    const env = fixture();
    const key = resolveStandaloneMasterKey(false, env);
    expect(key.length).toBe(32);
    expect(resolveStandaloneMasterKey(true, env)).toEqual(key);
    expect(readFileSync(join(env.HUABU_CONFIG_DIR, 'master-key'), 'utf8')).toBe(
      key.toString('base64'),
    );
    expect(existsSync(join(env.HUABU_DATA_DIR, 'master-key'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(env.HUABU_CONFIG_DIR).mode & 0o777).toBe(0o700);
      expect(
        statSync(join(env.HUABU_CONFIG_DIR, 'master-key')).mode & 0o777,
      ).toBe(0o600);
    }
  });
  it('never replaces the missing key of an existing encrypted store', () => {
    const env = fixture();
    expect(() => resolveStandaloneMasterKey(true, env)).toThrow(
      'original HUABU_SECRET_KEY',
    );
    expect(existsSync(join(env.HUABU_CONFIG_DIR, 'master-key'))).toBe(false);
  });
  it('rejects malformed keys instead of replacing them', () => {
    const env = fixture();
    resolveStandaloneMasterKey(false, env);
    const path = join(env.HUABU_CONFIG_DIR, 'master-key');
    writeFileSync(path, 'damaged');
    expect(() => resolveStandaloneMasterKey(false, env)).toThrow(
      'HUABU_SECRET_KEY',
    );
    expect(readFileSync(path, 'utf8')).toBe('damaged');
  });
  it.skipIf(process.platform === 'win32')(
    'rejects readable-by-others keys and symlinks',
    () => {
      const env = fixture();
      resolveStandaloneMasterKey(false, env);
      const path = join(env.HUABU_CONFIG_DIR, 'master-key');
      chmodSync(path, 0o644);
      expect(() => resolveStandaloneMasterKey(false, env)).toThrow(
        'permissions',
      );
      chmodSync(path, 0o600);
      rmSync(path);
      const target = join(env.HUABU_CONFIG_DIR, 'target');
      writeFileSync(target, Buffer.alloc(32).toString('base64'), {
        mode: 0o600,
      });
      symlinkSync(target, path);
      expect(() => resolveStandaloneMasterKey(false, env)).toThrow(
        'regular private',
      );
    },
  );
  it('uses an instance-specific default and a source-relative data directory', () => {
    expect(getDataDir({}).replaceAll('\\', '/')).toMatch(/apps\/server\/data$/);
    expect(getConfigDir({ HUABU_DATA_DIR: '/one' })).not.toBe(
      getConfigDir({ HUABU_DATA_DIR: '/two' }),
    );
  });
  it('rejects a cwd-dependent private directory override', () => {
    expect(() => getConfigDir({ HUABU_CONFIG_DIR: './private' })).toThrow(
      'absolute path',
    );
  });
  it('publishes the same complete key for concurrent processes', async () => {
    const env = fixture();
    const program = `
      import { createHash } from 'node:crypto';
      import { resolveStandaloneMasterKey } from './src/security/private-config.ts';
      const key = resolveStandaloneMasterKey(false);
      process.stdout.write(createHash('sha256').update(key).digest('hex'));
    `;
    const outputs = await Promise.all(
      Array.from({ length: 3 }, () =>
        promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', program],
          {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            env: { ...process.env, ...env },
            timeout: 30_000,
          },
        ),
      ),
    );
    expect(new Set(outputs.map(({ stdout }) => stdout)).size).toBe(1);
    expect(outputs[0].stdout).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});
