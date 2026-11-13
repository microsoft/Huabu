// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A page's content position outlives the server process.
 *
 * A page loads a Space, another page saves node content, the server
 * restarts, and more content is saved. Asked from the position the load
 * carried, the server names exactly what a page has to fetch — it does not
 * answer "I cannot tell", which is what makes a page check every node.
 * Run against the Disk and the SQLite backend through the real routes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import canvasRoutes from './canvas.route.js';
import syncRoutes from './sync.route.js';
import {
  closeStorage,
  createSpace,
  initStorage,
  resetStorageCache,
  space,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasFile } from './persistence-types.js';

const CANVAS = 'c1';
const NOTES = ['a', 'b', 'c'] as const;

interface Position {
  epoch: string;
  seq: number;
}

async function buildApp() {
  const app = fastify();
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.register(syncRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}
type App = Awaited<ReturnType<typeof buildApp>>;

/** Three root notes with saved bodies, at version 1. */
async function seed(): Promise<void> {
  const created = await createSpace(CANVAS, 'Content position');
  if (!created.ok) throw new Error('Could not create the test Space');
  const next: CanvasFile = {
    ...created.record,
    version: 1,
    state: {
      nodes: NOTES.map((id, index) => ({
        id,
        type: 'note',
        position: { x: index * 300, y: 0 },
        style: { width: 200, height: 100 },
        data: { label: `Note ${id}` },
      })),
      edges: [],
    },
  };
  const written = await space(CANVAS).write({
    expectedVersion: 0,
    nextRecord: next,
    nodeMutations: NOTES.map((id) => ({
      kind: 'put' as const,
      nodeId: id,
      record: {
        nodeId: id,
        type: 'note',
        label: `Note ${id}`,
        content: `${id} body`,
      },
    })),
  });
  if (!written.ok) throw new Error('Could not seed the test Space');
}

async function load(app: App) {
  const response = await app.inject({
    method: 'GET',
    url: `/canvas/${CANVAS}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { version: number; contentPosition: Position };
}

/** Save `fields` of a node the way another page would. */
async function save(app: App, nodeId: string, fields: object): Promise<void> {
  const current = await app.inject({
    method: 'GET',
    url: `/canvas/${CANVAS}/nodes/${nodeId}/content`,
  });
  const saved = await app.inject({
    method: 'PUT',
    url: `/canvas/${CANVAS}/nodes/${nodeId}/content`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      nodeType: 'note',
      expectRev: (current.json() as { rev: string }).rev,
      pageId: 'another-page',
      ...fields,
    }),
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

async function changesSince(app: App, since: Position) {
  const response = await app.inject({
    method: 'GET',
    url: `/canvas/${CANVAS}/content/changes?epoch=${encodeURIComponent(since.epoch)}&seq=${since.seq}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    position: Position;
    changedNodeIds?: string[];
    reset?: boolean;
  };
}

describe.each(['disk', 'sqlite'] as const)(
  'content position across a server restart (%s)',
  (kind) => {
    let tmp: string;
    let previousDataDir: string | undefined;

    /** Open storage on the same data as a newly started server would. */
    async function start(): Promise<void> {
      if (kind === 'sqlite') {
        await initStorage({
          structured: { kind: 'sqlite' },
          blobs: { kind: 'disk' },
        });
      } else {
        // Disk holds nothing open but caches; a new process starts cold.
        resetStorageCache();
      }
    }

    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), `huabu-content-position-${kind}-`));
      previousDataDir = process.env.HUABU_DATA_DIR;
      process.env.HUABU_DATA_DIR = join(tmp, 'data');
      if (kind === 'disk') setWorkspacePath(join(tmp, 'workspace'));
      await start();
      await seed();
    });

    afterEach(async () => {
      if (kind === 'sqlite') await closeStorage();
      else resetStorageCache();
      if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
      else process.env.HUABU_DATA_DIR = previousDataDir;
      rmSync(tmp, { recursive: true, force: true });
    });

    it('names what was saved before and after the restart, from the position a load carried', async () => {
      let app = await buildApp();
      const loaded = await load(app);
      // Nothing has been saved since that load. SQLite names nothing; Disk
      // may name again what was written in the position's own millisecond.
      const idle = await changesSince(app, loaded.contentPosition);
      expect(idle.reset).toBeUndefined();
      if (kind === 'sqlite') expect(idle.changedNodeIds).toBeUndefined();

      // Another page saves a body. This page hears nothing: no stream.
      await save(app, 'a', { content: 'saved before the restart' });

      await app.close();
      if (kind === 'sqlite') await closeStorage();
      await start();
      app = await buildApp();
      try {
        // After the restart: a title alone, which no content hash covers.
        await save(app, 'b', {
          label: 'Renamed after the restart',
          labelSource: 'user',
        });
        expect((await load(app)).version).toBe(loaded.version);

        const answer = await changesSince(app, loaded.contentPosition);
        // Not "I cannot tell": the page fetches these and nothing else.
        expect(answer.reset).toBeUndefined();
        expect(answer.changedNodeIds).toEqual(
          expect.arrayContaining(['a', 'b']),
        );
        if (kind === 'sqlite')
          expect([...(answer.changedNodeIds ?? [])].sort()).toEqual(['a', 'b']);
        expect(answer.position.epoch).toBe(loaded.contentPosition.epoch);
        // The page asks from the answer next time.
        await save(app, 'c', { content: 'saved later still' });
        const later = await changesSince(app, answer.position);
        expect(later.reset).toBeUndefined();
        expect(later.changedNodeIds).toContain('c');
        if (kind === 'sqlite') expect(later.changedNodeIds).toEqual(['c']);
      } finally {
        await app.close();
      }
    });
  },
);
