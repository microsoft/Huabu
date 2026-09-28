// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import assert from 'node:assert/strict';

import { mountAgenetes } from '@agenetes/agenetes';
import { agentSpecSchema } from '@agenetes/protocol';
import { AgenetesError, defineDriver } from '@agenetes/runtime';
import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import * as executor from './canvas-executor.js';
import * as canvasSync from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import { moveCanvasSelection } from './space-move.service.js';
import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from '../agent/agenetes/conversation-stores.js';
import { agenetes } from '../agent/agenetes/drivers.js';
import { agentThreadService } from '../agent/agent-thread.service.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import * as storage from '../storage/index.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type * as LoggerModule from '../../utils/logger.js';
import type { AgentStreamEvent, WorkloadSpec } from '@agenetes/protocol';
import type { AgentCreateContext, AgentHandle } from '@agenetes/runtime';
import type { MoveSelectionBody } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const { warn, errorLog } = vi.hoisted(() => ({
  warn: vi.fn(),
  errorLog: vi.fn(),
}));

vi.mock('../../utils/logger.js', async (original) => ({
  ...(await original<typeof LoggerModule>()),
  getLogger: () => ({ warn, error: errorLog }),
}));

vi.mock('../agent/acp/reachback-env.js', () => ({
  buildReachbackEnv: () => ({ HUABU_RFS_URL: '<destination-reachback-url>' }),
}));

const SOURCE = 'source-test';
const DESTINATION = 'destination-test';
const THREAD = 'thread-test';
const PRIVATE_ERROR =
  '<space-id>/<thread-id> <filesystem-path> <credential> <prompt> <conversation>';
const submission = {
  type: 'synthetic',
  content: '<synthetic-input>',
  rendered: [{ type: 'text' as const, text: '<synthetic-input>' }],
};

