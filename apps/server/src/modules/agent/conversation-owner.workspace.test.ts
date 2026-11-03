// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';

import conversationOwnerRoutes from './conversation-owner.route.js';
import { publishCanvasUpdate } from '../canvas/canvas-sync.js';
import {
  closeStorage,
  createSpace,
  getCanvasStore,
  getStructuredStore,
  openWorkspace,
  resetStorageCache,
  space,
} from '../storage/index.js';
import { runInWorkspace } from '../workspace/context.js';
import { createWorkspace } from '../workspace-activation.js';
import { setWorkspacePath } from '../workspace.js';

import type { AgentConversationOwnerEvent } from '@huabu/shared';

let tmp: string;
let previousDataDir: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-conversation-workspace-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  mkdirSync(join(tmp, 'server'));
  resetStorageCache();
  setWorkspacePath(join(tmp, 'server'));
});
afterEach(async () => {
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

it('refreshes a conversation in its admitted Workspace when events arrive from another scope or outside a request', async () => {
  const scope = await openWorkspace(await createWorkspace('Observed'));
  const otherScope = await openWorkspace(await createWorkspace('Other'));
  const canvasId = 'canvas-observed';
  const nodeId = 'node-agent';
  await runInWorkspace(scope, async () => {
    await createSpace(canvasId, 'Observed Space');
    await getCanvasStore(canvasId).write({
      canvasId,
      title: 'Observed Space',
      version: 1,
      state: {
        nodes: [
          {
            id: nodeId,
            type: 'question',
            position: { x: 0, y: 0 },
            data: { threadId: 'thread', status: 'done' },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await space(canvasId).nodes.put({
      nodeId,
      record: {
        nodeId,
        type: 'question',
        label: 'Original task',
        content: 'Original task',
      },
    });
  });
  const app = Fastify();
  // Identity admission is outside this route's boundary; keep the actual
  // async scope, HTTP stream, publisher and storage inside it real.
  app.addHook('onRequest', (_request, _reply, done) =>
    runInWorkspace(scope, done),
  );
  await app.register(conversationOwnerRoutes, { prefix: '/agent' });
  const controller = new AbortController();
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(
      `${app.listeningOrigin}/agent/owner/thread/stream?canvasId=${canvasId}`,
      { signal: controller.signal },
    );
    if (!response.body) throw new Error('Missing conversation stream');
    const reader = response.body.getReader();
    let buffer = '';
    async function next(): Promise<AgentConversationOwnerEvent> {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const type = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (type && data)
            return {
              type,
              data: JSON.parse(data),
            } as AgentConversationOwnerEvent;
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Conversation stream ended');
          buffer += new TextDecoder().decode(chunk.value);
        }
      }
    }
    expect(await next()).toMatchObject({
      type: 'snapshot',
      data: {
        revision: 1,
        value: { state: 'ready', owner: { spaceTitle: 'Observed Space' } },
      },
    });
    for (const [index, publisherScope] of [otherScope, undefined].entries()) {
      const title = `Updated ${index}`;
      await runInWorkspace(scope, () =>
        getStructuredStore().spaces().rename({ canvasId, title }),
      );
      const publish = () =>
        publishCanvasUpdate(canvasId, { type: 'invalidate', data: {} });
      if (publisherScope) runInWorkspace(publisherScope, publish);
      else publish();
      expect(await next()).toMatchObject({
        type: 'snapshot',
        data: {
          revision: index + 2,
          value: { state: 'ready', owner: { spaceTitle: title } },
        },
      });
    }
  } finally {
    controller.abort();
    await app.close();
  }
});
