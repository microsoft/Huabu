// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createId } from '@huabu/shared';

import { createInkResponse, isInkCanvasResult } from './ink-response.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { publishCanvasUpdate } from '../canvas/canvas-sync.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasNode, Delta } from '@huabu/shared/canvas-engine';

const canvasId = 'ink-response-test';
const threadId = 'ink-thread';
const ownerId = createId('node');
let tmp: string;
const originalDataDir = process.env.HUABU_DATA_DIR;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-ink-response-'));
  process.env.HUABU_DATA_DIR = tmp;
  setWorkspacePath(tmp);
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: ownerId,
          type: 'question',
          position: { x: 100, y: 100 },
          style: { width: 200 },
          data: { threadId, agentMode: 'operate' },
        },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode(ownerId, {
    nodeId: ownerId,
    type: 'question',
    label: 'Question',
    content: '',
  });
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = originalDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe('agent-authored Ink response verification', () => {
  it('rejects an empty or chat-only turn without creating a Note or edge', async () => {
    const response = createInkResponse(canvasId, threadId);
    const before = getCanvasStore(canvasId).read();
    await expect(response.deliver({ interrupted: false })).rejects.toThrow(
      'without a visible Canvas result',
    );
    expect(getCanvasStore(canvasId).read()).toEqual(before);
  });

  it.each(['title', 'different-thread', 'actual-result'] as const)(
    'distinguishes %s writes from a Canvas reply',
    async (kind) => {
      const response = createInkResponse(canvasId, threadId);
      try {
        const result = await executeOnServer({
          canvasId,
          originator: {
            source: 'agent',
            threadId: kind === 'different-thread' ? 'another-thread' : threadId,
          },
          commands:
            kind === 'title'
              ? [
                  {
                    type: 'MERGE_NODE_DATA',
                    patches: [
                      {
                        nodeId: ownerId,
                        patch: { label: 'Interpreted request' },
                      },
                    ],
                  },
                ]
              : [
                  {
                    type: 'CREATE_NODES',
                    nodes: [
                      {
                        nodeType: 'note',
                        data: { content: 'Direct result' },
                        position: { x: 900, y: 0 },
                      },
                    ],
                  },
                ],
        });
        expect(result.results.every((item) => item.applied)).toBe(true);
        const beforeVerification = getCanvasStore(canvasId).read();
        if (kind === 'actual-result') {
          await Promise.all([
            response.deliver({ interrupted: false }),
            response.deliver({ interrupted: false }),
          ]);
        } else {
          await expect(
            response.deliver({ interrupted: false }),
          ).rejects.toThrow('without a visible Canvas result');
        }
        expect(getCanvasStore(canvasId).read()).toEqual(beforeVerification);
        expect(beforeVerification?.state.edges).toEqual([]);
      } finally {
        response.stop();
      }
    },
  );

  it.each([
    { interrupted: true },
    { interrupted: false, error: 'Write permission denied' },
  ])(
    'preserves an incomplete outcome without manufacturing a reply: %j',
    async (outcome) => {
      const response = createInkResponse(canvasId, threadId);
      const before = getCanvasStore(canvasId).read();
      await response.deliver(outcome);
      expect(getCanvasStore(canvasId).read()).toEqual(before);
    },
  );

  it('ignores Agent Node projections even when they contain a visible delta', async () => {
    const response = createInkResponse(canvasId, threadId);
    publishCanvasUpdate(canvasId, {
      type: 'update',
      data: {
        threadId,
        agentNodeProjection: true,
        fromVersion: 1,
        toVersion: 2,
        deltas: [
          {
            type: 'INSERT_NODE',
            node: {
              id: 'note',
              type: 'note',
              position: { x: 0, y: 0 },
              data: { content: 'Projection' },
            },
          },
        ],
        pendingEffects: {
          mutatedNodes: [],
          deletedNodeIds: [],
          contentEditedNodeIds: [],
          deferredFitFrameIds: [],
        },
      },
    });
    await expect(response.deliver({ interrupted: false })).rejects.toThrow(
      'without a visible Canvas result',
    );
  });

  it('does not count failed writes or results from before this invocation', async () => {
    await executeOnServer({
      canvasId,
      originator: { source: 'agent', threadId },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              data: { content: 'Earlier answer' },
              position: { x: 900, y: 0 },
            },
          ],
        },
      ],
    });
    const response = createInkResponse(canvasId, threadId);
    await executeOnServer({
      canvasId,
      originator: { source: 'agent', threadId },
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            { nodeId: createId('node'), patch: { content: 'Missing target' } },
          ],
        },
      ],
    });
    await expect(response.deliver({ interrupted: false })).rejects.toThrow(
      'without a visible Canvas result',
    );
  });
});

describe('visible Canvas result classification', () => {
  const node: CanvasNode = {
    id: 'note',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content: 'Answer' },
  };
  it.each([
    { delta: { type: 'INSERT_NODE', node }, visible: true },
    {
      delta: { type: 'INSERT_NODE', node: { ...node, hidden: true } },
      visible: false,
    },
    {
      delta: { type: 'INSERT_NODE', node: { ...node, type: 'question' } },
      visible: false,
    },
    {
      delta: {
        type: 'REPLACE_NODE',
        prev: node,
        next: { ...node, data: { ...node.data, summary: 'Metadata' } },
      },
      visible: false,
    },
    {
      delta: {
        type: 'REPLACE_NODE',
        prev: node,
        next: { ...node, data: { content: 'Edited answer' } },
      },
      visible: true,
    },
    {
      delta: {
        type: 'REPLACE_NODE',
        prev: node,
        next: { ...node, position: { x: 20, y: 40 } },
      },
      visible: true,
    },
    {
      delta: {
        type: 'REPLACE_NODE',
        prev: node,
        next: { ...node, data: { ...node.data, style: { accent: 'purple' } } },
      },
      visible: true,
    },
    { delta: { type: 'DELETE_NODE', node }, visible: true },
    {
      delta: {
        type: 'INSERT_EDGE',
        edge: { id: 'edge', source: 'a', target: 'b' },
      },
      visible: true,
    },
    {
      delta: {
        type: 'INSERT_EDGE',
        edge: { id: 'edge', source: 'a', target: 'b', hidden: true },
      },
      visible: false,
    },
    {
      delta: {
        type: 'REPLACE_EDGE',
        prev: { id: 'edge', source: 'a', target: 'b' },
        next: {
          id: 'edge',
          source: 'a',
          target: 'b',
          data: { labelSource: 'agent' },
        },
      },
      visible: false,
    },
  ] satisfies Array<{ delta: Delta; visible: boolean }>)(
    'classifies $delta.type as $visible',
    ({ delta, visible }) => {
      expect(isInkCanvasResult(delta)).toBe(visible);
    },
  );
});
