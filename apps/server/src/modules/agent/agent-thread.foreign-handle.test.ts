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

vi.mock('../workspace/paths.js', async (importOriginal) => {
  const paths = await importOriginal<typeof workspacePaths>();
  const { getWorkspaceHandle } = await import('../workspace.js');
  return {
    ...paths,
    // Unit service cases have no storage backend; preserve the production
    // owner/empty-Space identity while integration suites cover real roots.
    canvasAcpNamespace: (canvasId: string) => ({
      name: canvasId,
      ...(canvasId && getWorkspaceHandle()
        ? { ownerId: getWorkspaceHandle()?.workspaceId }
        : {}),
    }),
  };
});

vi.mock('./memory/index.js', () => ({
  readWorkspaceMemory: () => '',
}));

import { AgentThreadService } from './agent-thread.service.js';

import type * as workspacePaths from '../workspace/paths.js';
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

describe('namespace-qualified live handles', () => {
  it('resumes an idle conversation without evicting another namespace same-ID handle', async () => {
    const { instance, closed } = runtime();
    await instance.create(spec('carol-space'));
    await instance.close('shared-id', { name: 'carol-space' });
    closed.length = 0;
    const other = await instance.create(spec('erin-space'));
    const resumed = await instance.create(spec('carol-space'));
    expect(resumed).not.toBe(other);
    expect(closed).toEqual([]);
    expect(instance.get('shared-id', { name: 'erin-space' })).toBe(other);
    await instance.close('shared-id', { name: 'carol-space' });
    expect(closed).toEqual(['carol-space']);
    expect(instance.get('shared-id', { name: 'erin-space' })).toBe(other);
    await instance.close('shared-id', { name: 'erin-space' });
  });
});

describe('AgentThreadService', () => {
  it('runs under the scoped turn lease without evicting another handle', async () => {
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
    expect(order).toEqual(['wait', 'lease', 'run', 'release']);
  });
});
