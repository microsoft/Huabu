/**
 * Tests for the ACP session persistence store.
 *
 * Coverage:
 *   - readAcpSessionRecord -> null when canvasId missing / file missing
 *   - write + read round-trip
 *   - writeAcpSessionRecord stamps updatedAt and persists across reads
 *   - write replaces the prior record for the same threadId
 *   - multi-thread isolation: writing one threadId leaves others intact
 *   - deleteAcpSessionRecord returns true/false correctly + persists
 *   - corrupt JSON / unknown shape returns null (never throws)
 *   - writeAcpSessionRecord no-op when canvasId is empty
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteAcpSessionRecord,
  readAcpSessionRecord,
  writeAcpSessionMeta,
  writeAcpSessionRecord,
} from './session-store.js';
import { acpSessionsPath, canvasAcpNamespace } from '../../storage/paths.js';
import { setWorkspacePath } from '../../workspace.js';

let tmp: string;
const canvasId = 'cv-test';
const threadId = 'tr-test';
let namespace: ReturnType<typeof canvasAcpNamespace>;
const emptyNamespace = canvasAcpNamespace('');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-acp-sessions-'));
  setWorkspacePath(tmp);
  namespace = canvasAcpNamespace(canvasId);
  // Pre-create the canvas dir AND its .history subdir so raw writeFileSync
  // calls in malformed-input tests don't ENOENT. The session-store API
  // itself goes through atomicWriteJson which mkdirp's automatically.
  mkdirSync(dirname(acpSessionsPath(canvasId)), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('readAcpSessionRecord', () => {
  it('returns null when canvasId is empty', () => {
    expect(readAcpSessionRecord(emptyNamespace, threadId)).toBeNull();
  });

  it('returns null when the file does not exist yet', () => {
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });

  it('returns null when the threadId has no entry', () => {
    writeAcpSessionRecord(namespace, 'other-thread', {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
    });
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    writeFileSync(acpSessionsPath(canvasId), '{this is not json');
    expect(() => readAcpSessionRecord(namespace, threadId)).not.toThrow();
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });

  it('returns null when the record exists but fails shape validation', () => {
    writeFileSync(
      acpSessionsPath(canvasId),
      JSON.stringify({
        schemaVersion: 2,
        records: {
          [threadId]: { sessionId: 'sess-1' /* missing required fields */ },
        },
      }),
    );
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });
});

describe('writeAcpSessionRecord', () => {
  it('persists a record and round-trips through read', () => {
    const before = Date.now();
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
    });
    const after = Date.now();
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
    });
    expect(got!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(got!.updatedAt).toBeLessThanOrEqual(after);
  });

  it('replaces a previous record for the same threadId', () => {
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-old',
      profileId: 'agent-1',
      cwd: '/old',
    });
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-new',
      profileId: 'agent-2',
      cwd: '/new',
    });
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got).toMatchObject({
      sessionId: 'sess-new',
      profileId: 'agent-2',
      cwd: '/new',
    });
  });

  it('leaves records for other threads untouched on rewrite', () => {
    writeAcpSessionRecord(namespace, 'thread-a', {
      sessionId: 'sess-a',
      profileId: 'agent-1',
      cwd: '/a',
    });
    writeAcpSessionRecord(namespace, 'thread-b', {
      sessionId: 'sess-b',
      profileId: 'agent-1',
      cwd: '/b',
    });
    writeAcpSessionRecord(namespace, 'thread-a', {
      sessionId: 'sess-a2',
      profileId: 'agent-1',
      cwd: '/a2',
    });
    expect(readAcpSessionRecord(namespace, 'thread-a')?.sessionId).toBe(
      'sess-a2',
    );
    expect(readAcpSessionRecord(namespace, 'thread-b')?.sessionId).toBe(
      'sess-b',
    );
  });

  it('is a no-op when canvasId is empty', () => {
    expect(() =>
      writeAcpSessionRecord(emptyNamespace, threadId, {
        sessionId: 'sess-1',
        profileId: 'agent-1',
        cwd: '/repo',
      }),
    ).not.toThrow();
    expect(readAcpSessionRecord(emptyNamespace, threadId)).toBeNull();
  });
});

