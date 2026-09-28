// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Creating an Agent Node while its thread's record is being read.
 *
 * Conversion and attachment settle a node's identity from the durable record
 * — binding, and the conversation title the backend holds rather than whatever
 * the browser last cached. That read is now an await taken inside a Canvas
 * write, so two things have to stay true: no other writer may slip into the
 * Space while it is outstanding, and the answer that comes back is the one the
 * node is built from.
 */

import { describe, expect, it, vi } from 'vitest';

import { createId } from '@huabu/shared';

import { executeOnServer } from './canvas-executor.js';
import { agenetes } from '../agent/agenetes/drivers.js';
import { createSpace, space, withCanvasMutex } from '../storage/index.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

type DurableRecord = NonNullable<Awaited<ReturnType<typeof agenetes.record>>>;

/** Let every queued microtask and macrotask run before asserting a negative. */
const settleQueues = () => new Promise((resolve) => setImmediate(resolve));

let mounted: MountedTestStorage;

async function open(): Promise<string> {
  // The Canvas mutex is in-process; the profile only has to be a real Space.
  mounted = await mountTestWorkspace(
    { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
    'agent-node-edit-async-',
  );
  const canvasId = createId('canvas');
  const created = await createSpace(canvasId, 'Agent Node edits');
  if (!created.ok) throw new Error('Space creation failed');
  return canvasId;
}

async function close(): Promise<void> {
  vi.restoreAllMocks();
  await mounted?.close();
}

function internalRecord(
  canvasId: string,
  threadId: string,
  title?: string,
): DurableRecord {
  return {
    driverSchemaVersion: 1,
    spec: {
      threadId,
      namespace: { name: canvasId },
      kind: 'internal',
      workloadType: 'Deployment',
      spec: {},
    },
    state: { driverState: {} },
    ...(title
      ? {
          hostMetadata: {
            huabuConversationTitle: { title, source: 'user' },
          },
        }
      : {}),
  } as unknown as DurableRecord;
}

function attach(canvasId: string, threadId: string, label?: string) {
  return executeOnServer({
    canvasId,
    originator: { source: 'ui' },
    commands: [
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-attached',
            nodeType: 'question',
            position: { x: 10, y: 0 },
            data: { threadId, ...(label ? { label } : {}) },
          },
        ],
      },
    ],
  });
}

async function attachedNode(canvasId: string): Promise<CanvasNode> {
  const canvas = await space(canvasId).read();
  if (!canvas) throw new Error('Space disappeared');
  const node = (canvas.state.nodes as CanvasNode[]).find(
    (entry) => entry.id === 'node-attached',
  );
  if (!node) throw new Error('Chat attachment was not created');
  return node;
}

describe('Agent Node creation against an awaited record', () => {
  it('keeps the Space to itself while the record read is outstanding', async () => {
    const canvasId = await open();
    try {
      let reading = false;
      let finishRead!: () => void;
      const read = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      vi.spyOn(agenetes, 'record').mockImplementation(async () => {
        reading = true;
        await read;
        return internalRecord(canvasId, 'thread-attached');
      });

      const creating = attach(canvasId, 'thread-attached');
      while (!reading) await settleQueues();

      let unrelatedWriteRan = false;
      const unrelated = withCanvasMutex(canvasId, async () => {
        unrelatedWriteRan = true;
      });
      await settleQueues();
      expect(unrelatedWriteRan).toBe(false);

      finishRead();
      await creating;
      await unrelated;

      expect(unrelatedWriteRan).toBe(true);
      expect((await attachedNode(canvasId)).data).toMatchObject({
        threadId: 'thread-attached',
        bindingState: 'bound',
        agentBinding: { kind: 'internal' },
      });
    } finally {
      await close();
    }
  });

  it('names the node from the record the read returns, not the incoming cache', async () => {
    const canvasId = await open();
    try {
      vi.spyOn(agenetes, 'record').mockImplementation(async () => {
        await settleQueues();
        return internalRecord(canvasId, 'thread-attached', 'Durable title');
      });

      await attach(canvasId, 'thread-attached', 'Stale browser title');

      expect((await attachedNode(canvasId)).data).toMatchObject({
        bindingState: 'bound',
        conversationTitleSource: 'user',
        agentBinding: { kind: 'internal' },
      });
      expect(
        (await space(canvasId).nodes.read('node-attached'))?.record,
      ).toMatchObject({ label: 'Durable title', labelSource: 'user' });
    } finally {
      await close();
    }
  });
});