forEachProductProfile((profile, label) => {
  describe(`Move Agent lifecycle (${label})`, () => {
    let mounted: MountedTestStorage;
    let runtime: ReturnType<typeof mountAgenetes>;
    let nodes: CanvasNode[];
    let handles: Array<{
      handle: AgentHandle;
      context: AgentCreateContext;
      close: ReturnType<typeof vi.fn>;
    }>;
    let closeFailure: boolean;

    beforeEach(async () => {
      warn.mockClear();
      errorLog.mockClear();
      mounted = await mountTestWorkspace(profile, 'space-move-agents-');
      handles = [];
      nodes = [];
      closeFailure = false;
      const driver = defineDriver({
        schemaVersion: 1,
        workloadTypes: ['Deployment'],
        specSchema: agentSpecSchema.passthrough(),
        stateSchema: z.object({ revision: z.number() }),
        initialState: () => ({ revision: 7 }),
        create(_spec, context) {
          const close = vi.fn(() => {
            if (closeFailure) throw new Error(PRIVATE_ERROR);
          });
          const handle = {
            capabilities: {
              supportedControlMessages: [],
              turnInput: 'blocking',
            },
            async *run(): AsyncGenerator<AgentStreamEvent> {
              yield {
                type: 'text_delta',
                data: { content: '<synthetic-reply>' },
              };
              yield { type: 'end', data: {} };
            },
            async control() {
              return {
                ok: false as const,
                code: 'unsupported',
                error: 'Unsupported synthetic control',
              };
            },
            close,
          } satisfies AgentHandle;
          handles.push({ handle, context, close });
          return handle;
        },
      });
      runtime = mountAgenetes({
        drivers: { internal: driver, external: driver },
        threadStore: conversationThreadStore,
        eventLogStore: conversationEventLogStore,
        turnStore: conversationTurnStore,
      });
      vi.spyOn(agenetes, 'record').mockImplementation(runtime.record);
      vi.spyOn(agenetes, 'history').mockImplementation(runtime.history);
      vi.spyOn(agenetes, 'create').mockImplementation(runtime.create);
      vi.spyOn(agenetes, 'get').mockImplementation(runtime.get);
      vi.spyOn(agenetes, 'close').mockImplementation(runtime.close);
      vi.spyOn(agenetes, 'rehome').mockImplementation(runtime.rehome);
      for (const canvasId of [SOURCE, DESTINATION]) {
        expect((await storage.createSpace(canvasId, canvasId)).ok).toBe(true);
      }
    });

    afterEach(async () => {
      closeFailure = false;
      vi.restoreAllMocks();
      for (const node of nodes) await runtime.close(String(node.data.threadId));
      await mounted.close();
    });

    async function seed(kinds: Array<'internal' | 'external'> = ['internal']) {
      const namespace = canvasAcpNamespace(SOURCE);
      for (const [index, kind] of kinds.entries()) {
        const threadId = index === 0 ? THREAD : `${THREAD}-${index}`;
        const agentBinding =
          kind === 'internal'
            ? { kind }
            : { kind, profileId: 'profile-test', alias: 'Synthetic Agent' };
        const spec: WorkloadSpec = {
          kind,
          workloadType: 'Deployment',
          threadId,
          namespace,
          spec: {
            hostContext: { canvasId: SOURCE },
            binding: { profileId: 'profile-test', alias: 'Synthetic Agent' },
            env: {
              HUABU_RFS_URL: '<source-reachback-url>',
              KEEP: '<synthetic-env>',
            },
          },
        };
        const handle = await runtime.create(spec);
        await runtime.updateHostMetadata(namespace, threadId, {
          test: 'preserved',
        });
        for await (const event of handle.run(submission, {})) {
          expect(event.type).toBeDefined();
        }
        nodes.push({
          id: `node-${threadId}`,
          type: 'question',
          position: { x: index * 200, y: 0 },
          data: {
            label: `Synthetic Agent ${index}`,
            labelSource: 'user',
            content: '<synthetic-note>',
            threadId,
            agentBinding,
            bindingState: 'bound',
            invocationToken: 'invocation-test',
            status: 'done',
            viewed: false,
            conversationTitleSource: 'user',
          },
        });
      }
      const source = await storage.space(SOURCE).read();
      if (!source) throw new Error('Missing synthetic source');
      const write = await storage.space(SOURCE).write({
        expectedVersion: source.version,
        nextRecord: {
          ...source,
          version: source.version + 1,
          state: { nodes, edges: [] },
        },
        nodeMutations: nodes.map((node) => ({
          kind: 'put' as const,
          nodeId: node.id,
          authoritativeInsert: true,
          record: {
            nodeId: node.id,
            type: 'question',
            ...node.data,
            label: String(node.data.label),
            content: '<synthetic-note>',
          },
        })),
      });
      expect(write.ok).toBe(true);
    }

    async function move(
      destination: MoveSelectionBody['destination'] = {
        kind: 'existing',
        canvasId: DESTINATION,
      },
    ) {
      const source = await storage.space(SOURCE).read();
      assert.ok(source);
      return moveCanvasSelection(SOURCE, {
        selectedNodeIds: nodes.map((node) => node.id),
        destination,
        createSourcePreview: true,
        expectedSourceVersion: source.version,
      });
    }

    function assertReleased() {
      for (const node of nodes) {
        const release = acquireAgentTurn(String(node.data.threadId));
        expect(release).not.toBeNull();
        release?.();
      }
    }

    async function assertRestored() {
      const source = await storage.space(SOURCE).read();
      assert.ok(source);
      const restored = executor.hydrateCanvasNodes(
        await storage.space(SOURCE).nodes.list(),
        source.state.nodes as CanvasNode[],
      );
      expect(restored).toHaveLength(nodes.length);
      expect(restored).toEqual(expect.arrayContaining(nodes));
      expect((await storage.space(DESTINATION).read())?.state.nodes).toEqual(
        [],
      );
      for (const node of nodes) {
        const threadId = String(node.data.threadId);
        expect(
          await runtime.record(canvasAcpNamespace(SOURCE), threadId),
        ).toBeDefined();
        expect(
          await runtime.record(canvasAcpNamespace(DESTINATION), threadId),
        ).toBeUndefined();
        expect(
          (await runtime.history(canvasAcpNamespace(SOURCE), threadId)).turns,
        ).toHaveLength(1);
        expect(
          (await runtime.history(canvasAcpNamespace(DESTINATION), threadId))
            .turns,
        ).toHaveLength(0);
      }
      assertReleased();
    }

    it.each(['internal', 'external'] as const)(
      'closes a completed cached %s Agent and recovers in the destination',
      async (kind) => {
        await seed([kind]);
        const before = await runtime.record(canvasAcpNamespace(SOURCE), THREAD);
        assert.ok(before);
        const events = await conversationEventLogStore.readRecords(
          canvasAcpNamespace(SOURCE),
          THREAD,
        );
        const turns = (
          await runtime.history(canvasAcpNamespace(SOURCE), THREAD)
        ).turns;
        const destinationWrite = vi.spyOn(
          executor,
          'executeOnServerAlreadyLocked',
        );
        const result = await move();
        expect(result.movedConversationCount).toBe(1);
        expect(agenetes.close).toHaveBeenCalledExactlyOnceWith(THREAD);
        const closeOrder = vi.mocked(agenetes.close).mock
          .invocationCallOrder[0];
        const rehomeOrder = vi.mocked(agenetes.rehome).mock
          .invocationCallOrder[0];
        assert.ok(closeOrder !== undefined && rehomeOrder !== undefined);
        expect(destinationWrite.mock.invocationCallOrder[0]).toBeLessThan(
          closeOrder,
        );
        expect(closeOrder).toBeLessThan(rehomeOrder);
        expect(runtime.get(THREAD)).toBeUndefined();
        const moved = await runtime.record(
          canvasAcpNamespace(DESTINATION),
          THREAD,
        );
        assert.ok(moved);
        expect(moved.state).toEqual(before.state);
        expect(moved.hostMetadata).toEqual(before.hostMetadata);
        expect(moved.spec.threadId).toBe(THREAD);
        expect(
          await runtime.record(canvasAcpNamespace(SOURCE), THREAD),
        ).toBeUndefined();
        expect(
          await conversationEventLogStore.readRecords(
            canvasAcpNamespace(DESTINATION),
            THREAD,
          ),
        ).toEqual(events);
        expect(
          (await runtime.history(canvasAcpNamespace(DESTINATION), THREAD))
            .turns,
        ).toEqual(turns);
        expect(moved.spec.spec).toMatchObject(
          kind === 'internal'
            ? { hostContext: { canvasId: DESTINATION } }
            : {
                env: {
                  HUABU_RFS_URL: '<destination-reachback-url>',
                  KEEP: '<synthetic-env>',
                },
              },
        );
        const recovered = await runtime.create(moved.spec);
        expect(handles.at(-1)?.context.recoveryInput).toMatchObject({
          state: before.state,
          turns,
        });
        for await (const event of recovered.run(submission, {}))
          expect(event.type).toBeDefined();
        expect(
          (await runtime.history(canvasAcpNamespace(DESTINATION), THREAD))
            .turns,
        ).toHaveLength(2);
        expect(
          (await runtime.history(canvasAcpNamespace(SOURCE), THREAD)).turns,
        ).toHaveLength(0);
        const destination = await storage.space(DESTINATION).read();
        assert.ok(destination && nodes[0]);
        expect(
          executor.hydrateCanvasNodes(
            await storage.space(DESTINATION).nodes.list(),
            destination.state.nodes as CanvasNode[],
          )[0],
        ).toMatchObject({ data: nodes[0].data });
        assertReleased();
      },
    );

    it('waits for the handle to be down before rehoming its conversation', async () => {
      await seed();
      const order: string[] = [];
      let finishClose!: () => void;
      const closing = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      // Closing is a promise now, and a close merely started still leaves the
      // handle wired to the source Space's conversation stores.
      vi.spyOn(agenetes, 'close').mockImplementation(async (threadId) => {
        order.push('close-started');
        await closing;
        order.push('close-settled');
        return runtime.close(threadId);
      });
      vi.spyOn(agenetes, 'rehome').mockImplementation(
        async (...args: Parameters<typeof runtime.rehome>) => {
          order.push('rehome');
          return runtime.rehome(...args);
        },
      );

      const moving = move();
      while (!order.includes('close-started')) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(order).toEqual(['close-started']);

      finishClose();
      await moving;

      expect(order).toEqual(['close-started', 'close-settled', 'rehome']);
      expect(runtime.get(THREAD)).toBeUndefined();
      expect(
        await runtime.record(canvasAcpNamespace(DESTINATION), THREAD),
      ).toBeDefined();
      expect(
        await runtime.record(canvasAcpNamespace(SOURCE), THREAD),
      ).toBeUndefined();
      expect(
        (await runtime.history(canvasAcpNamespace(DESTINATION), THREAD)).turns,
      ).toHaveLength(1);
      assertReleased();
    });

    it.each([
      'active',
      'leased',
      'task',
      'pending',
      'invalid-binding',
    ] as const)(
      'rejects %s before closing any handle or writing the destination',
      async (reason) => {
        await seed(['internal', 'internal']);
        assert.ok(nodes[0]);
        let release: (() => void) | null = null;
        if (reason === 'active')
          vi.spyOn(agentThreadService, 'isActive').mockReturnValue(true);
        if (reason === 'leased') release = acquireAgentTurn(`${THREAD}-1`);
        if (reason === 'task') {
          const tasks = storage.space(SOURCE).tasks;
          await tasks.create({
            taskId: 'task-test',
            canvasId: SOURCE,
            goal: '<synthetic-goal>',
            defaultRootProfileId: 'profile-test',
            anchorNodeId: nodes[0].id,
            createdAt: 1,
          });
          await tasks.runs.create({
            runId: 'run-test',
            taskId: 'task-test',
            canvasIdSnapshot: SOURCE,
            goalSnapshot: '<synthetic-goal>',
            rootProfileIdSnapshot: 'profile-test',
            status: 'pending',
            createdAt: 2,
            rootThreadId: `${THREAD}-1`,
          });
        }
        if (reason === 'pending') {
          await storage
            .space(SOURCE)
            .changes.append(
              `${THREAD}-1`,
              extractCanvasChanges([{ type: 'INSERT_NODE', node: nodes[0] }]),
            );
        }
        if (reason === 'invalid-binding') {
          const spec = await runtime.record(canvasAcpNamespace(SOURCE), THREAD);
          assert.ok(spec);
          await conversationThreadStore.upsert(
            canvasAcpNamespace(SOURCE),
            THREAD,
            {
              ...spec,
              spec: { ...spec.spec, threadId: 'mismatched-test-thread' },
            },
          );
        }
        try {
          await expect(move()).rejects.toMatchObject({
            code:
              reason === 'task'
                ? 'MOVE_AGENT_TASK_OWNED'
                : reason === 'pending'
                  ? 'MOVE_AGENT_PENDING_CHANGES'
                  : reason === 'invalid-binding'
                    ? 'MOVE_AGENT_HISTORY_INVALID'
                    : 'MOVE_AGENT_RUNNING',
          });
          expect(agenetes.close).not.toHaveBeenCalled();
          expect(agenetes.rehome).not.toHaveBeenCalled();
          expect(
            (await storage.space(DESTINATION).read())?.state.nodes,
          ).toEqual([]);
        } finally {
          release?.();
        }
        assertReleased();
      },
    );

    it('does not close a handle when the destination write rejects', async () => {
      await seed();
      vi.spyOn(executor, 'executeOnServerAlreadyLocked').mockRejectedValueOnce(
        new Error(PRIVATE_ERROR),
      );
      await expect(move()).rejects.toMatchObject({ code: 'MOVE_FAILED' });
      expect(agenetes.close).not.toHaveBeenCalled();
      await assertRestored();
    });

    it('compensates partial destination acceptance before closing a handle', async () => {
      await seed();
      const execute = executor.executeOnServerAlreadyLocked;
      vi.spyOn(executor, 'executeOnServerAlreadyLocked').mockImplementationOnce(
        async (input) => {
          const output = await execute(input);
          return {
            ...output,
            results: output.results.map((result) => ({
              ...result,
              applied: false,
            })),
          };
        },
      );
      await expect(move()).rejects.toMatchObject({
        code: 'MOVE_DESTINATION_CONFLICT',
      });
      expect(agenetes.close).not.toHaveBeenCalled();
      await assertRestored();
    });

    it('aborts on driver close failure, compensates destination, and retains the source handle', async () => {
      await seed();
      closeFailure = true;
      await expect(move()).rejects.toMatchObject({
        code: 'MOVE_AGENT_CLOSE_FAILED',
      });
      expect(agenetes.rehome).not.toHaveBeenCalled();
      expect(runtime.get(THREAD)).toBeDefined();
      await assertRestored();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE_ERROR);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'agent-close',
          compensation: 'succeeded',
          code: 'MOVE_AGENT_CLOSE_FAILED',
        }),
        'Move rejected',
      );
    });

    it('preserves source durability after post-close rehome failure without reopening', async () => {
      await seed();
      vi.mocked(agenetes.rehome).mockImplementationOnce(() => {
        throw new Error(PRIVATE_ERROR);
      });
      await expect(move()).rejects.toMatchObject({
        code: 'MOVE_AGENT_REHOME_FAILED',
      });
      expect(runtime.get(THREAD)).toBeUndefined();
      expect(handles).toHaveLength(1);
      await assertRestored();
      const record = await runtime.record(canvasAcpNamespace(SOURCE), THREAD);
      assert.ok(record);
      await runtime.create(record.spec);
      expect(handles.at(-1)?.context.recoveryInput?.turns).toHaveLength(1);
    });

    it.each(['close', 'rehome'] as const)(
      'compensates earlier threads when a later %s fails',
      async (failurePhase) => {
        await seed(['internal', 'external']);
        if (failurePhase === 'rehome') {
          vi.mocked(agenetes.rehome)
            .mockImplementationOnce(runtime.rehome)
            .mockImplementationOnce(() => {
              throw new Error(PRIVATE_ERROR);
            });
        } else {
          vi.mocked(agenetes.close)
            .mockImplementationOnce(runtime.close)
            .mockImplementationOnce(() => {
              throw new Error(PRIVATE_ERROR);
            });
        }
        await expect(move()).rejects.toMatchObject({
          code:
            failurePhase === 'close'
              ? 'MOVE_AGENT_CLOSE_FAILED'
              : 'MOVE_AGENT_REHOME_FAILED',
        });
        await assertRestored();
        expect(handles).toHaveLength(2);
        expect(runtime.get(THREAD)).toBeUndefined();
        if (failurePhase === 'rehome')
          expect(runtime.get(`${THREAD}-1`)).toBeUndefined();
        else expect(runtime.get(`${THREAD}-1`)).toBeDefined();
      },
    );

    it('compensates an actual target-store failure after close', async () => {
      await seed();
      const upsert = conversationThreadStore.upsert;
      vi.spyOn(conversationThreadStore, 'upsert').mockImplementation(
        (namespace, threadId, record) => {
          if (namespace.name === DESTINATION) throw new Error(PRIVATE_ERROR);
          return upsert(namespace, threadId, record);
        },
      );
      await expect(move()).rejects.toMatchObject({
        code: 'MOVE_AGENT_REHOME_FAILED',
      });
      expect(runtime.get(THREAD)).toBeUndefined();
      await assertRestored();
    });

    it('rejects missing canonical state on a Bound Agent without closing', async () => {
      await seed();
      await conversationThreadStore.delete(canvasAcpNamespace(SOURCE), THREAD);
      await expect(move()).rejects.toMatchObject({
        code: 'MOVE_AGENT_HISTORY_INVALID',
      });
      expect(agenetes.close).not.toHaveBeenCalled();
      expect(agenetes.rehome).not.toHaveBeenCalled();
      assertReleased();
    });

    it.each(['source-write', 'publication'] as const)(
      'restores durable ownership and complete Agent state after %s failure',
      async (failurePhase) => {
        await seed(['internal', 'external']);
        const publish = vi.spyOn(canvasSync, 'publishCanvasUpdate');
        if (failurePhase === 'publication')
          publish.mockImplementationOnce(() => {
            throw new Error(PRIVATE_ERROR);
          });
        else {
          const execute = executor.executeOnServerAlreadyLocked;
          vi.spyOn(executor, 'executeOnServerAlreadyLocked').mockImplementation(
            (input) => {
              if (input.canvasId === SOURCE) throw new Error(PRIVATE_ERROR);
              return execute(input);
            },
          );
        }
        await expect(move()).rejects.toMatchObject({ code: 'MOVE_FAILED' });
        await assertRestored();
        expect(handles).toHaveLength(2);
        expect(runtime.get(THREAD)).toBeUndefined();
        expect(publish).toHaveBeenCalledTimes(
          failurePhase === 'publication' ? 1 : 0,
        );
      },
    );

    it.each(['rehome', 'compensation'] as const)(
      'retains a newly created destination when %s has an unknown outcome',
      async (failurePhase) => {
        await seed();
        const remove = vi.spyOn(storage, 'deleteSpace');
        const inverse = vi.spyOn(executor, 'applyDeltasOnServerAlreadyLocked');
        if (failurePhase === 'rehome') {
          vi.mocked(agenetes.rehome).mockImplementationOnce(() => {
            throw new AgenetesError('rehome_unknown_outcome', PRIVATE_ERROR);
          });
        } else {
          vi.spyOn(canvasSync, 'publishCanvasUpdate').mockImplementationOnce(
            () => {
              throw new Error(PRIVATE_ERROR);
            },
          );
          inverse.mockRejectedValueOnce(new Error(PRIVATE_ERROR));
        }
        await expect(
          move({ kind: 'new', title: 'Synthetic retained destination' }),
        ).rejects.toMatchObject({
          code: 'MOVE_OUTCOME_UNKNOWN',
          statusCode: 500,
        });
        expect(remove).not.toHaveBeenCalled();
        if (failurePhase === 'rehome') expect(inverse).not.toHaveBeenCalled();
        expect(
          (await storage.getStructuredStore().spaces().list()).some(
            (entry) => entry.title === 'Synthetic retained destination',
          ),
        ).toBe(true);
        expect(
          JSON.stringify([...warn.mock.calls, ...errorLog.mock.calls]),
        ).not.toContain(PRIVATE_ERROR);
        assertReleased();
      },
    );

    it('removes a newly created destination after a determinate close failure', async () => {
      await seed();
      closeFailure = true;
      await expect(
        move({ kind: 'new', title: 'Synthetic temporary destination' }),
      ).rejects.toMatchObject({ code: 'MOVE_AGENT_CLOSE_FAILED' });
      expect(
        (await storage.getStructuredStore().spaces().list()).some(
          (entry) => entry.title === 'Synthetic temporary destination',
        ),
      ).toBe(false);
      assertReleased();
    });

    it('reports cleanup failure without exposing either cause', async () => {
      await seed();
      closeFailure = true;
      vi.spyOn(storage, 'deleteSpace').mockRejectedValueOnce(
        new Error(PRIVATE_ERROR),
      );
      await expect(
        move({ kind: 'new', title: 'Synthetic cleanup failure' }),
      ).rejects.toMatchObject({
        code: 'MOVE_DESTINATION_CLEANUP_FAILED',
        statusCode: 500,
      });
      expect(
        JSON.stringify([...warn.mock.calls, ...errorLog.mock.calls]),
      ).not.toContain(PRIVATE_ERROR);
      assertReleased();
    });

    it.each([
      ['close', 'MOVE_AGENT_CLOSE_FAILED', 500],
      ['rehome', 'MOVE_AGENT_REHOME_FAILED', 500],
      ['conflict', 'MOVE_DESTINATION_CONFLICT', 409],
      ['unknown', 'MOVE_OUTCOME_UNKNOWN', 500],
    ] as const)(
      'returns only a bounded HTTP error for %s failure',
      async (failurePhase, code, status) => {
        await seed();
        if (failurePhase === 'close') closeFailure = true;
        else
          vi.mocked(agenetes.rehome).mockImplementationOnce(() => {
            if (failurePhase === 'conflict')
              throw new AgenetesError('rehome_conflict', PRIVATE_ERROR);
            if (failurePhase === 'unknown')
              throw new AgenetesError('rehome_unknown_outcome', PRIVATE_ERROR, {
                private: PRIVATE_ERROR,
              });
            throw new Error(PRIVATE_ERROR);
          });
        const app = fastify();
        await app.register(multipart);
        await app.register(canvasRoutes);
        try {
          const response = await app.inject({
            method: 'POST',
            url: `/${SOURCE}/move-selection`,
            payload: {
              selectedNodeIds: nodes.map((node) => node.id),
              destination: { kind: 'existing', canvasId: DESTINATION },
              createSourcePreview: true,
              expectedSourceVersion: 1,
            },
          });
          expect(response.statusCode).toBe(status);
          expect(response.json()).toEqual({
            code,
            message: expect.any(String),
          });
          expect(response.body).not.toContain(PRIVATE_ERROR);
          expect(response.body).not.toContain(SOURCE);
          expect(response.body).not.toContain(THREAD);
        } finally {
          await app.close();
        }
      },
    );

    it('redacts unexpected admission failures and malformed request fields at the route boundary', async () => {
      await seed();
      const app = fastify();
      await app.register(multipart);
      await app.register(canvasRoutes);
      const payload = {
        selectedNodeIds: nodes.map((node) => node.id),
        destination: { kind: 'existing', canvasId: DESTINATION },
        createSourcePreview: true,
        expectedSourceVersion: 1,
      };
      try {
        const malformed = await app.inject({
          method: 'POST',
          url: `/${SOURCE}/move-selection`,
          payload: { ...payload, [PRIVATE_ERROR]: true },
        });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json()).toEqual({
          code: 'MOVE_FAILED',
          message: 'Invalid move request',
        });
        vi.spyOn(storage, 'isWorldCanvasId').mockImplementationOnce(() => {
          throw new Error(PRIVATE_ERROR);
        });
        const failed = await app.inject({
          method: 'POST',
          url: `/${SOURCE}/move-selection`,
          payload,
        });
        expect(failed.statusCode).toBe(500);
        expect(failed.json()).toEqual({
          code: 'MOVE_FAILED',
          message: 'The selection could not be moved',
        });
        expect(failed.body).not.toContain(PRIVATE_ERROR);
      } finally {
        await app.close();
      }
    });
  });
});
