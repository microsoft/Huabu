/**
 * Persist-stage authored-body CAS guard (data-loss prevention).
 *
 * For node types whose body is user-authored (`bodyOwnership: 'authored'` —
 * note / text), the per-node content PUT is the sole authoritative body writer.
 * When the on-disk body has diverged from the snapshot preprocessing is about
 * to persist (a concurrent tab / device / external / Drive-synced edit),
 * `persist` must NOT write — otherwise it bypasses the content PUT's rev-CAS and
 * silently clobbers the newer body (the reported bug). Derived bodies
 * (`bodyOwnership: 'derived'` — web / pdf / …) are read-only in-app and carry no
 * such guard.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persist } from './persist.js';
import { getCanvasStore } from '../../storage/index.js';
import { setWorkspacePath } from '../../workspace.js';

import type { NormalizeResult } from '../types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-persist-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a canvas with one node whose `.md` body is `content`. */
function seedNode(
  canvasId: string,
  nodeId: string,
  type: string,
  content: string,
): void {
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        { id: nodeId, type, position: { x: 0, y: 0 }, data: { label: 'A' } },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode(nodeId, { nodeId, type, label: 'A', content });
}

function bodyOf(canvasId: string, nodeId: string): string | undefined {
  return getCanvasStore(canvasId).readNode(nodeId)?.content ?? undefined;
}

function normalized(nodeId: string, canonicalContent: string): NormalizeResult {
  return { nodeId, canonicalContent };
}

describe('persist — authored-body CAS guard', () => {
  it('skips (no write) when an authored body diverged from disk', () => {
    seedNode('c1', 'n1', 'note', 'newer-disk-version');
    const store = getCanvasStore('c1');

    // Preprocess snapshot is stale — on-disk body has moved on.
    const result = persist(normalized('n1', 'stale-snapshot'), 'note', store);

    expect(result.contentChanged).toBe(false);
    // The newer on-disk body is preserved — NOT clobbered.
    expect(bodyOf('c1', 'n1')).toBe('newer-disk-version');
  });

  it('still persists a derived body that diverged (no guard)', () => {
    seedNode('c1', 'n1', 'web', 'old-extraction');
    const store = getCanvasStore('c1');

    const result = persist(normalized('n1', 'fresh-extraction'), 'web', store);

    expect(result.contentChanged).toBe(true);
    expect(bodyOf('c1', 'n1')).toBe('fresh-extraction');
  });

  it('creates an authored body when none exists (guard needs an existing body)', () => {
    // No seedNode → no `.md` on disk yet.
    getCanvasStore('c2').write({
      canvasId: 'c2',
      title: null,
      version: 1,
      state: {
        nodes: [{ id: 'n1', type: 'note', position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const store = getCanvasStore('c2');

    const result = persist(normalized('n1', 'first body'), 'note', store);

    expect(result.contentChanged).toBe(true);
    expect(bodyOf('c2', 'n1')).toBe('first body');
  });
});
