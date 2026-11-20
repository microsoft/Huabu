// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The read version a client quotes back when it writes.
 *
 * Opaque to callers: `b1.<lineage>.<version>`. The lineage names one unbroken
 * history of a Space's per-node version stamps, so a version is only
 * comparable with another from the same lineage; the version is the Space
 * record version the client had read.
 */

export interface Basis {
  readonly lineage: string;
  readonly version: number;
}

const BASIS_PATTERN =
  /^b1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9]\d{0,15})$/;

export function encodeBasis(lineage: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('Basis version must be a non-negative safe integer');
  }
  const encoded = `b1.${lineage.toLowerCase()}.${version}`;
  if (!BASIS_PATTERN.test(encoded)) {
    throw new TypeError('Basis lineage must be a UUID');
  }
  return encoded;
}

/** The decoded basis, or null when the string is not one this Server issued. */
export function parseBasis(value: string): Basis | null {
  if (typeof value !== 'string') return null;
  const match = BASIS_PATTERN.exec(value);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return null;
  return { lineage: match[1] as string, version };
}
