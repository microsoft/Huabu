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

import type { AgentNodeTarget } from './agent-thread-resolver.js';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

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
      if (target) agenetes.close(target.threadId);
      await mounted?.close();
    });

    function createCanonicalExecution(
      workloadType: 'Deployment' | 'Job' = 'Deployment',
    ) {
      return agenetes.create(
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

    it.each(['Deployment', 'Job'] as const)(
      'confirms a durable %s record before any run starts',
      async (workloadType) => {
        createCanonicalExecution(workloadType);
        const namespace = canvasAcpNamespace(target.canvasId);
        expect(
          agenetes.record(namespace, target.threadId)?.spec.workloadType,
        ).toBe(workloadType);
        expect(agenetes.history(namespace, target.threadId).turns).toHaveLength(
          0,
        );
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
      createCanonicalExecution();
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
      agenetes.close(target.threadId);
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
      createCanonicalExecution();
      const coordinator = new AgentNodeBindingCoordinator({
        record: () =>
          agenetes.record(canvasAcpNamespace(target.canvasId), target.threadId),
        hasHistory: () => false,
        promote: vi.fn().mockRejectedValue(new Error('Projection unavailable')),
        acquireTurn: acquireAgentTurn,
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
      const release = acquireAgentTurn(target.threadId);
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
      'keeps same-config promotion and fresh CAS during %s Save',
      async (operation) => {
        createCanonicalExecution();
        const before = await space(target.canvasId).read();
        if (!before) throw new Error('Space disappeared');
        const node = await current();
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
            expect(response.json().version).toBe(before.version + 2);
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
          bindingState: 'bound',
          agentBinding: { kind: 'internal' },
        });
        agenetes.close(target.threadId);
        await mounted.reopen();
        expect((await current()).data.bindingState).toBe('bound');
        expect((await space(target.canvasId).read())?.version).toBe(
          before.version + 2,
        );
      },
    );

    it('keeps the promotion even when the rest of the command is a no-op', async () => {
      createCanonicalExecution();
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
      const release = acquireAgentTurn(target.threadId);
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
      const release = acquireAgentTurn(target.threadId);
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
