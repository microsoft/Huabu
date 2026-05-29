/**
 * Tests for the ACP session persistence store.
 *
 * Coverage:
 *   ✓ readAcpSessionRecord → null when canvasId missing / file missing
 *   ✓ write + read round-trip
 *   ✓ writeAcpSessionRecord stamps updatedAt and persists across reads
 *   ✓ write replaces the prior record for the same threadId
 *   ✓ multi-thread isolation: writing one threadId leaves others intact
 *   ✓ deleteAcpSessionRecord returns true/false correctly + persists
 *   ✓ corrupt JSON / unknown shape returns null (never throws)
 *   ✓ writeAcpSessionRecord no-op when canvasId is empty
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteAcpSessionRecord,
  readAcpSessionRecord,
  writeAcpSessionRecord,
} from './session-store.js';
import { acpSessionsPath } from '../../storage/paths.js';
import { setWorkspacePath } from '../../workspace.js';

let tmp: string;
const canvasId = 'cv-test';
const threadId = 'tr-test';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-acp-sessions-'));
  setWorkspacePath(tmp);
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
    expect(readAcpSessionRecord('', threadId)).toBeNull();
  });

  it('returns null when the file does not exist yet', () => {
    expect(readAcpSessionRecord(canvasId, threadId)).toBeNull();
  });

  it('returns null when the threadId has no entry', () => {
    writeAcpSessionRecord(canvasId, 'other-thread', {
      sessionId: 'sess-1',
      agentletAgentId: 'agent-1',
      cwd: '/repo',
    });
    expect(readAcpSessionRecord(canvasId, threadId)).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    writeFileSync(acpSessionsPath(canvasId), '{this is not json');
    expect(() => readAcpSessionRecord(canvasId, threadId)).not.toThrow();
    expect(readAcpSessionRecord(canvasId, threadId)).toBeNull();
  });

  it('returns null when the record exists but fails shape validation', () => {
    writeFileSync(
      acpSessionsPath(canvasId),
      JSON.stringify({
        schemaVersion: 1,
        records: {
          [threadId]: { sessionId: 'sess-1' /* missing required fields */ },
        },
      }),
    );
    expect(readAcpSessionRecord(canvasId, threadId)).toBeNull();
  });
});

describe('writeAcpSessionRecord', () => {
  it('persists a record and round-trips through read', () => {
    const before = Date.now();
    writeAcpSessionRecord(canvasId, threadId, {
      sessionId: 'sess-1',
      agentletAgentId: 'agent-1',
      cwd: '/repo',
    });
    const after = Date.now();
    const got = readAcpSessionRecord(canvasId, threadId);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      sessionId: 'sess-1',
      agentletAgentId: 'agent-1',
      cwd: '/repo',
    });
    expect(got!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(got!.updatedAt).toBeLessThanOrEqual(after);
  });

  it('replaces a previous record for the same threadId', () => {
    writeAcpSessionRecord(canvasId, threadId, {
      sessionId: 'sess-old',
      agentletAgentId: 'agent-1',
      cwd: '/old',
    });
    writeAcpSessionRecord(canvasId, threadId, {
      sessionId: 'sess-new',
      agentletAgentId: 'agent-2',
      cwd: '/new',
    });
    const got = readAcpSessionRecord(canvasId, threadId);
    expect(got).toMatchObject({
      sessionId: 'sess-new',
      agentletAgentId: 'agent-2',
      cwd: '/new',
    });
  });

  it('leaves records for other threads untouched on rewrite', () => {
    writeAcpSessionRecord(canvasId, 'thread-a', {
      sessionId: 'sess-a',
      agentletAgentId: 'agent-1',
      cwd: '/a',
    });
    writeAcpSessionRecord(canvasId, 'thread-b', {
      sessionId: 'sess-b',
      agentletAgentId: 'agent-1',
      cwd: '/b',
    });
    writeAcpSessionRecord(canvasId, 'thread-a', {
      sessionId: 'sess-a2',
      agentletAgentId: 'agent-1',
      cwd: '/a2',
    });
    expect(readAcpSessionRecord(canvasId, 'thread-a')?.sessionId).toBe(
      'sess-a2',
    );
    expect(readAcpSessionRecord(canvasId, 'thread-b')?.sessionId).toBe(
      'sess-b',
    );
  });

  it('is a no-op when canvasId is empty', () => {
    expect(() =>
      writeAcpSessionRecord('', threadId, {
        sessionId: 'sess-1',
        agentletAgentId: 'agent-1',
        cwd: '/repo',
      }),
    ).not.toThrow();
    expect(readAcpSessionRecord('', threadId)).toBeNull();
  });
});

describe('deleteAcpSessionRecord', () => {
  it('returns false when the record does not exist', () => {
    expect(deleteAcpSessionRecord(canvasId, threadId)).toBe(false);
  });

  it('returns false when canvasId is empty', () => {
    expect(deleteAcpSessionRecord('', threadId)).toBe(false);
  });

  it('removes an existing record and returns true', () => {
    writeAcpSessionRecord(canvasId, threadId, {
      sessionId: 'sess-1',
      agentletAgentId: 'agent-1',
      cwd: '/repo',
    });
    expect(deleteAcpSessionRecord(canvasId, threadId)).toBe(true);
    expect(readAcpSessionRecord(canvasId, threadId)).toBeNull();
  });

  it('leaves other thread entries intact on delete', () => {
    writeAcpSessionRecord(canvasId, 'thread-a', {
      sessionId: 'sess-a',
      agentletAgentId: 'agent-1',
      cwd: '/a',
    });
    writeAcpSessionRecord(canvasId, 'thread-b', {
      sessionId: 'sess-b',
      agentletAgentId: 'agent-1',
      cwd: '/b',
    });
    expect(deleteAcpSessionRecord(canvasId, 'thread-a')).toBe(true);
    expect(readAcpSessionRecord(canvasId, 'thread-a')).toBeNull();
    expect(readAcpSessionRecord(canvasId, 'thread-b')?.sessionId).toBe(
      'sess-b',
    );
  });
});
