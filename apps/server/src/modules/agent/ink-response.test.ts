// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createId } from '@huabu/shared';

import { createInkResponse } from './ink-response.js';
import { executeOnServer } from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

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
          style: { width: 200, height: 100 },
          data: { threadId, agentMode: 'ask' },
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

function nodes(): CanvasNode[] {
  return (getCanvasStore(canvasId).read()?.state.nodes ?? []) as CanvasNode[];
}

function notes() {
  return nodes().filter((node) => node.type === 'note');
}

describe('host Ink response delivery', () => {
  it('persists the full answer and conversation edge, broadcasts, and does not duplicate concurrent delivery', async () => {
    const response = createInkResponse(canvasId, threadId);
    let broadcasts = 0;
    const unsubscribe = subscribeCanvasUpdates(canvasId, () => {
      broadcasts++;
    });
    try {
      const outcome = {
        text: '## Findings\n\nA researched answer with [sources](https://example.com).',
        interrupted: false,
      };
      await Promise.all([response.deliver(outcome), response.deliver(outcome)]);
      await response.deliver(outcome);
      const note = notes()[0];
      expect(notes()).toHaveLength(1);
      expect(getCanvasStore(canvasId).readNode(note.id)?.content).toBe(
        outcome.text,
      );
      expect(note.data.origin).toEqual({ type: 'user-from-chat', threadId });
      expect(note.position.y).toBeGreaterThan(200);
      expect(getCanvasStore(canvasId).read()?.state.edges).toEqual([
        expect.objectContaining({ source: ownerId, target: note.id }),
      ]);
      expect(broadcasts).toBe(1);
      expect(nodes().find((node) => node.id === ownerId)?.data.agentMode).toBe(
        'ask',
      );
    } finally {
      response.stop();
      unsubscribe();
    }
  });

  it.each(['title', 'different-thread', 'actual-result'] as const)(
    'distinguishes %s writes from an answer delivered by this turn',
    async (kind) => {
      const response = createInkResponse(canvasId, threadId);
      try {
        await executeOnServer({
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
        await response.deliver({ text: 'Final answer', interrupted: false });
        const bodies = notes().map(
          (node) => getCanvasStore(canvasId).readNode(node.id)?.content,
        );
        if (kind === 'actual-result') expect(bodies).toEqual(['Direct result']);
        else expect(bodies).toContain('Final answer');
      } finally {
        response.stop();
      }
    },
  );

  it.each([
    { text: '', interrupted: false, expected: 'without providing an answer' },
    { text: 'Partial findings', interrupted: true, expected: 'interrupted' },
    {
      text: '',
      error: 'Search failed',
      interrupted: false,
      expected: 'Search failed',
    },
  ])(
    'delivers an honest outcome for incomplete or failed input: %j',
    async ({ expected, ...outcome }) => {
      const response = createInkResponse(canvasId, threadId);
      try {
        await response.deliver(outcome);
        expect(
          getCanvasStore(canvasId).readNode(notes()[0].id)?.content,
        ).toContain(expected);
      } finally {
        response.stop();
      }
    },
  );

  it('reports a missing Canvas instead of claiming delivery', async () => {
    const response = createInkResponse('missing-canvas', threadId);
    try {
      await expect(
        response.deliver({ text: 'Answer', interrupted: false }),
      ).rejects.toThrow('Canvas no longer exists');
    } finally {
      response.stop();
    }
  });
});
