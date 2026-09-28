// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What the service still decides from a thread's durable record.
 *
 * Both persisted-state readers now await Agenetes, and both feed decisions a
 * user would notice if they changed: which Agent a thread belongs to after a
 * restart, and whether a Space Prompt is collected again for a thread that
 * already carries one. The record here is the real one, written through the
 * mounted profile and read back through the service's own default
 * dependencies — a stubbed reader would only prove the awaits compile.
 */

import { describe, expect, it, vi } from 'vitest';

import { createId } from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  collectSpacePrompt: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock('./space-instruction-frames.js', async (actual) => ({
  ...(await actual<typeof SpaceInstructionFrames>()),
  resolveSpacePrompt: mocks.collectSpacePrompt,
}));

vi.mock('./agent.service.js', async (actual) => ({
  ...(await actual<typeof AgentService>()),
  runAgent: mocks.runAgent,
}));

import { conversationThreadStore } from './agenetes/conversation-stores.js';
import { agenetes } from './agenetes/drivers.js';
import { buildHuabuPiWorkloadSpec } from './agenetes/pi-driver.js';
import { AgentThreadService } from './agent-thread.service.js';
import { createSpace, space } from '../storage/index.js';
import {
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type * as AgentService from './agent.service.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type * as SpaceInstructionFrames from './space-instruction-frames.js';
import type { ThreadRecord } from '@agenetes/agenetes';
import type { CanvasNode } from '@huabu/shared/canvas-engine';
import type { FastifyBaseLogger } from 'fastify';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  silent: vi.fn(),
  child: vi.fn(),
  level: 'info',
} as unknown as FastifyBaseLogger;

const ENVELOPE: ChatEnvelope = {
  user: { text: 'Investigate this', attachments: [] },
  skills: { invokedIds: [], resolved: [] },
  focus: {
    selection: {
      refs: [],
      selectedIds: [],
      imageAttachments: [],
      snapshotAttachments: [],
    },
  },
};

const DIAGNOSTICS = {
  includedFrameIds: [],
  includedNodeIds: [],
  omittedUnsupportedIds: [],
  omittedEmptyTextIds: [],
  omittedMissingIds: [],
  omittedBudgetNodeIds: [],
  truncatedNoteIds: [],
  truncated: false,
};

let mounted: MountedTestStorage;

async function open(): Promise<AgentNodeTarget> {
  mocks.collectSpacePrompt.mockReset().mockResolvedValue({
    markdown: '<space_prompt>Collected now</space_prompt>',
    diagnostics: DIAGNOSTICS,
  });
  mocks.runAgent.mockReset().mockImplementation(async function* () {
    yield { type: 'done', data: { message: 'Done' } };
    return [];
  });
  // The Canvas mutex and the record reader are in-process; the profile only
  // has to be a real one that survives `reopen`.
  mounted = await mountTestWorkspace(
    { structured: { kind: 'disk' }, blobs: { kind: 'disk' } },
    'agent-thread-persisted-',
  );
  const canvasId = createId('canvas');
  const created = await createSpace(canvasId, 'Persisted state');
  if (!created.ok) throw new Error('Space creation failed');
  const target: AgentNodeTarget = {
    canvasId,
    nodeId: createId('node'),
    threadId: createId('thread'),
    agentBinding: { kind: 'internal' },
    bindingState: 'editing',
  };
  const node: CanvasNode = {
    id: target.nodeId,
    type: 'question',
    position: { x: 0, y: 0 },
    data: {
      threadId: target.threadId,
      agentBinding: target.agentBinding,
      bindingState: 'editing',
    },
  };
  await space(canvasId).write({
    expectedVersion: 0,
    nextRecord: {
      ...created.record,
      version: 1,
      state: { nodes: [node], edges: [] },
    },
    nodeMutations: [
      {
        kind: 'put',
        nodeId: target.nodeId,
        record: {
          nodeId: target.nodeId,
          type: 'question',
          label: 'Agent',
          content: '',
        },
        authoritativeInsert: true,
      },
    ],
  });
  return target;
}

