// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'huabu-web-launcher-'));
  try {
    for (const directory of [
      'scripts',
      'packages/client-runtime/dist',
      'apps/server/dist-bundle',
      'node_modules',
    ])
      mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    cpSync(
      new URL('./start-web.mjs', import.meta.url),
      join(root, 'scripts/start-web.mjs'),
    );
    cpSync(
      dirname(require.resolve('dotenv/package.json')),
      join(root, 'node_modules/dotenv'),
      {
        recursive: true,
      },
    );
    // The launcher needs only this port of the separately built runtime.
    writeFileSync(
      join(root, 'packages/client-runtime/dist/bootstrap.js'),
      `import { resolve } from 'node:path';
       export const resolveServerDataDir = (root, configured) => resolve(root, configured || 'apps/server/data');`,
    );
    writeFileSync(
      join(root, 'apps/server/dist-bundle/server.js'),
      `console.log('LAUNCH_RESULT=' + JSON.stringify({
        sha: process.env.HUABU_DEPLOYED_SHA,
        root: process.env.HUABU_REPO_ROOT,
        web: process.env.WEB_DIST_PATH,
        data: process.env.HUABU_DATA_DIR,
      }));`,
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function launch(root, env = {}, gitAvailable = false) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (key.startsWith('HUABU_') || key === 'WEB_DIST_PATH')
      delete inherited[key];
    if (!gitAvailable && key.toLowerCase() === 'path') inherited[key] = '';
  }
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/start-web.mjs')],
    {
      cwd: tmpdir(),
      env: { ...inherited, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout
    .split(/\r?\n/u)
    .find((value) => value.startsWith('LAUNCH_RESULT='));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice('LAUNCH_RESULT='.length));
}

test('starts prebuilt artifacts without Git and preserves the image revision', () => {
  fixture((root) => {
    const sha = 'a'.repeat(40);
    const result = launch(root, { HUABU_DEPLOYED_SHA: sha });
    assert.equal(result.sha, sha);
    assert.equal(result.root, root);
    assert.equal(result.web, join(root, 'apps/web/dist'));
    assert.equal(result.data, join(root, 'apps/server/data'));
  });
});

test('starts without Git or a supplied revision', () => {
  fixture((root) => assert.equal(launch(root).sha, undefined));
});

test('loads a revision from .env while platform settings keep precedence', () => {
  fixture((root) => {
    writeFileSync(join(root, '.env'), `HUABU_DEPLOYED_SHA=${'b'.repeat(40)}\n`);
    assert.equal(launch(root).sha, 'b'.repeat(40));
    const result = launch(root, {
      HUABU_DEPLOYED_SHA: 'c'.repeat(40),
      WEB_DIST_PATH: 'custom/web',
      HUABU_DATA_DIR: join(root, 'persistent-data'),
    });
    assert.equal(result.sha, 'c'.repeat(40));
    assert.equal(result.web, join(root, 'custom/web'));
    assert.equal(result.data, join(root, 'persistent-data'));
  });
});

test('discovers the startup revision in a source checkout', () => {
  fixture((root) => {
    execFileSync('git', ['init', '-q', root]);
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Huabu Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${join(root, 'no-hooks')}`,
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ],
      { cwd: root },
    );
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    assert.equal(launch(root, {}, true).sha, sha);
    assert.equal(
      launch(root, { HUABU_DEPLOYED_SHA: 'd'.repeat(40) }, true).sha,
      'd'.repeat(40),
    );
  });
});
