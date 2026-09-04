// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The capability matrix (proposal §6.4.2, disposition A).
 *
 * What is worth asserting is not the contents — those change as features do —
 * but that the matrix stays a *declaration an operator can act on*: every
 * entry names a backend that exists, the Disk profile loses nothing, and an
 * unavailable feature is reported rather than raised.
 */

import { describe, expect, it } from 'vitest';

import {
  describeUnavailableCapabilities,
  hasStorageCapability,
  STORAGE_CAPABILITIES,
  unavailableCapabilities,
} from './capabilities.js';
import { validateStorageProfile } from './profile.js';

import type { StorageProfile } from './profile.js';

const DISK: StorageProfile = {
  structured: { kind: 'disk' },
  blobs: { kind: 'disk' },
};

/**
 * A profile naming a structured backend that has no adapter.
 *
 * The matrix has to answer for one before it exists — that is the point of
 * declaring rather than discovering — so this stands in for the first backend
 * that keeps Spaces in tables.
 */
const TABLES: StorageProfile = {
  structured: { kind: 'sqlite' },
  blobs: { kind: 'disk' },
};

describe('storage capability matrix', () => {
  it('lists only real, identifiable capabilities', () => {
    const ids = STORAGE_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const capability of STORAGE_CAPABILITIES) {
      expect(capability.backends.length).toBeGreaterThan(0);
      // A capability nothing can serve is not a limitation, it is a removed
      // feature; a capability every backend serves does not belong here.
      expect(capability.summary).not.toHaveLength(0);
      expect(capability.rationale).not.toHaveLength(0);
    }
  });

  it('offers every capability on the Disk profile', () => {
    expect(unavailableCapabilities(DISK)).toEqual([]);
    expect(describeUnavailableCapabilities(DISK)).toEqual([]);
  });

  it('answers for a backend whose adapter is not selectable yet', () => {
    const missing = unavailableCapabilities(TABLES);

    // Every entry is Disk-only today, so a structured backend that is not
    // Disk loses all of them. The assertion is the shape, not the count.
    expect(missing).toEqual(STORAGE_CAPABILITIES);
    expect(hasStorageCapability(TABLES, 'reveal-space-folder')).toBe(false);
    expect(hasStorageCapability(DISK, 'reveal-space-folder')).toBe(true);
  });

  it('treats an unknown id as available rather than guessing', () => {
    // The matrix is an exception list. A feature nobody wrote down is
    // portable by construction, and inventing a refusal for it would make
    // adding a portable feature a matrix edit.
    expect(hasStorageCapability(TABLES, 'something-portable')).toBe(true);
  });

  it('reports capability gaps separately from profile selectability', () => {
    // The matrix describes what SQLite lacks regardless of whether the
    // preview can be selected. Validation rejects it at the separate
    // production-readiness gate.
    expect(describeUnavailableCapabilities(TABLES).length).toBeGreaterThan(0);
    expect(() => validateStorageProfile(TABLES)).toThrow(/not selectable yet/);
    expect(() => validateStorageProfile(DISK)).not.toThrow();
  });

  it('describes each loss in operator terms', () => {
    const lines = describeUnavailableCapabilities(TABLES);

    for (const capability of STORAGE_CAPABILITIES) {
      const line = lines.find((entry) => entry.startsWith(`${capability.id}:`));
      expect(line).toBeDefined();
      // The id to search for, what is lost, and why it cannot be emulated.
      expect(line).toContain(capability.summary);
      expect(line).toContain('sqlite');
    }
  });
});
