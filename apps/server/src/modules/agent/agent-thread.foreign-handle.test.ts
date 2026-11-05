// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A conversation id is chosen by the client, so another Space can open a live
 * handle under one of this Space's ids while it is idle. The runtime refuses
 * to share the handle; this Space, which holds the conversation, must still be
 * able to run it rather than wait for a restart.
 */

import { mountAgenetes } from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./memory/index.js', () => ({
  readWorkspaceMemory: () => '',
}));

import {
  AgentThreadService,
  releaseForeignThreadHandle,
} from './agent-thread.service.js';

import type { HuabuSubmission } from './agenetes/handle.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { AgentStreamEvent } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const emptySchema = {
  safeParse(input: unknown) {
    return input !== null && typeof input === 'object'
      ? { success: true as const, data: input as Record<string, never> }
      : { success: false as const, error: new Error('expected object') };
  },
};

function runtime() {
  const closed: string[] = [];
  const driver = defineDriver({
    schemaVersion: 1,
    workloadTypes: ['Deployment'],
    specSchema: emptySchema,
    stateSchema: emptySchema,
    initialState: () => ({}),
    create: (workload) =>
      ({
        capabilities: {},
        async run() {
          return undefined;
        },
        async control() {
          return { ok: false as const, code: 'unsupported' as const };
        },
        close() {
          closed.push(workload.namespace.name);
        },
      }) as never,
  });
  return { instance: mountAgenetes({ drivers: { internal: driver } }), closed };
}

const spec = (name: string) => ({
  kind: 'internal',
  workloadType: 'Deployment' as const,
  namespace: { name },
  threadId: 'shared-id',
  spec: {},
});

describe('releaseForeignThreadHandle', () => {
  it('lets the Space holding a conversation displace another Space’s live handle', async () => {
    const { instance, closed } = runtime();
    // Carol's Space has the conversation; it is idle (no live handle).
    const carol = await instance.create(spec('carol-space'));
    await instance.close('shared-id', { name: 'carol-space' });
    closed.length = 0;
    // Erin reuses the id from her own Space while it is idle.
    await instance.create(spec('erin-space'));
    await expect(instance.create(spec('carol-space'))).rejects.toThrow(
      'another namespace',
    );

    await releaseForeignThreadHandle(
      instance,
      { name: 'carol-space' },
      'shared-id',
    );

    expect(closed).toEqual(['erin-space']);
    const resumed = await instance.create(spec('carol-space'));
    expect(resumed).not.toBe(carol);
    expect(instance.get('shared-id', { name: 'carol-space' })).toBe(resumed);
    // Erin keeps her own record; it never became Carol's.
    expect(
      await instance.record({ name: 'erin-space' }, 'shared-id'),
    ).toMatchObject({ spec: { namespace: { name: 'erin-space' } } });
  });

  it('leaves another Space’s handle alone when this Space has no conversation', async () => {
    const { instance, closed } = runtime();
    const erin = await instance.create(spec('erin-space'));

    await releaseForeignThreadHandle(
      instance,
      { name: 'carol-space' },
      'shared-id',
    );

    expect(closed).toEqual([]);
    expect(instance.get('shared-id', { name: 'erin-space' })).toBe(erin);
    await expect(instance.create(spec('carol-space'))).rejects.toThrow(
      'another namespace',
    );
  });

  it('does nothing for this Space’s own handle or a thread nobody holds', async () => {
    const { instance, closed } = runtime();
    const own = await instance.create(spec('carol-space'));

    await releaseForeignThreadHandle(
      instance,
      { name: 'carol-space' },
      'shared-id',
    );
    await releaseForeignThreadHandle(
      instance,
      { name: 'carol-space' },
      'other-id',
    );

    expect(closed).toEqual([]);
    expect(instance.get('shared-id', { name: 'carol-space' })).toBe(own);
  });
});

describe('AgentThreadService', () => {
  it('displaces a foreign handle only while holding the turn lease', async () => {
    const order: string[] = [];
    const service = new AgentThreadService({
      hasAcceptedRequest: vi.fn(async () => false),
      resolveAgentNode: async () => null,
      resolveFixedAgentNode: async () => null,
      resolvePersistedExternalBinding: async () => null,
      resolvePersistedSpacePrompt: async () => ({ realised: false }),
      collectSpacePrompt: async () => null,
      realizeExternal: vi.fn(),
      waitForTurnRelease: vi.fn(async () => {
        order.push('wait');
      }),
      acquireTurn: vi.fn(() => {
        order.push('lease');
        return () => order.push('release');
      }),
      startLifecycle: vi.fn().mockResolvedValue(undefined),
      finishLifecycle: vi.fn().mockResolvedValue(undefined),
      failLifecycle: vi.fn().mockResolvedValue(undefined),
      runExternal: vi.fn(),
      runInternal: (() => {
        order.push('run');
        return (async function* () {
          yield { type: 'done', data: { message: 'Done' } } as AgentStreamEvent;
          return [];
        })();
      }) as never,
      closeHandle: vi.fn(),
      releaseForeignHandle: vi.fn(async (threadId, canvasId) => {
        order.push(`displace ${canvasId}/${threadId}`);
      }),
    });
    const invocation = await service.invoke({
      threadId: 'shared-id',
      canvasId: 'carol-space',
      content: 'Continue',
      mode: 'ask',
      envelope: {
        user: { text: 'Continue', attachments: [] },
        skills: { invokedIds: [], resolved: [] },
        focus: {
          selection: {
            refs: [],
            selectedIds: [],
            imageAttachments: [],
            snapshotAttachments: [],
          },
        },
      } as ChatEnvelope,
      submission: {
        type: 'huabu.chat',
        content: {} as ChatEnvelope,
        rendered: [{ type: 'text', text: 'Continue' }],
      } as HuabuSubmission,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as FastifyBaseLogger,
    });
    for await (const _event of invocation.events) {
      // Drain the turn.
    }
    expect(order).toEqual([
      'wait',
      'lease',
      'displace carol-space/shared-id',
      'run',
      'release',
    ]);
  });
});
