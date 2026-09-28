// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A whole Agent turn through the service layer, on Postgres.
 *
 * The store-level suites prove the Postgres conversation stores answer their
 * ports. This one asks the question a user would: admit a turn, project the
 * Agent Node, persist the conversation, read it back through the history
 * route, restart the process, and read it again. Everything above the driver
 * is the real thing — admission, lifecycle projection, binding confirmation,
 * the route — and the driver is synthetic only because a real model is not the
 * subject. That combination is where asynchronous persistence and the new
 * backend actually meet.
 */

import { mountAgenetes } from '@agenetes/agenetes';
import { agentSpecSchema } from '@agenetes/protocol';
import { defineDriver } from '@agenetes/runtime';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createId } from '@huabu/shared';

const mocks = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock('./agent.service.js', async (actual) => ({
  ...(await actual<typeof AgentService>()),
  runAgent: mocks.runAgent,
}));

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './agenetes/conversation-stores.js';
import { agenetes } from './agenetes/drivers.js';
import { agentThreadService } from './agent-thread.service.js';
import agentRoutes from './agent.route.js';
import { createSpace, space } from '../storage/index.js';
import {
  mountTestWorkspace,
  PRODUCT_STORAGE_PROFILES,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type * as AgentService from './agent.service.js';
import type { ChatEnvelope } from './conversation/envelope.js';
import type { AgentStreamEvent } from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';
import type { CanvasNode } from '@huabu/shared/canvas-engine';
import type { FastifyBaseLogger } from 'fastify';

const profile = PRODUCT_STORAGE_PROFILES.find(
  (candidate) => candidate.structured.kind === 'postgres',
);

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
  user: { text: 'Investigate the outage', attachments: [] },
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

/** A driver that replies without a model; persistence around it stays real. */
const driver = defineDriver({
  schemaVersion: 1,
  workloadTypes: ['Deployment'],
  specSchema: agentSpecSchema.passthrough(),
  stateSchema: z.object({ revision: z.number() }),
  initialState: () => ({ revision: 1 }),
  create: () =>
    ({
      capabilities: { supportedControlMessages: [], turnInput: 'blocking' },
      async *run(): AsyncGenerator<AgentStreamEvent> {
        yield { type: 'text_delta', data: { content: 'Stub reply' } };
        yield { type: 'end', data: {} };
      },
      async control() {
        return {
          ok: false as const,
          code: 'unsupported',
          error: 'Unsupported synthetic control',
        };
      },
      close() {},
    }) satisfies AgentHandle,
});

function mountRuntime() {
  return mountAgenetes({
    drivers: { internal: driver },
    threadStore: conversationThreadStore,
    eventLogStore: conversationEventLogStore,
    turnStore: conversationTurnStore,
  });
}

/** Point the host's singleton at `runtime`, the way a restart re-mounts it. */
function useRuntime(runtime: ReturnType<typeof mountRuntime>): void {
  vi.spyOn(agenetes, 'record').mockImplementation(runtime.record);
  vi.spyOn(agenetes, 'records').mockImplementation(runtime.records);
  vi.spyOn(agenetes, 'history').mockImplementation(runtime.history);
  vi.spyOn(agenetes, 'historyPage').mockImplementation(runtime.historyPage);
  vi.spyOn(agenetes, 'logMetadata').mockImplementation(runtime.logMetadata);
  vi.spyOn(agenetes, 'updateHostMetadata').mockImplementation(
    runtime.updateHostMetadata,
  );
  vi.spyOn(agenetes, 'create').mockImplementation(runtime.create);
  vi.spyOn(agenetes, 'get').mockImplementation(runtime.get);
  vi.spyOn(agenetes, 'close').mockImplementation(runtime.close);
  mocks.runAgent.mockImplementation(async function* (options: {
    threadId: string;
    canvasId?: string;
    submission: unknown;
    onTurnStarted?: () => void;
    onExecutionCreated?: () => Promise<void>;
  }) {
    const handle = await runtime.create({
      kind: 'internal',
      workloadType: 'Deployment',
      threadId: options.threadId,
      namespace: canvasAcpNamespace(options.canvasId ?? ''),
      spec: { hostContext: { canvasId: options.canvasId } },
    });
    await options.onExecutionCreated?.();
    options.onTurnStarted?.();
    yield* handle.run(
      options.submission as Parameters<AgentHandle['run']>[0],
      {},
    );
    return [];
  });
}

let mounted: MountedTestStorage | null = null;
let app: FastifyInstance | undefined;
let openThreadId: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (openThreadId) await agenetes.close(openThreadId).catch(() => undefined);
  openThreadId = undefined;
  vi.restoreAllMocks();
  await mounted?.close();
  mounted = null;
});

