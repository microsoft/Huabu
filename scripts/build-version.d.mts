// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Types for scripts/build-version.mjs, which owns the build identity format;
// see that module's comment for the formats and environment inputs.

/** Time zone whose calendar date numbers nightly builds. */
export const NIGHTLY_TIME_ZONE: string;

/** Number of SHA characters in `g<sha>` identifiers. */
export const SHORT_SHA_LENGTH: number;

/** The value lowercased when it is a full 40-character commit SHA, else null. */
export function normalizeRevision(value: unknown): string | null;

/** Whether `version` uses the `X.Y.Z-nightly.<YYYYMMDD>.g<sha7>` format. */
export function isNightlyVersion(version: string): boolean;

/** Nightly version for a commit; `date` defaults to now. */
export function nightlyVersion(input: {
  productVersion: string;
  revision: string;
  date?: Date;
}): string;

/** Build identity from a product version and the revision it was built from. */
export function buildVersion(input: {
  version: string;
  revision: string | null;
  dirty?: boolean;
}): string;

/** `apps/desktop/package.json`'s version. */
export function readProductVersion(): string;

/**
 * The commit a build comes from: `SOURCE_REVISION` when set (never dirty),
 * otherwise the checkout's HEAD; `revision` is null when neither is known,
 * and `dirty` reports uncommitted changes to tracked files.
 */
export function resolveRevision(
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): {
  revision: string | null;
  dirty: boolean;
};

/**
 * The commit whose checkout reproduces this build's source exactly: null when
 * the revision is unknown or tracked files have uncommitted changes.
 */
export function resolveExactRevision(
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): string | null;

/** This build's identity, from the environment and the checkout. */
export function resolveBuildVersion(env?: NodeJS.ProcessEnv): string;

/** The nightly version for the commit being built. */
export function resolveNightlyVersion(env?: NodeJS.ProcessEnv): string;
