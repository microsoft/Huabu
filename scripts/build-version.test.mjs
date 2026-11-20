// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildVersion,
  isNightlyVersion,
  nightlyVersion,
  readProductVersion,
  resolveBuildVersion,
  resolveNightlyVersion,
  resolveRevision,
} from './build-version.mjs';

const SHA = '0b4438c81f7fb5562dac8f96b19a80302c7f5d15';
const OTHER_SHA = 'b0403c4ff401e9be7ea777988b5aa1d5fbf0a8b4';
const script = fileURLToPath(new URL('./build-version.mjs', import.meta.url));

test('a release build carries its commit as build metadata', () => {
  assert.equal(
    buildVersion({ version: '0.9.2', revision: SHA }),
    '0.9.2+g0b4438c',
  );
  assert.equal(
    buildVersion({ version: '0.9.2-rc.1', revision: SHA }),
    '0.9.2-rc.1+g0b4438c',
  );
  assert.equal(
    buildVersion({ version: '0.9.2', revision: SHA, dirty: true }),
    '0.9.2+g0b4438c.dirty',
  );
});

test('an unknown revision leaves the product version unchanged', () => {
  assert.equal(buildVersion({ version: '0.9.2', revision: null }), '0.9.2');
  assert.equal(
    buildVersion({ version: '0.9.2', revision: 'abc1234' }),
    '0.9.2',
  );
});

test('a nightly version already names its commit', () => {
  const nightly = '0.9.2-nightly.20261120.g0b4438c';
  assert.equal(buildVersion({ version: nightly, revision: SHA }), nightly);
  assert.equal(
    buildVersion({ version: nightly, revision: SHA, dirty: true }),
    `${nightly}+dirty`,
  );
  assert.equal(
    buildVersion({ version: nightly, revision: OTHER_SHA }),
    `${nightly}+gb0403c4`,
  );
});

test('release metadata is kept in front of the commit', () => {
  assert.equal(
    buildVersion({ version: '0.9.2+preview.1', revision: SHA }),
    '0.9.2+preview.1.g0b4438c',
  );
  assert.equal(
    buildVersion({
      version: '0.9.2-rc.1+preview.1',
      revision: SHA,
      dirty: true,
    }),
    '0.9.2-rc.1+preview.1.g0b4438c.dirty',
  );
  assert.equal(
    buildVersion({ version: '0.9.2+preview.1', revision: null }),
    '0.9.2+preview.1',
  );
});

test('a product version never names a commit other than the build revision', () => {
  assert.equal(
    buildVersion({ version: '0.9.2+g0000000', revision: SHA }),
    '0.9.2+g0b4438c',
  );
  assert.equal(
    buildVersion({ version: '0.9.2+preview.1.gb0403c4.dirty', revision: SHA }),
    '0.9.2+preview.1.g0b4438c',
  );
  assert.equal(
    buildVersion({ version: '0.9.2+g0000000', revision: null }),
    '0.9.2',
  );
});

test('a version that is not semver is refused', () => {
  assert.throws(
    () => buildVersion({ version: '0.9.2.1', revision: SHA }),
    /semver/,
  );
});

test('the nightly version uses the Shanghai calendar date and the short SHA', () => {
  // 2026-11-20T17:00Z is already 2026-11-21 in Shanghai (UTC+8).
  const date = new Date('2026-11-20T17:00:00Z');
  const version = nightlyVersion({
    productVersion: '0.9.2',
    revision: SHA,
    date,
  });
  assert.equal(version, '0.9.2-nightly.20261121.g0b4438c');
  assert.ok(isNightlyVersion(version));
  assert.equal(
    nightlyVersion({ productVersion: '0.9.2-rc.1', revision: SHA, date }),
    '0.9.2-nightly.20261121.g0b4438c',
  );
  assert.throws(
    () =>
      nightlyVersion({ productVersion: '0.9.2', revision: 'abc1234', date }),
    /full commit SHA/,
  );
  assert.throws(
    () => nightlyVersion({ productVersion: 'next', revision: SHA, date }),
    /X\.Y\.Z/,
  );
});

test('SOURCE_REVISION replaces Git and is never dirty', () => {
  assert.deepEqual(
    resolveRevision({ SOURCE_REVISION: ` ${SHA.toUpperCase()} ` }),
    {
      revision: SHA,
      dirty: false,
    },
  );
  assert.throws(
    () => resolveRevision({ SOURCE_REVISION: 'main' }),
    /full commit SHA/,
  );
});

test('HUABU_BUILD_VERSION is an identity used exactly as given', () => {
  const nightly = '0.9.2-nightly.20261120.g0b4438c';
  assert.equal(
    resolveBuildVersion({ SOURCE_REVISION: SHA, HUABU_BUILD_VERSION: nightly }),
    nightly,
  );
  for (const identity of ['0.9.2+g0b4438c', '0.9.2+preview.1.g0b4438c']) {
    assert.equal(
      resolveBuildVersion({
        SOURCE_REVISION: SHA,
        HUABU_BUILD_VERSION: ` ${identity}\n`,
      }),
      identity,
    );
  }
  assert.throws(
    () =>
      resolveBuildVersion({
        SOURCE_REVISION: SHA,
        HUABU_BUILD_VERSION: 'next',
      }),
    /HUABU_BUILD_VERSION must be semver/,
  );
  assert.equal(
    resolveBuildVersion({ SOURCE_REVISION: SHA }),
    `${readProductVersion()}+g0b4438c`,
  );
});

test('the CLI prints the build and nightly versions', () => {
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, SOURCE_REVISION: SHA, HUABU_BUILD_VERSION: '' },
    });
  const build = run();
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stdout, `${readProductVersion()}+g0b4438c\n`);
  const nightly = run('nightly');
  assert.equal(nightly.status, 0, nightly.stderr);
  assert.equal(
    nightly.stdout,
    `${resolveNightlyVersion({ SOURCE_REVISION: SHA })}\n`,
  );
  assert.match(nightly.stdout, /^\d+\.\d+\.\d+-nightly\.\d{8}\.g0b4438c\n$/);
  assert.equal(run('release').status, 2);
});
