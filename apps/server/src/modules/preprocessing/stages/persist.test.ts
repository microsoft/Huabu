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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { persist } from './persist.js';
import canvasRoutes from '../../canvas/canvas.route.js';
import { getStructuredStore } from '../../storage/index.js';
import { setWorkspacePath } from '../../workspace.js';

import type { NodeContent, SpaceNodes } from '../../storage/index.js';
import type { NormalizeResult } from '../types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-persist-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a Space topology with one node and return its async node repository. */
async function seedSpace(
  canvasId: string,
  nodeId: string,
  type: string,
): Promise<SpaceNodes> {
  const structured = getStructuredStore();
  const created = await structured.spaces().create({
    canvasId,
    title: null,
  });
  if (!created.ok) throw new Error(`failed to create ${canvasId}`);

  const space = structured.space(canvasId);
  const write = await space.write({
    expectedVersion: 0,
    nextRecord: {
      ...created.record,
      version: 1,
      state: {
        nodes: [
          { id: nodeId, type, position: { x: 0, y: 0 }, data: { label: 'A' } },
        ],
        edges: [],
      },
      updatedAt: Date.now(),
    },
    nodeMutations: [],
  });
  if (!write.ok) throw new Error(`failed to seed topology for ${canvasId}`);
  return space.nodes;
}

/** Seed a Space with one node whose persisted body is `content`. */
async function seedNode(
  canvasId: string,
  nodeId: string,
  type: string,
  content: string,
): Promise<SpaceNodes> {
  const nodes = await seedSpace(canvasId, nodeId, type);
  const result = await nodes.put({
    nodeId,
    record: { nodeId, type, label: 'A', content },
  });
  if (!result.ok) throw new Error(`failed to seed node ${nodeId}`);
  return nodes;
}

async function bodyOf(
  nodes: SpaceNodes,
  nodeId: string,
): Promise<string | undefined> {
  return (await nodes.read(nodeId))?.record.content ?? undefined;
}

function normalized(nodeId: string, canonicalContent: string): NormalizeResult {
  return { nodeId, canonicalContent };
}

describe('persist — authored-body CAS guard', () => {
  it('skips (no write) when an authored body diverged from disk', async () => {
    const nodes = await seedNode('c1', 'n1', 'note', 'newer-disk-version');

    // Preprocess snapshot is stale — on-disk body has moved on.
    const result = await persist(
      normalized('n1', 'stale-snapshot'),
      'note',
      'authored',
      nodes,
    );

    expect(result.contentChanged).toBe(false);
    // The newer on-disk body is preserved — NOT clobbered.
    await expect(bodyOf(nodes, 'n1')).resolves.toBe('newer-disk-version');
  });

  it('still persists a derived body that diverged (no guard)', async () => {
    const nodes = await seedNode('c1', 'n1', 'web', 'old-extraction');

    const result = await persist(
      normalized('n1', 'fresh-extraction'),
      'web',
      'derived',
      nodes,
    );

    expect(result.contentChanged).toBe(true);
    await expect(bodyOf(nodes, 'n1')).resolves.toBe('fresh-extraction');
  });

  it('creates an authored body when none exists (guard needs an existing body)', async () => {
    // No seedNode → no `.md` on disk yet.
    const nodes = await seedSpace('c2', 'n1', 'note');

    const result = await persist(
      normalized('n1', 'first body'),
      'note',
      'authored',
      nodes,
    );

    expect(result.contentChanged).toBe(true);
    await expect(bodyOf(nodes, 'n1')).resolves.toBe('first body');
  });

  it('does not recreate a missing sidecar when preprocessing requires one', async () => {
    const nodes = await seedSpace('c3', 'pdf1', 'pdf');

    const result = await persist(
      normalized('pdf1', ''),
      'pdf',
      'derived',
      nodes,
      undefined,
      true,
    );

    expect(result.contentChanged).toBe(false);
    await expect(nodes.read('pdf1')).resolves.toBeNull();
  });

  it('quietly skips a late write suppressed after deletion', async () => {
    const nodes = {
      canvasId: 'c-deleted',
      read: async () => null,
      put: async () => ({ ok: false, reason: 'write-suppressed' as const }),
    } as unknown as SpaceNodes;

    await expect(
      persist(
        normalized('deleted-node', 'late extraction'),
        'web',
        'derived',
        nodes,
      ),
    ).resolves.toEqual({
      nodeId: 'deleted-node',
      isNew: false,
      contentChanged: false,
    });
  });

  it('refreshes a PDF src when unchanged content adopts a local snapshot', async () => {
    const nodes = await seedNode('c4', 'pdf1', 'pdf', 'same extracted text');
    const record: NodeContent = {
      nodeId: 'pdf1',
      type: 'pdf',
      label: 'Paper',
      src: 'https://arxiv.org/pdf/2505.10831',
      content: 'same extracted text',
    };
    const setup = await nodes.put({ nodeId: 'pdf1', record });
    if (!setup.ok) throw new Error('failed to seed remote PDF source');

    const result = await persist(
      normalized('pdf1', 'same extracted text'),
      'pdf',
      'derived',
      nodes,
      'artifact_local.pdf',
      true,
    );

    expect(result.contentChanged).toBe(false);
    expect(result.persistedSrc).toBe('artifact_local.pdf');
    await expect(nodes.read('pdf1')).resolves.toEqual(
      expect.objectContaining({
        record: expect.objectContaining({ src: 'artifact_local.pdf' }),
      }),
    );
  });
});

