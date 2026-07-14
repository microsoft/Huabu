/**
 * Tests for the legacy ACP-session migration (M6.9 row 1).
 *
 *   ✓ folds a self-contained v3 record into a reconstructed ThreadRecord
 *     (spec kind/workloadType/namespace/binding/recipe + state.sessionId)
 *   ✓ maps the v3 `meta` snapshot 1:1 onto state.metadata
 *   ✓ persists `spec.namespace.name` as the real canvasId (from space.json)
 *   ✓ skips a v2 (recipe-absent) record
 *   ✓ never clobbers a thread already present in threads.json
 *   ✓ renames the source to `.bak`; a second sweep is a no-op
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileThreadStore } from '@agenetes/agenetes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyAcpSessions } from './migrate-acp-sessions.js';

import type { AcpWorkloadSpec } from '../agent/agenetes/drivers.js';
import type { Namespace } from '@agenetes/protocol';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-migrate-acp-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const V3_RECORD = {
  sessionId: 'sess-abc',
  profileId: 'claude-code',
  cwd: '/work/dir',
  updatedAt: 1000,
  bindingRecipe: {
    command: 'claude-code-acp',
    cwd: '/work/dir',
    autoRestart: true,
    alias: 'Claude',
  },
  meta: {
    currentModelId: 'sonnet',
    metaUpdatedAt: 2000,
  },
};

const V2_RECORD = {
  sessionId: 'sess-old',
  profileId: 'legacy',
  cwd: '/work/dir',
  updatedAt: 500,
  // no bindingRecipe → v2 → must be skipped
};

/** Seed a Space with space.json + an acp-sessions.json v3 file. */
function seedCanvas(
  dirName: string,
  canvasId: string,
  records: Record<string, unknown>,
): { namespace: Namespace; sessionsPath: string } {
  const historyRoot = join(tmp, dirName, '.history');
  mkdirSync(historyRoot, { recursive: true });
  writeFileSync(join(tmp, dirName, 'space.json'), JSON.stringify({ canvasId }));
  const sessionsPath = join(historyRoot, 'acp-sessions.json');
  writeFileSync(sessionsPath, JSON.stringify({ schemaVersion: 3, records }));
  return {
    namespace: { name: canvasId, storage: { root: historyRoot } },
    sessionsPath,
  };
}

describe('migrateLegacyAcpSessions', () => {
  it('reconstructs a v3 record into threads.json and skips v2', () => {
    const { namespace, sessionsPath } = seedCanvas('My Canvas', 'canvas-42', {
      'thread-v3': V3_RECORD,
      'thread-v2': V2_RECORD,
    });

    migrateLegacyAcpSessions(tmp);

    const store = new FileThreadStore();
    const v3 = store.get<AcpWorkloadSpec>(namespace, 'thread-v3');
    expect(v3).toBeDefined();
    expect(v3?.spec.kind).toBe('external');
    expect(v3?.spec.workloadType).toBe('Deployment');
    // namespace.name persisted as the real canvasId (from space.json).
    expect(v3?.spec.namespace.name).toBe('canvas-42');
    expect(v3?.spec.binding).toEqual({
      alias: 'Claude',
      profileId: 'claude-code',
    });
    expect(v3?.spec.recipe?.command).toBe('claude-code-acp');
    expect(v3?.state.sessionId).toBe('sess-abc');
    expect(v3?.state.metadata).toMatchObject({ currentModelId: 'sonnet' });
    // reachback env is never a durable spec field.
    expect((v3?.spec as { env?: unknown }).env).toBeUndefined();

    // v2 record skipped.
    expect(store.get(namespace, 'thread-v2')).toBeUndefined();

    // source retired.
    expect(existsSync(sessionsPath)).toBe(false);
    expect(existsSync(`${sessionsPath}.bak`)).toBe(true);
  });

  it('never clobbers a thread already present in threads.json', () => {
    const { namespace } = seedCanvas('My Canvas', 'canvas-42', {
      'thread-v3': V3_RECORD,
    });

    // Pre-seed a live record for the same thread. The spec must satisfy
    // `isPersistableSpec` (threadId / kind / workloadType / namespace) or the
    // store drops it on read back, defeating the clobber guard.
    const store = new FileThreadStore();
    store.upsert(namespace, 'thread-v3', {
      spec: {
        threadId: 'thread-v3',
        kind: 'external',
        workloadType: 'Deployment',
        namespace,
      } as never,
      state: { sessionId: 'live-session' as never },
    });

    migrateLegacyAcpSessions(tmp);

    const kept = store.get(namespace, 'thread-v3');
    expect(kept?.state.sessionId).toBe('live-session');
  });

  it('is idempotent — a second sweep is a no-op', () => {
    seedCanvas('My Canvas', 'canvas-42', { 'thread-v3': V3_RECORD });
    migrateLegacyAcpSessions(tmp);
    expect(() => migrateLegacyAcpSessions(tmp)).not.toThrow();
  });

  it('skips a canvas that has no acp-sessions.json', () => {
    mkdirSync(join(tmp, 'Empty', '.history'), { recursive: true });
    expect(() => migrateLegacyAcpSessions(tmp)).not.toThrow();
    expect(existsSync(join(tmp, 'Empty', '.history', 'threads.json'))).toBe(
      false,
    );
  });
});