async function close(threadId?: string): Promise<void> {
  vi.restoreAllMocks();
  if (threadId) await agenetes.close(threadId);
  await mounted?.close();
}

function externalRecord(canvasId: string, threadId: string): ThreadRecord {
  return {
    driverSchemaVersion: 1,
    spec: {
      kind: 'external',
      workloadType: 'Deployment',
      threadId,
      namespace: canvasAcpNamespace(canvasId),
      spec: {
        binding: { alias: 'Fixed Agent', profileId: 'profile-fixed' },
        agentletId: 'agentlet-1',
        initialPreamble: ['Huabu bootstrap'],
      },
    },
    state: { driverState: { initialPreambleDelivered: false } },
  } as ThreadRecord;
}

async function invokeOnce(target: AgentNodeTarget): Promise<void> {
  const invocation = await new AgentThreadService().invoke({
    threadId: target.threadId,
    canvasId: target.canvasId,
    content: 'Investigate this',
    mode: 'ask',
    envelope: ENVELOPE,
    logger,
  });
  for await (const _event of invocation.events) {
    // Drain the turn so the invocation settles.
  }
}

describe('AgentThreadService persisted binding recovery', () => {
  it('recovers an external binding from the durable record across a restart', async () => {
    const target = await open();
    try {
      const namespace = canvasAcpNamespace(target.canvasId);
      await conversationThreadStore.upsert(
        namespace,
        target.threadId,
        externalRecord(target.canvasId, target.threadId),
      );
      const service = new AgentThreadService();
      expect(
        await service.resolveBinding({
          canvasId: target.canvasId,
          threadId: target.threadId,
        }),
      ).toEqual({
        kind: 'external',
        alias: 'Fixed Agent',
        profileId: 'profile-fixed',
      });

      await mounted.reopen();

      expect(
        await new AgentThreadService().resolveBinding({
          canvasId: target.canvasId,
          threadId: target.threadId,
        }),
      ).toEqual({
        kind: 'external',
        alias: 'Fixed Agent',
        profileId: 'profile-fixed',
      });
    } finally {
      await close();
    }
  });

  it('falls back to the internal Agent when the thread has no record at all', async () => {
    const target = await open();
    try {
      expect(
        await new AgentThreadService().resolveBinding({
          canvasId: target.canvasId,
          threadId: target.threadId,
        }),
      ).toEqual({ kind: 'internal' });
      expect(
        await new AgentThreadService().resolveExternalTarget(
          target.canvasId,
          target.threadId,
        ),
      ).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('AgentThreadService persisted Space Prompt', () => {
  it('reuses the Space Prompt a realized thread already carries', async () => {
    const target = await open();
    try {
      await agenetes.create(
        buildHuabuPiWorkloadSpec({
          kind: 'internal',
          workloadType: 'Deployment',
          threadId: target.threadId,
          namespace: canvasAcpNamespace(target.canvasId),
          canvasId: target.canvasId,
          systemPrompt: 'Test',
          toolNames: [],
          initialMessages: [],
          maxIterations: 1,
          toolExecution: 'sequential',
          spacePrompt: '<space_prompt>Realized earlier</space_prompt>',
        }),
      );

      await invokeOnce(target);

      expect(mocks.collectSpacePrompt).not.toHaveBeenCalled();
      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          spacePrompt: '<space_prompt>Realized earlier</space_prompt>',
        }),
      );
    } finally {
      await close(target.threadId);
    }
  });

  it('collects a Space Prompt for a thread that has no record yet', async () => {
    const target = await open();
    try {
      await invokeOnce(target);

      expect(mocks.collectSpacePrompt).toHaveBeenCalledOnce();
      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          spacePrompt: '<space_prompt>Collected now</space_prompt>',
        }),
      );
    } finally {
      await close(target.threadId);
    }
  });
});