describe('persist — video source fence', () => {
  async function video() {
    const nodes = await seedNode('video-space', 'v', 'video', '');
    await nodes.put({
      nodeId: 'v',
      record: {
        nodeId: 'v',
        type: 'video',
        label: 'Keep',
        src: 'new.mp4',
        content: '',
        coverUrl: 'old.jpg',
        coverSourceSrc: 'old.mp4',
        custom: 'preserved',
      },
    });
    return nodes;
  }

  it('refreshes cover metadata despite identical empty content', async () => {
    const nodes = await video();
    const cover = { coverUrl: 'new.jpg', coverSourceSrc: 'new.mp4' };
    const result = await persist(
      { ...normalized('v', ''), label: 'Stale label' },
      'video',
      'derived',
      nodes,
      'new.mp4',
      true,
      cover,
    );
    expect(result.videoCover).toEqual(cover);
    expect((await nodes.read('v'))?.record).toMatchObject({
      ...cover,
      custom: 'preserved',
      label: 'Keep',
    });
  });

  it('rejects all derived fields from a stale source, even when the body differs', async () => {
    const nodes = await video();
    const before = await nodes.read('v');
    const result = await persist(
      { ...normalized('v', 'stale body'), label: 'Stale label' },
      'video',
      'derived',
      nodes,
      'old.mp4',
      true,
      { coverUrl: 'late.jpg', coverSourceSrc: 'old.mp4' },
    );
    expect(await nodes.read('v')).toEqual(before);
    expect(result.videoCover).toBeUndefined();
    expect(result.persistedSrc).toBeUndefined();
  });

  it('clears both obsolete refs after extraction failure without erasing unrelated metadata', async () => {
    const nodes = await video();
    const result = await persist(
      normalized('v', ''),
      'video',
      'derived',
      nodes,
      'new.mp4',
      true,
      {},
    );
    const current = (await nodes.read('v'))?.record;
    expect(current).not.toHaveProperty('coverUrl');
    expect(current).not.toHaveProperty('coverSourceSrc');
    expect(current).toMatchObject({ custom: 'preserved', src: 'new.mp4' });
    expect(result.videoCover).toEqual({});
  });

  it('cannot recreate a missing video sidecar', async () => {
    const nodes = await seedSpace('video-space', 'v', 'video');
    const result = await persist(
      normalized('v', ''),
      'video',
      'derived',
      nodes,
      'new.mp4',
      true,
      { coverUrl: 'new.jpg', coverSourceSrc: 'new.mp4' },
    );
    expect(await nodes.read('v')).toBeNull();
    expect(result.videoCover).toBeUndefined();
  });

  it('returns only persisted cover refs through the real preprocess HTTP response', async () => {
    const nodes = await video();
    const current = await nodes.read('v');
    if (!current) throw new Error('Missing video fixture');
    const src = 'https://youtu.be/abc123_-ABC';
    await nodes.put({ nodeId: 'v', record: { ...current.record, src } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const app = fastify();
    await app.register(canvasRoutes, { prefix: '/canvas' });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/canvas/video-space/nodes/v/preprocess',
        payload: {
          nodeType: 'video',
          snapshot: { src },
          options: { allowLLM: false },
        },
      });
      expect(response.statusCode).toBe(200);
      const saved = (await nodes.read('v'))?.record;
      expect(response.json()).toMatchObject({
        success: true,
        coverUrl: saved?.coverUrl,
        coverSourceSrc: src,
      });
      expect(saved?.coverUrl).toMatch(/^cover_[\w-]+\.jpg$/);
    } finally {
      fetch.mockRestore();
      await app.close();
    }
  });
});

describe('persist — concurrency with a content PUT (authored body not clobbered)', () => {
  it('preserves a concurrent user PUT even when preprocess persists a stale snapshot', async () => {
    const nodes = await seedNode('c1', 'n1', 'note', 'v1');
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
      const pre = persist(normalized('n1', 'v1'), 'note', 'authored', nodes);
      const [putRes, preRes] = await Promise.all([put, pre]);

      // The user PUT always lands (persist never advances the body, so its
      // `expectRev` stays valid regardless of ordering).
      expect(putRes.statusCode).toBe(200);
      // persist wrote no body: a no-op when it ran first (snapshot == disk) or
      // a skip when the PUT diverged the body first.
      expect(preRes.contentChanged).toBe(false);
      // The user's authored body survives — NOT clobbered by the stale snapshot.
      await expect(bodyOf(nodes, 'n1')).resolves.toBe('user-v2');
    } finally {
      await app.close();
    }
  });
});
