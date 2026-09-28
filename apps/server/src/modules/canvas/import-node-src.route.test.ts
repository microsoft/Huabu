// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import canvasRoutes from './canvas.route.js';
import { resetPreprocessDispatcher } from '../preprocessing/index.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { resetStorageCache, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;
const src = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-youtube-import-'));
  vi.stubEnv('HUABU_DATA_DIR', tmp);
  setWorkspacePath(tmp);
  resetStorageCache();
  resetPreprocessDispatcher();
  createCanvas('c-youtube');
});

afterEach(() => {
  resetPreprocessDispatcher();
  resetStorageCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('YouTube source import → real route preprocessing', () => {
  it.each(['CREATE_NODES', 'MERGE_NODE_DATA', 'content PUT'] as const)(
    'preserves the platform source through %s and persists only the fetched cover',
    async (entryPoint) => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        if (input !== 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg') {
          throw new Error(`Unexpected network request: ${String(input)}`);
        }
        return new Response(jpeg, {
          headers: { 'content-type': 'image/jpeg' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const app = fastify();
      await app.register(canvasRoutes, { prefix: '/canvas' });
      await app.ready();
      try {
        const created = await app.inject({
          method: 'POST',
          url: '/canvas/c-youtube/execute',
          payload: {
            originator: { source: 'agent' },
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id: 'node-video',
                    nodeType: 'video',
                    position: { x: 0, y: 0 },
                    data: {
                      label: 'Video',
                      src: entryPoint === 'CREATE_NODES' ? src : 'original.mp4',
                    },
                  },
                ],
              },
            ],
          },
        });
        expect(created.statusCode).toBe(200);
        if (entryPoint === 'MERGE_NODE_DATA') {
          const merged = await app.inject({
            method: 'POST',
            url: '/canvas/c-youtube/execute',
            payload: {
              originator: { source: 'agent' },
              commands: [
                {
                  type: 'MERGE_NODE_DATA',
                  patches: [{ nodeId: 'node-video', patch: { src } }],
                },
              ],
            },
          });
          expect(merged.statusCode).toBe(200);
        } else if (entryPoint === 'content PUT') {
          const saved = await app.inject({
            method: 'PUT',
            url: '/canvas/c-youtube/nodes/node-video/content',
            payload: { nodeType: 'video', src },
          });
          expect(saved.statusCode).toBe(200);
          expect(saved.json()).not.toHaveProperty('artifactMissing');
        }

        expect(fetchMock).not.toHaveBeenCalled();
        const handle = space('c-youtube');
        expect((await handle.nodes.read('node-video'))?.record.src).toBe(src);
        expect(await handle.artifacts.list()).toEqual([]);

        const processed = await app.inject({
          method: 'POST',
          url: '/canvas/c-youtube/nodes/node-video/preprocess',
          payload: {
            nodeType: 'video',
            trigger: 'node_updated',
            snapshot: { src },
            options: { allowLLM: false },
          },
        });
        expect(processed.statusCode).toBe(200);
        expect(processed.json()).toMatchObject({
          success: true,
          coverUrl: expect.stringMatching(/^cover_[\w-]+\.jpg$/),
          coverSourceSrc: src,
        });
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
          'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
          expect.objectContaining({ redirect: 'error' }),
        );
        const coverUrl = processed.json().coverUrl as string;
        expect((await handle.nodes.read('node-video'))?.record).toMatchObject({
          src,
          coverUrl,
          coverSourceSrc: src,
        });
        expect(await handle.artifacts.read(coverUrl)).toEqual(jpeg);
        expect(await handle.artifacts.list()).toHaveLength(1);

        const hydrated = await app.inject({
          method: 'GET',
          url: '/canvas/c-youtube',
        });
        expect(hydrated.statusCode).toBe(200);
        expect(hydrated.json().state.nodes).toEqual([
          expect.objectContaining({
            id: 'node-video',
            data: expect.objectContaining({
              src,
              coverUrl,
              coverSourceSrc: src,
            }),
          }),
        ]);
      } finally {
        await app.close();
      }
    },
  );
});
