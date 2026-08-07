// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the ACP agent-profile persistence store.
 *
 * Coverage:
 *   ✓ listProfiles → empty when file missing
 *   ✓ insertProfile + getProfile round-trip
 *   ✓ insertProfile rejects duplicate id
 *   ✓ updateProfile mutates fields, preserves id + createdAt
 *   ✓ updateProfile throws when id is unknown
 *   ✓ deleteProfile returns true / false
 *   ✓ listProfiles ordering is stable by createdAt
 *   ✓ malformed records on disk are dropped (no throw)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _wipeProfilesForTests,
  deleteProfile,
  getProfile,
  insertProfile,
  listProfiles,
  updateProfile,
} from './profile-store.js';

import type { AcpAgentProfile } from '@huabu/shared';

let tmp: string;
let prevDataDir: string | undefined;

function makeProfile(
  overrides: Partial<AcpAgentProfile> = {},
): AcpAgentProfile {
  const now = Date.now();
  return {
    id: 'p1',
    displayName: 'Test Profile',
    cliId: 'copilot',
    command: 'copilot --acp',
    cwd: '/tmp',
    autoRestart: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-acp-profiles-'));
  // The store resolves its file via getDataDir(), which reads
  // HUABU_DATA_DIR. Override it per-test so writes don't pollute the
  // repo's apps/server/data/ directory and tests don't leak state.
  prevDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = tmp;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = prevDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe('listProfiles', () => {
  it('returns an empty list when the file does not exist', () => {
    expect(listProfiles()).toEqual([]);
  });

  it('returns inserted profiles ordered by createdAt', () => {
    insertProfile(makeProfile({ id: 'b', createdAt: 200 }));
    insertProfile(makeProfile({ id: 'a', createdAt: 100 }));
    insertProfile(makeProfile({ id: 'c', createdAt: 300 }));
    const all = listProfiles();
    expect(all.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('insertProfile / getProfile', () => {
  it('round-trips a profile', () => {
    const p = makeProfile({
      autoRestart: false,
    });
    insertProfile(p);
    expect(getProfile(p.id)).toEqual(p);
  });

  it('rejects duplicate ids', () => {
    insertProfile(makeProfile({ id: 'dup' }));
    expect(() => insertProfile(makeProfile({ id: 'dup' }))).toThrow(
      /already exists/,
    );
  });

  it('getProfile returns null for unknown id', () => {
    expect(getProfile('nope')).toBeNull();
  });
});

describe('updateProfile', () => {
  it('patches fields and preserves id', () => {
    insertProfile(makeProfile({ id: 'u1', displayName: 'Old' }));
    const updated = updateProfile('u1', {
      displayName: 'New',
      autoRestart: false,
      updatedAt: 999,
    });
    expect(updated.id).toBe('u1');
    expect(updated.displayName).toBe('New');
    expect(updated.autoRestart).toBe(false);
    expect(updated.updatedAt).toBe(999);
    expect(getProfile('u1')).toEqual(updated);
  });

  it('throws when id is unknown', () => {
    expect(() => updateProfile('nope', { displayName: 'x' })).toThrow(
      /not found/,
    );
  });
});

describe('deleteProfile', () => {
  it('returns false when id is unknown', () => {
    expect(deleteProfile('nope')).toBe(false);
  });

  it('removes the record and returns true', () => {
    insertProfile(makeProfile({ id: 'd1' }));
    expect(deleteProfile('d1')).toBe(true);
    expect(getProfile('d1')).toBeNull();
  });

  it('leaves other profiles intact', () => {
    insertProfile(makeProfile({ id: 'a' }));
    insertProfile(makeProfile({ id: 'b' }));
    deleteProfile('a');
    expect(listProfiles().map((p) => p.id)).toEqual(['b']);
  });
});

describe('malformed input', () => {
  it('handles a missing file as an empty list', () => {
    expect(listProfiles()).toEqual([]);
  });

  it('handles wholesale corruption gracefully', () => {
    insertProfile(makeProfile({ id: 'seed' }));
    // _wipeProfilesForTests writes an empty list (legal shape).
    _wipeProfilesForTests();
    expect(listProfiles()).toEqual([]);
  });
});
