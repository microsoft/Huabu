// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createId } from '@huabu/shared';

import { agenetes } from './agenetes/drivers.js';
import { buildHuabuPiWorkloadSpec } from './agenetes/pi-driver.js';
import {
  agentNodeBinding,
  AgentNodeBindingCoordinator,
} from './agent-node-binding.js';
import { agentNodeLifecycle } from './agent-node-lifecycle.js';
import { agentThreadResolver } from './agent-thread-resolver.js';
import { acquireAgentTurn } from './turn-lease.js';
import {
  applyDeltasOnServerAlreadyLocked,
  executeOnServer,
} from '../canvas/canvas-executor.js';
import canvasRoutes from '../canvas/canvas.route.js';
import { createSpace, space, withCanvasMutex } from '../storage/index.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import {
  acquireWorkspaceOperationLease,
  commitWorkspaceIdentity,
  getWorkspaceHandle,
  getWorkspaceKey,
  isWorkspaceLeased,
  WorkspaceOperationInProgressError,
} from '../workspace.js';

import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

forEachProductProfile((profile, label) => {
  describe(`Agent Node runtime persistence (${label})`, () => {
    let mounted: MountedTestStorage;
    let target: AgentNodeTarget;

    beforeEach(async () => {
      mounted = await mountTestWorkspace(profile, 'agent-fsm-runtime-');
      const canvasId = createId('canvas');
      const created = await createSpace(canvasId, 'Runtime FSM');
      if (!created.ok) throw new Error('Space creation failed');
      target = {
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
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      if (target) await agenetes.close(target.threadId);
      await mounted?.close();
    });

    async function createCanonicalExecution(
      workloadType: 'Deployment' | 'Job' = 'Deployment',
    ) {
      return await agenetes.create(
        buildHuabuPiWorkloadSpec({
          kind: 'internal',
          workloadType,
          threadId: target.threadId,
          namespace: canvasAcpNamespace(target.canvasId),
          canvasId: target.canvasId,
          systemPrompt: 'Test',
          toolNames: [],
          initialMessages: [],
          maxIterations: 1,
          toolExecution: 'sequential',
        }),
      );
    }

    async function current() {
      const canvas = await space(target.canvasId).read();
      if (!canvas) throw new Error('Space disappeared');
      return canvas.state.nodes[0] as CanvasNode;
    }

    function assertWorkspacePinned() {
      const workspace = getWorkspaceHandle();
      if (!workspace) throw new Error('Missing fixture Workspace');
      expect(isWorkspaceLeased(getWorkspaceKey())).toBe(true);
      expect(() =>
        commitWorkspaceIdentity({
          ...workspace,
          workspaceId: `${workspace.workspaceId}-other`,
        }),
      ).toThrow(WorkspaceOperationInProgressError);
    }

    it.each([
      ['record', false],
      ['record', true],
      ['history', false],
      ['history', true],
    ] as const)(
      'pins binding confirmation across delayed %s (failure: %s)',
      async (stage, fails) => {
        if (stage === 'record') await createCanonicalExecution();
        const entered = deferred();
        const proceed = deferred();
        const pause = async () => {
          entered.resolve();
          await proceed.promise;
          if (fails) throw new Error('Binding read unavailable');
        };
        const record = agenetes.record.bind(agenetes);
        const history = agenetes.history.bind(agenetes);
        const read =
          stage === 'record'
            ? vi
                .spyOn(agenetes, 'record')
                .mockImplementation(async (...args) => {
                  await pause();
                  return record(...args);
                })
            : vi
                .spyOn(agenetes, 'history')
                .mockImplementation(async (...args) => {
                  await pause();
                  return history(...args);
                });
        const pending = agentNodeBinding.confirm(target);
        const settled = fails
          ? expect(pending).rejects.toThrow('Binding read unavailable')
          : expect(pending).resolves.toEqual(
              stage === 'record' ? { kind: 'internal' } : null,
            );
        await entered.promise;
        try {
          assertWorkspacePinned();
          expect((await current()).data.bindingState).toBe('editing');
        } finally {
          proceed.resolve();
          await settled;
        }
        expect(read).toHaveBeenCalledOnce();
        expect(isWorkspaceLeased(getWorkspaceKey())).toBe(false);
        expect(target.bindingState).toBe(
          stage === 'record' && !fails ? 'bound' : 'editing',
        );
        expect((await current()).data.bindingState).toBe(target.bindingState);
      },
    );

    it('retains the binding lease while promotion waits for the Canvas mutex', async () => {
      await createCanonicalExecution();
      const entered = deferred();
      const proceed = deferred();
      const blocker = withCanvasMutex(target.canvasId, async () => {
        entered.resolve();
        await proceed.promise;
      });
      await entered.promise;
      const pending = agentNodeBinding.confirm(target, {
        record: await agenetes.record(
          canvasAcpNamespace(target.canvasId),
          target.threadId,
        ),
      });
      try {
        assertWorkspacePinned();
        expect((await current()).data.bindingState).toBe('editing');
      } finally {
        proceed.resolve();
        await Promise.all([blocker, pending]);
      }
      expect(isWorkspaceLeased(getWorkspaceKey())).toBe(false);
      expect((await current()).data.bindingState).toBe('bound');
    });

    it.each(['Deployment', 'Job'] as const)(
      'confirms a durable %s record before any run starts',
      async (workloadType) => {
        await createCanonicalExecution(workloadType);
        const namespace = canvasAcpNamespace(target.canvasId);
        expect(
          (await agenetes.record(namespace, target.threadId))?.spec
            .workloadType,
        ).toBe(workloadType);
        expect(
          (await agenetes.history(namespace, target.threadId)).turns,
        ).toHaveLength(0);
        await agentNodeBinding.confirm(target, { required: true });
        expect((await current()).data).toMatchObject({ bindingState: 'bound' });
        expect((await current()).data).not.toHaveProperty('invocationToken');
        expect((await current()).data).not.toHaveProperty('status');
        expect(
          (await space(target.canvasId).nodes.read(target.nodeId))?.record
            .content,
        ).toBe('');
      },
    );

    it('persists both FSM projections through the portable writer and keeps stale terminals inert', async () => {
      await createCanonicalExecution();
      await agentNodeBinding.confirm(target, { required: true });
      await agentNodeLifecycle.start(target, 'First submitted intent', 'first');
      await agentNodeLifecycle.error(target, 'Preparation failed', 'first');
      await agentNodeLifecycle.start(target, 'Follow-up', 'second');
      await agentNodeLifecycle.done(target, 'first');
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        invocationToken: 'second',
        status: 'running',
      });
      expect(
        (await space(target.canvasId).nodes.read(target.nodeId))?.record
          .content,
      ).toBe('First submitted intent');
      await agentNodeLifecycle.done(target, 'second');
      await agentNodeLifecycle.acknowledge(target, 'first');
      expect((await current()).data.viewed).toBe(false);
      await agentNodeLifecycle.acknowledge(target, 'second');
      expect((await current()).data.viewed).toBe(true);
      await agenetes.close(target.threadId);
      await mounted.reopen();
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        invocationToken: 'second',
        status: 'done',
        viewed: true,
      });
      const loaded = await agentThreadResolver.resolveAgentNode(
        target.canvasId,
        target.threadId,
      );
      if (!loaded) throw new Error('Agent Node disappeared');
      expect(await agentNodeBinding.confirm(loaded)).toEqual({
        kind: 'internal',
      });
    });

    it('completes the partial record-to-Bound write inside the next guarded edit without rebinding', async () => {
      await createCanonicalExecution();
      const coordinator = new AgentNodeBindingCoordinator({
        record: () =>
          agenetes.record(canvasAcpNamespace(target.canvasId), target.threadId),
        hasHistory: () => false,
        promote: vi.fn().mockRejectedValue(new Error('Projection unavailable')),
        acquireTurn: acquireAgentTurn,
        acquireWorkspaceLease: acquireWorkspaceOperationLease,
      });
      await expect(coordinator.confirm(target)).rejects.toThrow(
        'Projection unavailable',
      );
      expect((await current()).data.bindingState).toBe('editing');
      await expect(
        executeOnServer({
          canvasId: target.canvasId,
          originator: { source: 'ui' },
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: target.nodeId,
                  patch: {
                    agentBinding: {
                      kind: 'external',
                      profileId: 'new',
                      alias: 'Other',
                    },
                  },
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'agent_binding_conflict' });
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        agentBinding: { kind: 'internal' },
      });
    });

    it('rejects draft edits nonblockingly during admission and allows fresh projection writes', async () => {
      const release = acquireAgentTurn(
        target.threadId,
        canvasAcpNamespace(target.canvasId),
      );
      if (!release) throw new Error('Unexpected busy thread');
      try {
        await expect(
          executeOnServer({
            canvasId: target.canvasId,
            originator: { source: 'ui' },
            commands: [
              {
                type: 'MERGE_NODE_DATA',
                patches: [
                  {
                    nodeId: target.nodeId,
                    patch: {
                      agentLaunchOverrides: {
                        additionalInitialPreamble: 'Late draft',
                      },
                    },
                  },
                ],
              },
            ],
          }),
        ).rejects.toMatchObject({ code: 'agent_draft_busy' });
        await agentNodeLifecycle.start(target, 'Admitted prompt', 'admitted');
        expect((await current()).data).toMatchObject({
          invocationToken: 'admitted',
          status: 'running',
          bindingState: 'editing',
        });
      } finally {
        release();
      }
    });

    it.each(['command', 'put', 'delta'] as const)(
      'preserves the same-config binding and version policy during %s Save',
      async (operation) => {
        await createCanonicalExecution();
        const before = await space(target.canvasId).read();
        if (!before) throw new Error('Space disappeared');
        const node = await current();
        expect(node.data.bindingState).toBe('editing');
        const expectedBindingState = operation === 'put' ? 'editing' : 'bound';
        const expectedVersion = before.version + (operation === 'put' ? 1 : 2);
        const expectedLabel = operation === 'put' ? 'Agent' : 'Saved';
        const expectedPosition =
          operation === 'put' ? { x: 40, y: 60 } : node.position;
        if (operation === 'command') {
          const result = await executeOnServer({
            canvasId: target.canvasId,
            originator: { source: 'ui' },
            commands: [
              {
                type: 'MERGE_NODE_DATA',
                patches: [
                  {
                    nodeId: target.nodeId,
                    patch: {
                      agentBinding: { kind: 'internal' },
                      label: 'Saved',
                    },
                  },
                ],
              },
            ],
          });
          expect(result.fromVersion).toBe(before.version + 1);
          expect(result.toVersion).toBe(before.version + 2);
        } else if (operation === 'put') {
          const app = fastify();
          try {
            await app.register(multipart);
            await app.register(canvasRoutes, { prefix: '/canvas' });
            const response = await app.inject({
              method: 'PUT',
              url: `/canvas/${target.canvasId}`,
              payload: {
                version: before.version,
                state: {
                  ...before.state,
                  nodes: [
                    {
                      ...node,
                      position: expectedPosition,
                      data: {
                        agentBinding: { kind: 'internal' },
                        label: 'Saved',
                      },
                    },
                  ],
                },
              },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().version).toBe(expectedVersion);
          } finally {
            await app.close();
          }
        } else {
          const result = await withCanvasMutex(target.canvasId, () =>
            applyDeltasOnServerAlreadyLocked({
              canvasId: target.canvasId,
              originator: { source: 'ui' },
              deltas: [
                {
                  type: 'REPLACE_NODE',
                  prev: node,
                  next: { ...node, data: { ...node.data, label: 'Saved' } },
                },
              ],
            }),
          );
          expect(result.fromVersion).toBe(before.version + 1);
          expect(result.toVersion).toBe(before.version + 2);
        }
        expect((await current()).data).toMatchObject({
          bindingState: expectedBindingState,
          agentBinding: { kind: 'internal' },
        });
        expect(
          (await space(target.canvasId).nodes.read(target.nodeId))?.record
            .label,
        ).toBe(expectedLabel);
        expect((await current()).position).toEqual(expectedPosition);
        await agenetes.close(target.threadId);
        await mounted.reopen();
        expect((await current()).data).toMatchObject({
          bindingState: expectedBindingState,
          agentBinding: { kind: 'internal' },
        });
        expect(
          (await space(target.canvasId).nodes.read(target.nodeId))?.record
            .label,
        ).toBe(expectedLabel);
        expect((await current()).position).toEqual(expectedPosition);
        expect((await space(target.canvasId).read())?.version).toBe(
          expectedVersion,
        );
      },
    );

    it('keeps the promotion even when the rest of the command is a no-op', async () => {
      await createCanonicalExecution();
      const canvas = await space(target.canvasId).read();
      if (!canvas) throw new Error('Space disappeared');
      const before = canvas.version;
      const result = await executeOnServer({
        canvasId: target.canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: target.nodeId,
                patch: { agentBinding: { kind: 'internal' } },
              },
            ],
          },
        ],
      });
      expect(result.fromVersion).toBe(before + 1);
      expect(result.toVersion).toBe(before + 1);
      expect((await current()).data.bindingState).toBe('bound');
    });

    it('allows a layout PUT with unchanged preparation while a prompt is admitted', async () => {
      const release = acquireAgentTurn(
        target.threadId,
        canvasAcpNamespace(target.canvasId),
      );
      if (!release) throw new Error('Unexpected busy thread');
      const app = fastify();
      try {
        await app.register(multipart);
        await app.register(canvasRoutes, { prefix: '/canvas' });
        const canvas = await space(target.canvasId).read();
        if (!canvas) throw new Error('Space disappeared');
        const response = await app.inject({
          method: 'PUT',
          url: `/canvas/${target.canvasId}`,
          payload: {
            version: canvas.version,
            state: {
              nodes: [
                {
                  id: target.nodeId,
                  type: 'question',
                  position: { x: 42, y: 0 },
                  data: { agentBinding: { kind: 'internal' } },
                },
              ],
              edges: [],
            },
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect((await current()).position).toEqual({ x: 42, y: 0 });
      } finally {
        release();
        await app.close();
      }
    });

    it('does not confirm or lock an untouched draft while replaying another node', async () => {
      const created = await executeOnServer({
        canvasId: target.canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: createId('node'),
                nodeType: 'text',
                position: { x: 50, y: 50 },
                data: { content: 'Text' },
              },
            ],
          },
        ],
      });
      const inserted = created.deltas.find(
        (delta) => delta.type === 'INSERT_NODE',
      );
      if (!inserted || inserted.type !== 'INSERT_NODE')
        throw new Error('Text was not created');
      const release = acquireAgentTurn(
        target.threadId,
        canvasAcpNamespace(target.canvasId),
      );
      if (!release) throw new Error('Unexpected busy thread');
      try {
        await withCanvasMutex(target.canvasId, () =>
          applyDeltasOnServerAlreadyLocked({
            canvasId: target.canvasId,
            originator: { source: 'ui' },
            deltas: [
              {
                type: 'REPLACE_NODE',
                prev: inserted.node,
                next: { ...inserted.node, position: { x: 100, y: 100 } },
              },
            ],
          }),
        );
        expect((await current()).data.bindingState).toBe('editing');
      } finally {
        release();
      }
    });
  });
});
