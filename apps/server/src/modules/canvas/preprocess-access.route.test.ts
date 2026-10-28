// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeOnServer } from './canvas-executor.js';
import canvasRoutes from './canvas.route.js';
import { setRequestIdentity } from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { createCanvas } from '../storage/compatibility/canvas.js';
import { resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { ResolvedIdentity } from '../identity/service.js';
import type * as PreprocessingModule from '../preprocessing/index.js';
import type { PreprocessNodeRequest } from '@huabu/shared';

const seen: PreprocessNodeRequest[] = [];
vi.mock('../preprocessing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PreprocessingModule>()),
  getPreprocessDispatcher: () => ({
    preprocess: async (request: PreprocessNodeRequest) => {
      seen.push(request);
      return { success: true, patch: {}, diagnostics: [] };
    },
  }),
}));

let tmp: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-preprocess-access-'));
  setWorkspacePath(tmp);
  resetStorageCache();
  seen.length = 0;
  createCanvas('mine', 'Mine');
  await executeOnServer({
    canvasId: 'mine',
    originator: { source: 'ui' },
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-n1',
            nodeType: 'image',
            data: { label: 'Image', src: 'artifact-own.png' },
            position: { x: 0, y: 0 },
            size: { width: 100, height: 100 },
          },
        ],
      },
    ],
  });
});
afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** Carol reads and writes `mine` only; `owner` adds owner authority. */
const carol = (owner: boolean): ResolvedIdentity => ({
  principal: { principalId: 'carol', kind: 'user' },
  member: true,
  owner,
  access: {
    can: async (_level, { id }) => id === 'mine',
    claim: async () => {},
    workspaces: async () => 'all' as const,
  },
});

async function preprocess(identity: ResolvedIdentity, src: string) {
  const app = fastify();
  app.addHook('onRequest', async (request) => {
    setRequestIdentity(request, identity);
  });
  await app.register(canvasRoutes, { prefix: '/canvas' });
  const response = await app.inject({
    method: 'POST',
    url: '/canvas/mine/nodes/node-n1/preprocess',
    payload: {
      nodeType: 'image',
      snapshot: { src },
      options: { allowLLM: true },
    },
  });
  await app.close();
  return response.statusCode;
}

describe('POST /:canvasId/nodes/:nodeId/preprocess under per-Space access', () => {
  it('refuses a snapshot citing another Space the caller may not read', async () => {
    expect(
      await preprocess(carol(false), '/api/canvas/private/artifact/secret.png'),
    ).toBe(404);
    expect(seen).toHaveLength(0);
    expect(await preprocess(carol(false), 'artifact-own.png')).toBe(200);
  });

  it('runs extraction without the Utility Agent, on the public network only, for a member', async () => {
    await preprocess(carol(false), 'artifact-own.png');
    await preprocess(carol(true), 'artifact-own.png');
    expect(seen.map((request) => request.options?.allowLLM)).toEqual([
      false,
      true,
    ]);
    // A member's run fetches only from public addresses.
    expect(seen.map((request) => request.publicNetworkOnly)).toEqual([
      true,
      undefined,
    ]);
  });

  it('leaves local mode as it was', async () => {
    const local: ResolvedIdentity = {
      ...carol(false),
      access: UNRESTRICTED_ACCESS,
    };
    expect(
      await preprocess(local, '/api/canvas/private/artifact/secret.png'),
    ).toBe(200);
    expect(seen[0]?.options?.allowLLM).toBe(true);
  });
});