describe('deleteAcpSessionRecord', () => {
  it('returns false when the record does not exist', () => {
    expect(deleteAcpSessionRecord(namespace, threadId)).toBe(false);
  });

  it('returns false when canvasId is empty', () => {
    expect(deleteAcpSessionRecord(emptyNamespace, threadId)).toBe(false);
  });

  it('removes an existing record and returns true', () => {
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
    });
    expect(deleteAcpSessionRecord(namespace, threadId)).toBe(true);
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });

  it('leaves other thread entries intact on delete', () => {
    writeAcpSessionRecord(namespace, 'thread-a', {
      sessionId: 'sess-a',
      profileId: 'agent-1',
      cwd: '/a',
    });
    writeAcpSessionRecord(namespace, 'thread-b', {
      sessionId: 'sess-b',
      profileId: 'agent-1',
      cwd: '/b',
    });
    expect(deleteAcpSessionRecord(namespace, 'thread-a')).toBe(true);
    expect(readAcpSessionRecord(namespace, 'thread-a')).toBeNull();
    expect(readAcpSessionRecord(namespace, 'thread-b')?.sessionId).toBe(
      'sess-b',
    );
  });
});

describe('session meta persistence', () => {
  it('round-trips meta when included in writeAcpSessionRecord', () => {
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
      meta: {
        availableCommands: [
          { name: '/help', description: 'show help', input: null },
        ],
        commandsUpdatedAt: 1700000000000,
        currentModeId: 'agent',
        usage: { used: 100, size: 8000, cost: null },
      },
    });
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got?.meta).toEqual({
      availableCommands: [
        { name: '/help', description: 'show help', input: null },
      ],
      commandsUpdatedAt: 1700000000000,
      currentModeId: 'agent',
      usage: { used: 100, size: 8000, cost: null },
    });
  });

  it('omits meta when not provided', () => {
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
    });
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got).not.toBeNull();
    expect(got!.meta).toBeUndefined();
  });

  it('writeAcpSessionMeta updates only the meta field on an existing record', () => {
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
    });
    const ok = writeAcpSessionMeta(namespace, threadId, {
      currentModeId: 'plan',
      usage: { used: 42, size: 1000, cost: { amount: 0.1, currency: 'USD' } },
    });
    expect(ok).toBe(true);
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got?.sessionId).toBe('sess-1');
    expect(got?.profileId).toBe('agent-1');
    expect(got?.cwd).toBe('/repo');
    expect(got?.meta).toEqual({
      currentModeId: 'plan',
      usage: { used: 42, size: 1000, cost: { amount: 0.1, currency: 'USD' } },
    });
  });

  it('writeAcpSessionMeta returns false when no record exists', () => {
    expect(
      writeAcpSessionMeta(namespace, threadId, { currentModeId: 'x' }),
    ).toBe(false);
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });

  it('writeAcpSessionMeta is a no-op when canvasId is empty', () => {
    expect(writeAcpSessionMeta(emptyNamespace, threadId, { currentModeId: 'x' })).toBe(
      false,
    );
  });

  it('writeAcpSessionMeta(null) clears the field', () => {
    writeAcpSessionRecord(namespace, threadId, {
      sessionId: 'sess-1',
      profileId: 'agent-1',
      cwd: '/repo',
      meta: { currentModeId: 'plan' },
    });
    expect(writeAcpSessionMeta(namespace, threadId, null)).toBe(true);
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got).not.toBeNull();
    expect(got!.meta).toBeUndefined();
  });

  it('drops malformed meta on read while keeping the parent record', () => {
    writeFileSync(
      acpSessionsPath(canvasId),
      JSON.stringify({
        schemaVersion: 2,
        records: {
          [threadId]: {
            sessionId: 'sess-1',
            profileId: 'agent-1',
            cwd: '/repo',
            updatedAt: Date.now(),
            // `meta` field present but with no recognisable fields -
            // sanitizeMeta should return undefined and the parent
            // record should still be readable.
            meta: { nonsense: 'value' },
          },
        },
      }),
    );
    const got = readAcpSessionRecord(namespace, threadId);
    expect(got?.sessionId).toBe('sess-1');
    expect(got?.meta).toBeUndefined();
  });

  it('rejects record entirely when meta is a non-object', () => {
    writeFileSync(
      acpSessionsPath(canvasId),
      JSON.stringify({
        schemaVersion: 2,
        records: {
          [threadId]: {
            sessionId: 'sess-1',
            profileId: 'agent-1',
            cwd: '/repo',
            updatedAt: Date.now(),
            meta: 'not-an-object',
          },
        },
      }),
    );
    expect(readAcpSessionRecord(namespace, threadId)).toBeNull();
  });
});
