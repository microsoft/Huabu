// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The one owner of Huabu's build identity: the semver string a build shows
 * in its UI and tags its container images and nightly releases with.
 *
 * - The product version (`X.Y.Z`, optionally with a prerelease such as
 *   `-rc.1`) lives only in `apps/desktop/package.json`.
 * - A nightly build (desktop nightly release and the daily container image)
 *   is `X.Y.Z-nightly.<YYYYMMDD>.g<sha7>`. The date, in `NIGHTLY_TIME_ZONE`,
 *   keeps nightlies ordered for semver comparison (auto-update); `g<sha7>`
 *   names the commit.
 * - Any other build is its product version plus semver build metadata:
 *   `X.Y.Z+g<sha7>`, with `.dirty` appended when the revision was read from
 *   a working tree that has uncommitted changes to tracked files.
 * - A build whose revision is unknown shows its product version unchanged.
 *
 * Usage (prints one line):
 *   node scripts/build-version.mjs            # this build's identity
 *   node scripts/build-version.mjs nightly    # nightly version for this commit
 *
 * Inputs from the environment:
 *   SOURCE_REVISION      Full 40-character commit SHA. CI and image builds
 *                        set it; when set, Git is not consulted, so build
 *                        steps that rewrite files are not reported as dirty.
 *   HUABU_BUILD_VERSION  Replaces the package version for this build: a
 *                        nightly version, or an identity this script already
 *                        printed (CI passes it to image builds, which also
 *                        label the image with it). Kept as is when it
 *                        already carries build metadata.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Time zone whose calendar date numbers nightly builds. */
export const NIGHTLY_TIME_ZONE = 'Asia/Shanghai';

/** Number of SHA characters in `g<sha>` identifiers. */
export const SHORT_SHA_LENGTH = 7;

const FULL_SHA = /^[0-9a-f]{40}$/;
const PRODUCT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILD_IDENTITY =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const NIGHTLY_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(\d{8})\.g([0-9a-f]+)$/;

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * @param {string} revision full 40-character lowercase commit SHA
 * @returns {string} `g` plus the first `SHORT_SHA_LENGTH` characters
 */
function shortId(revision) {
  return `g${revision.slice(0, SHORT_SHA_LENGTH)}`;
}

/**
 * @param {unknown} value
 * @returns {string | null} the value when it is a full commit SHA, else null
 */
export function normalizeRevision(value) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return FULL_SHA.test(revision) ? revision : null;
}

/**
 * @param {string} version
 * @returns {boolean} whether `version` uses the nightly format
 */
export function isNightlyVersion(version) {
  return NIGHTLY_VERSION.test(version);
}

/**
 * Nightly version for a commit.
 *
 * @param {{ productVersion: string, revision: string, date?: Date }} input
 *   `productVersion` is the package version; only its `X.Y.Z` core is kept.
 *   `date` defaults to now and is read in `NIGHTLY_TIME_ZONE`.
 * @returns {string} `X.Y.Z-nightly.<YYYYMMDD>.g<sha7>`
 */
export function nightlyVersion({
  productVersion,
  revision,
  date = new Date(),
}) {
  const core = productVersion.split(/[+-]/)[0];
  if (!/^\d+\.\d+\.\d+$/.test(core)) {
    throw new Error(`Product version must use X.Y.Z format: ${productVersion}`);
  }
  const sha = normalizeRevision(revision);
  if (!sha)
    throw new Error(`Nightly builds need a full commit SHA: ${revision}`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: NIGHTLY_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${core}-nightly.${parts.year}${parts.month}${parts.day}.${shortId(sha)}`;
}

/**
 * Build identity from a version and the revision it was built from.
 *
 * @param {{ version: string, revision: string | null, dirty?: boolean }} input
 *   `version` is the package version or a nightly version; `revision` is the
 *   full commit SHA, or null when unknown; `dirty` marks uncommitted changes.
 * @returns {string} see the module comment for the format
 */
export function buildVersion({ version, revision, dirty = false }) {
  const sha = normalizeRevision(revision);
  const nightly = NIGHTLY_VERSION.exec(version);
  if (nightly && sha?.startsWith(nightly[5])) {
    return dirty ? `${version}+dirty` : version;
  }
  // Already a complete identity (from an earlier run of this script).
  if (BUILD_IDENTITY.test(version)) return version;
  if (!PRODUCT_VERSION.test(version) && !nightly) {
    throw new Error(
      `Build version must be semver without build metadata: ${version}`,
    );
  }
  if (!sha) return version;
  return `${version}+${shortId(sha)}${dirty ? '.dirty' : ''}`;
}

/** @returns {string} `apps/desktop/package.json`'s version */
export function readProductVersion() {
  const pkg = JSON.parse(
    readFileSync(
      new URL('../apps/desktop/package.json', import.meta.url),
      'utf8',
    ),
  );
  return pkg.version;
}

/**
 * @param {string[]} args
 * @returns {string | null} trimmed Git output, or null when Git is unavailable
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The revision this build comes from: `SOURCE_REVISION` when set (never
 * dirty), otherwise the checkout's HEAD and whether tracked files changed.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ revision: string | null, dirty: boolean }}
 */
export function resolveRevision(env = process.env) {
  if (env.SOURCE_REVISION?.trim()) {
    const revision = normalizeRevision(env.SOURCE_REVISION);
    if (!revision) {
      throw new Error(
        `SOURCE_REVISION must be a full commit SHA: ${env.SOURCE_REVISION}`,
      );
    }
    return { revision, dirty: false };
  }
  const revision = normalizeRevision(git(['rev-parse', 'HEAD']));
  if (!revision) return { revision: null, dirty: false };
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  return { revision, dirty: Boolean(status) };
}

/**
 * This build's identity, from the environment and the checkout.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveBuildVersion(env = process.env) {
  const version = env.HUABU_BUILD_VERSION?.trim() || readProductVersion();
  return buildVersion({ version, ...resolveRevision(env) });
}

/**
 * The nightly version for the commit being built.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveNightlyVersion(env = process.env) {
  const { revision } = resolveRevision(env);
  if (!revision)
    throw new Error('Cannot determine the commit for a nightly build.');
  return nightlyVersion({ productVersion: readProductVersion(), revision });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (command !== undefined && command !== 'nightly')) {
    console.error('Usage: node scripts/build-version.mjs [nightly]');
    process.exit(2);
  }
  console.log(
    command === 'nightly' ? resolveNightlyVersion() : resolveBuildVersion(),
  );
}
