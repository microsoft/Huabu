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
 *   a working tree that has uncommitted changes to tracked files. Metadata
 *   the product version already carries (a release tag such as
 *   `0.9.2+preview.1`) is kept in front: `0.9.2+preview.1.g<sha7>`. Commit
 *   identifiers (`g<hex>`) and `dirty` in the product version are dropped,
 *   so the only commit a build names is the one it was built from.
 * - A build whose revision is unknown shows its product version without
 *   those commit identifiers.
 *
 * Usage (prints one line):
 *   node scripts/build-version.mjs            # this build's identity
 *   node scripts/build-version.mjs nightly    # nightly version for this commit
 *
 * Inputs from the environment:
 *   SOURCE_REVISION      Full 40-character commit SHA. CI and image builds
 *                        set it; when set, Git is not consulted, so build
 *                        steps that rewrite files are not reported as dirty.
 *   HUABU_BUILD_VERSION  This build's complete identity, used exactly as
 *                        given instead of formatting the package version: a
 *                        nightly version, or an identity this script already
 *                        printed (CI passes it to image builds, which also
 *                        label the image with it). Must be semver.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Time zone whose calendar date numbers nightly builds. */
export const NIGHTLY_TIME_ZONE = 'Asia/Shanghai';

/** Number of SHA characters in `g<sha>` identifiers. */
export const SHORT_SHA_LENGTH = 7;

const FULL_SHA = /^[0-9a-f]{40}$/;
/** Semver with optional build metadata; group 1 is the metadata. */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/** Build metadata identifiers this script owns: a commit, or `dirty`. */
const OWNED_METADATA = /^(?:g[0-9a-f]{7,40}|dirty)$/;
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
 * Build identity from a product version and the revision it was built from.
 *
 * @param {{ version: string, revision: string | null, dirty?: boolean }} input
 *   `version` is the package version (a product version, a release tag's
 *   version with or without build metadata, or a nightly version);
 *   `revision` is the full commit SHA, or null when unknown; `dirty` marks
 *   uncommitted changes.
 * @returns {string} see the module comment for the format
 */
export function buildVersion({ version, revision, dirty = false }) {
  const semver = SEMVER.exec(version);
  if (!semver) throw new Error(`Build version must be semver: ${version}`);
  const sha = normalizeRevision(revision);
  const nightly = NIGHTLY_VERSION.exec(version);
  if (nightly && sha?.startsWith(nightly[5])) {
    return dirty ? `${version}+dirty` : version;
  }
  const [precedence] = version.split('+');
  const metadata = (semver[1]?.split('.') ?? []).filter(
    (identifier) => !OWNED_METADATA.test(identifier),
  );
  if (sha) metadata.push(shortId(sha), ...(dirty ? ['dirty'] : []));
  return metadata.length > 0
    ? `${precedence}+${metadata.join('.')}`
    : precedence;
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
 * @param {string} cwd checkout to run Git in
 * @returns {string | null} trimmed Git output, or null when Git is unavailable
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
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
 * @param {string} cwd checkout to read; defaults to this repository
 * @returns {{ revision: string | null, dirty: boolean }}
 */
export function resolveRevision(env = process.env, cwd = repoRoot) {
  if (env.SOURCE_REVISION?.trim()) {
    const revision = normalizeRevision(env.SOURCE_REVISION);
    if (!revision) {
      throw new Error(
        `SOURCE_REVISION must be a full commit SHA: ${env.SOURCE_REVISION}`,
      );
    }
    return { revision, dirty: false };
  }
  const revision = normalizeRevision(git(['rev-parse', 'HEAD'], cwd));
  if (!revision) return { revision: null, dirty: false };
  const status = git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return { revision, dirty: Boolean(status) };
}

/**
 * The commit whose checkout reproduces this build's source exactly, or null
 * when there is none: the revision is unknown, or tracked files have
 * uncommitted changes, so no commit contains what is being built. The
 * server bundle records this as the revision it runs (`deployedSha()`).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd checkout to read; defaults to this repository
 * @returns {string | null}
 */
export function resolveExactRevision(env = process.env, cwd = repoRoot) {
  const { revision, dirty } = resolveRevision(env, cwd);
  return dirty ? null : revision;
}

/**
 * This build's identity, from the environment and the checkout.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveBuildVersion(env = process.env) {
  const identity = env.HUABU_BUILD_VERSION?.trim();
  if (identity) {
    if (!SEMVER.test(identity)) {
      throw new Error(`HUABU_BUILD_VERSION must be semver: ${identity}`);
    }
    return identity;
  }
  return buildVersion({
    version: readProductVersion(),
    ...resolveRevision(env),
  });
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
