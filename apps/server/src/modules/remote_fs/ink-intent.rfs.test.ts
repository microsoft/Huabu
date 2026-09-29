// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rfsInkIntentResponseSchema } from '@huabu/shared';

import rfsRoutes from './rfs.route.js';
import { beginActiveInkIntentTurn } from '../agent/ink-intent-runtime.js';
import { space, getCanvasStore, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

let workspace: string;
const app = () => fastify().register(rfsRoutes, { prefix: '/rfs' });

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'huabu-ink-report-'));
  resetStorageCache();
  setWorkspacePath(workspace);
  getCanvasStore('c1').write({
    canvasId: 'c1',
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { threadId: 'thread-1', pendingInkIntentLabel: true },
        },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  getCanvasStore('c1').writeNode('question-1', {
    nodeId: 'question-1',
    type: 'question',
    label: 'New ink request',
    content: '',
  });
});

afterEach(() => {
  resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});

describe('RFS active Ink reports', () => {
  it.each(['inferred', 'clarify', 'unsupported'] as const)(
    'accepts %s for the active external turn and consumes the pending label',
    async (status) => {
      const server = app();
      const invocationToken = randomUUID();
      const finish = beginActiveInkIntentTurn(
        'c1',
        'thread-1',
        'question-1',
        invocationToken,
      );
      try {
        const report =
          status === 'inferred'
            ? { status, text: 'Explain this diagram' }
            : { status };
        const response = await server.inject({
          method: 'POST',
          url: '/rfs/c1/agent/thread-1/ink-intent',
          payload: { invocationToken, report },
        });
        expect(response.statusCode).toBe(200);
        expect(rfsInkIntentResponseSchema.parse(response.json())).toEqual({
          report,
          renamed: status === 'inferred',
        });
        const record = await space('c1').read();
        expect(record?.state.nodes[0]).toMatchObject({
          data: { pendingInkIntentLabel: false },
        });
        expect((await space('c1').nodes.read('question-1'))?.record.label).toBe(
          status === 'inferred' ? 'Explain this diagram' : 'New ink request',
        );
      } finally {
        finish();
        await server.close();
      }
    },
  );

  it('preserves a user-edited title', async () => {
    getCanvasStore('c1').writeNode('question-1', {
      nodeId: 'question-1',
      type: 'question',
      label: 'My title',
      labelSource: 'user',
      content: '',
    });
    const server = app();
    const invocationToken = randomUUID();
    const finish = beginActiveInkIntentTurn(
      'c1',
      'thread-1',
      'question-1',
      invocationToken,
    );
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-1/ink-intent',
        payload: {
          invocationToken,
          report: { status: 'inferred', text: 'Generated title' },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().renamed).toBe(false);
      expect((await space('c1').nodes.read('question-1'))?.record.label).toBe(
        'My title',
      );
    } finally {
      finish();
      await server.close();
    }
  });

  it('rejects wrong tokens, wrong scopes, ended turns and old tokens during a later turn', async () => {
    const server = app();
    const invocationToken = randomUUID();
    const payload = {
      invocationToken,
      report: { status: 'inferred', text: 'Stale title' },
    };
    let finish = beginActiveInkIntentTurn(
      'c1',
      'thread-1',
      'question-1',
      invocationToken,
    );
    try {
      for (const [url, body] of [
        [
          '/rfs/c1/agent/thread-1/ink-intent',
          { ...payload, invocationToken: randomUUID() },
        ],
        ['/rfs/c2/agent/thread-1/ink-intent', payload],
        ['/rfs/c1/agent/thread-2/ink-intent', payload],
      ] as const) {
        const response = await server.inject({
          method: 'POST',
          url,
          payload: body,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('ink_turn_inactive');
      }
      finish();
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/rfs/c1/agent/thread-1/ink-intent',
            payload,
          })
        ).statusCode,
      ).toBe(409);
      finish = beginActiveInkIntentTurn(
        'c1',
        'thread-1',
        'question-1',
        randomUUID(),
      );
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/rfs/c1/agent/thread-1/ink-intent',
            payload,
          })
        ).statusCode,
      ).toBe(409);
      expect((await space('c1').nodes.read('question-1'))?.record.label).toBe(
        'New ink request',
      );
    } finally {
      finish();
      await server.close();
    }
  });

  it.each([
    {},
    { invocationToken: 'invalid', report: { status: 'clarify' } },
    {
      invocationToken: randomUUID(),
      report: { status: 'inferred', text: 'two\nlines' },
    },
    {
      invocationToken: randomUUID(),
      report: { status: 'inferred', text: 'x'.repeat(121) },
    },
    { invocationToken: randomUUID(), report: { status: 'other' } },
  ])('validates report input before mutation: %j', async (payload) => {
    const server = app();
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/rfs/c1/agent/thread-1/ink-intent',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('validation_failed');
    } finally {
      await server.close();
    }
  });
});