async function readHistory(threadId: string, canvasId: string) {
  app ??= Fastify({ logger: false });
  if (!app.hasRoute({ method: 'GET', url: '/agent/history/:threadId/page' })) {
    await app.register(agentRoutes, { prefix: '/agent' });
  }
  const response = await app.inject({
    method: 'GET',
    url: `/agent/history/${threadId}/page?canvasId=${canvasId}&limit=20`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

describe.skipIf(!profile)('Agent thread service on a Postgres profile', () => {
  it('runs, persists and re-reads a turn across a restart', async () => {
    if (!profile) throw new Error('Unreachable');
    mounted = await mountTestWorkspace(profile, 'agent-thread-postgres-');
    const canvasId = createId('canvas');
    const created = await createSpace(canvasId, 'Postgres Agent');
    if (!created.ok) throw new Error('Space creation failed');
    const threadId = createId('thread');
    openThreadId = threadId;
    const nodeId = createId('node');
    const node: CanvasNode = {
      id: nodeId,
      type: 'question',
      position: { x: 0, y: 0 },
      data: {
        threadId,
        agentBinding: { kind: 'internal' },
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
          nodeId,
          record: { nodeId, type: 'question', label: 'Agent', content: '' },
          authoritativeInsert: true,
        },
      ],
    });
    useRuntime(mountRuntime());

    const invocation = await agentThreadService.invoke({
      threadId,
      canvasId,
      content: 'Investigate the outage',
      mode: 'ask',
      envelope: ENVELOPE,
      logger,
    });
    const streamed: string[] = [];
    for await (const event of invocation.events) {
      if (event.type === 'text_delta') streamed.push(event.data.content);
    }

    expect(streamed).toEqual(['Stub reply']);
    // The Agent Node carries this turn, not a draft.
    const beforeRestart = await space(canvasId).read();
    expect((beforeRestart?.state.nodes as CanvasNode[])[0]?.data).toMatchObject(
      { bindingState: 'bound', status: 'done' },
    );
    expect((await space(canvasId).nodes.read(nodeId))?.record.content).toBe(
      'Investigate the outage',
    );
    const page = await readHistory(threadId, canvasId);
    expect(page.turns).toHaveLength(1);
    expect(
      page.turns[0].messages.map((message: { role: string }) => message.role),
    ).toEqual(['user', 'assistant']);
    expect(JSON.stringify(page.turns[0].messages)).toContain('Stub reply');
    expect(
      await agentThreadService.resolveBinding({ canvasId, threadId }),
    ).toEqual({ kind: 'internal' });

    await agenetes.close(threadId);
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
    await mounted.reopen();
    useRuntime(mountRuntime());

    // Nothing is live any more; every answer below comes off Postgres.
    expect(agenetes.get(threadId)).toBeUndefined();
    const recovered = await agenetes.record(
      canvasAcpNamespace(canvasId),
      threadId,
    );
    expect(recovered?.spec.kind).toBe('internal');
    expect(
      await agentThreadService.resolveBinding({ canvasId, threadId }),
    ).toEqual({ kind: 'internal' });
    expect(await readHistory(threadId, canvasId)).toEqual(page);
    const afterRestart = await space(canvasId).read();
    expect((afterRestart?.state.nodes as CanvasNode[])[0]?.data).toMatchObject({
      bindingState: 'bound',
      status: 'done',
    });
    expect((await space(canvasId).nodes.read(nodeId))?.record.content).toBe(
      'Investigate the outage',
    );
  });
});
