// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { persist } from './persist.js';
import { project } from './project.js';
import canvasRoutes from '../../canvas/canvas.route.js';
import { getCanvasStore, getStructuredStore } from '../../storage/index.js';
import { setWorkspacePath } from '../../workspace.js';

import type { NormalizeResult } from '../types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-persist-'));
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
  it('skips (no write) when an authored body diverged from disk', async () => {
    seedNode('c1', 'n1', 'note', 'newer-disk-version');
    const store = getCanvasStore('c1');

    // Preprocess snapshot is stale — on-disk body has moved on.
    const result = await persist(
      normalized('n1', 'stale-snapshot'),
      'note',
      'authored',
      store,
    );

    expect(result.contentChanged).toBe(false);
    // The newer on-disk body is preserved — NOT clobbered.
    expect(bodyOf('c1', 'n1')).toBe('newer-disk-version');
  });

  it('still persists a derived body that diverged (no guard)', async () => {
    seedNode('c1', 'n1', 'web', 'old-extraction');
    const store = getCanvasStore('c1');

    const result = await persist(
      normalized('n1', 'fresh-extraction'),
      'web',
      'derived',
      store,
    );

    expect(result.contentChanged).toBe(true);
    expect(bodyOf('c1', 'n1')).toBe('fresh-extraction');
    expect(result.ack).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      recordChanged: true,
    });
    expect(getCanvasStore('c1').read()?.version).toBe(2);
    const rows = getCanvasStore('c1').readDeltaLogSince(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commit).toMatchObject({
      commitId: result.ack?.commitId,
      originator: { source: 'system' },
    });
    expect(result.commit).toEqual(rows[0]?.commit);
    expect(
      (await getStructuredStore().space('c1').nodes.read('n1'))?.revision,
    ).toBe(result.recordRevision);
  });

  it('acknowledges a semantic no-op without version, row, or write', async () => {
    seedNode('noop', 'n1', 'web', 'unchanged');

    const result = await persist(
      normalized('n1', 'unchanged'),
      'web',
      'derived',
      getCanvasStore('noop'),
    );

    expect(result).toMatchObject({
      contentChanged: false,
      ack: { fromVersion: 1, toVersion: 1, recordChanged: false },
      commit: { fromVersion: 1, toVersion: 1, recordChanged: false },
    });
    expect(getCanvasStore('noop').read()?.version).toBe(1);
    expect(getCanvasStore('noop').readDeltaLogSince(0)).toEqual([]);
  });

  it('creates an authored body when none exists (guard needs an existing body)', async () => {
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

    const result = await persist(
      normalized('n1', 'first body'),
      'note',
      'authored',
      store,
    );

    expect(result.contentChanged).toBe(true);
    expect(bodyOf('c2', 'n1')).toBe('first body');
  });

  it('does not recreate a missing sidecar when preprocessing requires one', async () => {
    getCanvasStore('c3').write({
      canvasId: 'c3',
      title: null,
      version: 1,
      state: {
        nodes: [
          { id: 'pdf1', type: 'pdf', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const store = getCanvasStore('c3');

    const result = await persist(
      normalized('pdf1', ''),
      'pdf',
      'derived',
      store,
      undefined,
      true,
    );

    expect(result.contentChanged).toBe(false);
    expect(store.readNode('pdf1')).toBeNull();
  });

  it('skips an existing orphan without advancing or rewriting it', async () => {
    const store = getCanvasStore('orphan');
    store.write({
      canvasId: 'orphan',
      title: null,
      version: 1,
      state: { nodes: [], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('n1', {
      nodeId: 'n1',
      type: 'web',
      label: 'Orphan',
      content: 'keep orphan bytes',
    });

    const result = await persist(
      normalized('n1', 'stale extraction'),
      'web',
      'derived',
      store,
    );

    expect(result).toMatchObject({
      skipped: true,
      superseded: true,
      contentChanged: false,
    });
    expect(store.readNode('n1')).toMatchObject({
      type: 'web',
      content: 'keep orphan bytes',
    });
    expect(store.read()?.version).toBe(1);
    expect(store.readDeltaLogSince(0)).toEqual([]);
  });

  it('does not let delayed preprocessing revert a structural type transition', async () => {
    seedNode('type-transition', 'n1', 'pdf', 'canonical pdf body');
    const store = getCanvasStore('type-transition');

    const result = await persist(
      normalized('n1', 'late web extraction'),
      'web',
      'derived',
      store,
    );

    expect(result).toMatchObject({ skipped: true, superseded: true });
    expect(store.readNode('n1')).toMatchObject({
      type: 'pdf',
      content: 'canonical pdf body',
    });
    expect(store.read()?.version).toBe(1);
  });

  it('projects no stale patch for a superseded preprocessing result', () => {
    const result = project(
      {
        canvasId: 'c1',
        nodeId: 'n1',
        nodeType: 'web',
        trigger: 'node_updated',
        snapshot: { title: 'Current' },
      },
      'request-1',
      ['persist_source', 'generate_label'],
      {
        normalized: {
          nodeId: 'n1',
          canonicalContent: 'stale body',
          label: 'Stale label',
        },
        enriched: { suggestedLabel: 'Stale label', summary: 'Stale summary' },
        persisted: { skipped: true, superseded: true },
      },
      [],
      'web',
    );

    expect(result).toMatchObject({ success: true, status: 'skipped' });
    expect(result.patch).toEqual({});
    expect(result.enriched).toBeUndefined();
    expect(result.persistence).toBeUndefined();
  });
});

describe('persist — concurrency with a content PUT (authored body not clobbered)', () => {
  it('preserves a concurrent user PUT even when preprocess persists a stale snapshot', async () => {
    seedNode('c1', 'n1', 'note', 'v1');
    const store = getCanvasStore('c1');
    const revV1 = nodeRevisionOf({ content: 'v1' });

    const app = fastify();
    await app.register(canvasRoutes, { prefix: '/canvas' });
    await app.ready();
    try {
      // Fire both writers "at once": a user content PUT advancing the body to
      // "user-v2", and a preprocess persist still holding the stale "v1"
      // snapshot. Both take the shared per-canvas write lock, so they
      // serialize; whichever order wins, the authored-body guard ensures
      // persist never overwrites the newer user body.
      const put = app.inject({
        method: 'PUT',
        url: '/canvas/c1/nodes/n1/content',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          nodeType: 'note',
          content: 'user-v2',
          expectRev: revV1,
        }),
      });
      const pre = persist(normalized('n1', 'v1'), 'note', 'authored', store);
      const [putRes, preRes] = await Promise.all([put, pre]);

      // The user PUT always lands (persist never advances the body, so its
      // `expectRev` stays valid regardless of ordering).
      expect(putRes.statusCode).toBe(200);
      // persist wrote no body: a no-op when it ran first (snapshot == disk) or
      // a skip when the PUT diverged the body first.
      expect(preRes.contentChanged).toBe(false);
      // The user's authored body survives — NOT clobbered by the stale snapshot.
      expect(bodyOf('c1', 'n1')).toBe('user-v2');
    } finally {
      await app.close();
    }
  });
});
