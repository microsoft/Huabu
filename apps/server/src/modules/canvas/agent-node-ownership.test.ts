// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createId } from '@huabu/shared';

import {
  projectAgentNodeState,
  acknowledgeAgentNodeResult,
} from './agent-node-projection.js';
import { applyDeltasOnServer, executeOnServer } from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import { agenetes } from '../agent/agenetes/drivers.js';
import { createSpace, space } from '../storage/index.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';

forEachProductProfile((profile, label) => {
  describe(`Agent Node Canvas ownership (${label})`, () => {
    let mounted: MountedTestStorage;
    let app: FastifyInstance;
    let canvasId: string;
    let node: CanvasNode;

    beforeEach(async () => {
      mounted = await mountTestWorkspace(profile, 'agent-node-ownership-');
      canvasId = createId('canvas');
      const created = await createSpace(canvasId, 'Agent ownership');
      if (!created.ok) throw new Error('Failed to seed Space');
      node = {
        id: 'node-agent',
        type: 'question',
        position: { x: 0, y: 0 },
        data: {
          threadId: 'thread-agent',
          bindingState: 'editing',
          agentBinding: { kind: 'internal' },
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
            nodeId: node.id,
            record: {
              nodeId: node.id,
              type: 'question',
              label: 'Agent',
              content: '',
            },
            authoritativeInsert: true,
          },
        ],
      });
      app = fastify();
      await app.register(canvasRoutes, { prefix: '/canvas' });
      await app.ready();
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await app?.close();
      await mounted?.close();
    });

    async function currentCanvas() {
      const canvas = await space(canvasId).read();
      if (!canvas) throw new Error('Test Space disappeared');
      return canvas;
    }

    async function current(): Promise<CanvasNode> {
      return (await currentCanvas()).state.nodes[0] as CanvasNode;
    }

    it('initializes a legacy Question once without creating an execution record', async () => {
      const canvas = await currentCanvas();
      await space(canvasId).write({
        expectedVersion: canvas.version,
        nextRecord: {
          ...canvas,
          version: canvas.version + 1,
          state: { ...canvas.state, nodes: [{ ...node, data: {} }] },
        },
        nodeMutations: [],
      });
      const create = vi.spyOn(agenetes, 'create');
      const request = {
        method: 'POST' as const,
        url: `/canvas/${canvasId}/nodes/${node.id}/association`,
        payload: { kind: 'initialize' },
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      const data = first.json().node.data;
      expect(data).toMatchObject({
        bindingState: 'editing',
        threadId: expect.stringMatching(/^thread-/),
      });
      const second = await app.inject(request);
      expect(second.json().node.data.threadId).toBe(data.threadId);
      expect(second.json().toVersion).toBe(first.json().toVersion);
      expect(create).not.toHaveBeenCalled();
    });

    it('validates reinsertion and never attaches a different thread to an existing node', async () => {
      const restore = {
        kind: 'restore',
        node: { ...node, data: {} },
        threadId: 'other-thread',
        requireBinding: false,
      };
      const url = `/canvas/${canvasId}/nodes/${node.id}/association`;
      expect(
        (await app.inject({ method: 'POST', url, payload: restore }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: {
              ...restore,
              node: { ...node, data: { status: 'done' } },
            },
          })
        ).statusCode,
      ).toBe(400);
      expect((await current()).data.threadId).toBe('thread-agent');
    });

    it('confirms the restored thread and discards historical invocation metadata', async () => {
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          { type: 'DELETE_NODES', nodeIds: [node.id as `node-${string}`] },
        ],
      });
      vi.spyOn(agenetes, 'record').mockReturnValue({
        spec: {
          threadId: 'thread-agent',
          namespace: { name: canvasId },
          kind: 'internal',
          workloadType: 'Deployment',
          spec: {},
        },
        state: { driverState: {} },
        driverSchemaVersion: 1,
      } as NonNullable<ReturnType<typeof agenetes.record>>);
      const response = await app.inject({
        method: 'POST',
        url: `/canvas/${canvasId}/nodes/${node.id}/association`,
        payload: {
          kind: 'restore',
          node: { ...node, data: { content: 'Preserved intent' } },
          threadId: 'thread-agent',
          requireBinding: true,
        },
      });
      expect(response.statusCode).toBe(200);
      expect((await current()).data).toMatchObject({
        threadId: 'thread-agent',
        bindingState: 'bound',
        agentBinding: { kind: 'internal' },
      });
      expect((await current()).data).not.toHaveProperty('invocationToken');
      expect((await space(canvasId).nodes.read(node.id))?.record.content).toBe(
        'Preserved intent',
      );
    });

    it('rejects resurrection of a Bound node with a missing record', async () => {
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          { type: 'DELETE_NODES', nodeIds: [node.id as `node-${string}`] },
        ],
      });
      const response = await app.inject({
        method: 'POST',
        url: `/canvas/${canvasId}/nodes/${node.id}/association`,
        payload: {
          kind: 'restore',
          node: { ...node, data: {} },
          threadId: 'thread-agent',
          requireBinding: true,
        },
      });
      expect(response.statusCode).toBe(409);
      expect((await currentCanvas()).state.nodes).toHaveLength(0);
      await expect(
        applyDeltasOnServer({
          canvasId,
          originator: { source: 'ui' },
          deltas: [
            {
              type: 'INSERT_NODE',
              node: {
                ...node,
                data: {
                  ...node.data,
                  bindingState: 'bound',
                  invocationToken: 'old',
                  status: 'done',
                },
              },
            },
          ],
        }),
      ).rejects.toThrow('no canonical execution record');
    });

    it('confirms a realized chat attachment and rejects duplicate thread owners', async () => {
      vi.spyOn(agenetes, 'record').mockReturnValue({
        spec: {
          threadId: 'thread-attached',
          namespace: { name: canvasId },
          kind: 'internal',
          workloadType: 'Deployment',
          spec: {},
        },
        state: { driverState: {} },
        driverSchemaVersion: 1,
      } as NonNullable<ReturnType<typeof agenetes.record>>);
      await executeOnServer({
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
                data: {
                  threadId: 'thread-attached',
                  status: 'error',
                  invocationToken: 'old',
                },
              },
            ],
          },
        ],
      });
      const attached = (
        (await currentCanvas()).state.nodes as CanvasNode[]
      ).find((entry) => entry.id === 'node-attached');
      if (!attached) throw new Error('Chat attachment was not created');
      expect(attached.data).toMatchObject({
        threadId: 'thread-attached',
        bindingState: 'bound',
        agentBinding: { kind: 'internal' },
      });
      expect(attached.data).not.toHaveProperty('status');
      const response = await app.inject({
        method: 'POST',
        url: `/canvas/${canvasId}/nodes/node-duplicate/association`,
        payload: {
          kind: 'restore',
          node: { ...node, id: 'node-duplicate', data: {} },
          threadId: 'thread-attached',
          requireBinding: true,
        },
      });
      expect(response.statusCode).toBe(409);
    });

    it('fences stale terminal writes and acknowledgements, preserving first submitted content', async () => {
      const events: unknown[] = [];
      const unsubscribe = subscribeCanvasUpdates(canvasId, (event) =>
        events.push(event),
      );
      try {
        await projectAgentNodeState(canvasId, node.id, {
          threadId: 'thread-agent',
          invocationToken: 'first',
          status: 'running',
          initialContent: 'First intent',
        });
        await projectAgentNodeState(canvasId, node.id, {
          threadId: 'thread-agent',
          expectedInvocationToken: 'first',
          status: 'error',
          viewed: false,
        });
        await projectAgentNodeState(canvasId, node.id, {
          threadId: 'thread-agent',
          invocationToken: 'second',
          status: 'running',
          initialContent: 'Do not overwrite',
        });
        expect(
          await projectAgentNodeState(canvasId, node.id, {
            threadId: 'thread-agent',
            expectedInvocationToken: 'first',
            status: 'done',
          }),
        ).toBe(false);
        expect(
          await acknowledgeAgentNodeResult(canvasId, node.id, 'first'),
        ).toBe(false);
        expect(
          await acknowledgeAgentNodeResult(canvasId, node.id, 'second'),
        ).toBe(false);
        await projectAgentNodeState(canvasId, node.id, {
          threadId: 'thread-agent',
          expectedInvocationToken: 'second',
          status: 'done',
          viewed: false,
        });
        const acknowledged = await app.inject({
          method: 'POST',
          url: `/canvas/${canvasId}/nodes/${node.id}/viewed`,
          payload: { invocationToken: 'second' },
        });
        expect(acknowledged.json()).toEqual({ acknowledged: true });
        expect((await current()).data).toMatchObject({
          invocationToken: 'second',
          status: 'done',
          viewed: true,
        });
        expect(
          (await space(canvasId).nodes.read(node.id))?.record.content,
        ).toBe('First intent');
        expect(events).toHaveLength(5);
        expect(
          events.every(
            (event) =>
              (event as { data: { agentNodeProjection?: boolean } }).data
                .agentNodeProjection,
          ),
        ).toBe(true);
      } finally {
        unsubscribe();
      }
    });

    it('acknowledges legacy terminal attention only while no invocation token has superseded it', async () => {
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        status: 'done',
        viewed: false,
      });
      const url = `/canvas/${canvasId}/nodes/${node.id}/viewed`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { invocationToken: null },
          })
        ).json(),
      ).toEqual({ acknowledged: true });
      expect((await current()).data.viewed).toBe(true);
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        invocationToken: 'new',
        status: 'done',
        viewed: false,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { invocationToken: null },
          })
        ).json(),
      ).toEqual({ acknowledged: false });
      expect((await current()).data.viewed).toBe(false);
    });

    it('rejects forbidden PUT and MERGE writes but composes omitted metadata from fresh state', async () => {
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        bindingState: 'bound',
        invocationToken: 'current',
        status: 'done',
      });
      const version = (await currentCanvas()).version;
      const forged = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version,
          state: { nodes: [{ ...node, data: { status: 'idle' } }], edges: [] },
        },
      });
      expect(forged.statusCode).toBe(400);
      const merged = await executeOnServer({
        canvasId,
        originator: { source: 'system' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-agent',
                patch: { threadId: 'other', bindingState: 'editing' },
              },
            ],
          },
        ],
      });
      expect(merged.results[0]?.applied).toBe(false);
      const saved = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version,
          state: {
            nodes: [
              {
                id: node.id,
                type: 'question',
                position: { x: 100, y: 20 },
                data: { label: 'New' },
              },
            ],
            edges: [],
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        invocationToken: 'current',
        status: 'done',
        threadId: 'thread-agent',
      });
    });

    it('validates stored Question ownership when a PUT omits the node type', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version: (await currentCanvas()).version,
          state: { nodes: [{ id: node.id, data: { status: 'done' } }] },
        },
      });
      expect(response.statusCode).toBe(400);
      expect((await current()).data).not.toHaveProperty('status');
    });

    it('preserves unrelated node metadata without carrying it into a new Question identity', async () => {
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: 'node-note',
                nodeType: 'note',
                position: { x: 20, y: 20 },
                data: {
                  content: 'Note',
                },
              },
            ],
          },
        ],
      });
      const result = await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-note',
                patch: { status: 'updated', threadId: 'reference' },
              },
            ],
          },
        ],
      });
      expect(result.results[0]?.applied).toBe(true);
      const canvas = await currentCanvas();
      const response = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version: canvas.version,
          state: {
            nodes: [
              { id: node.id, type: 'question', data: {} },
              {
                id: 'node-note',
                type: 'note',
                data: { status: 'saved', threadId: 'reference' },
              },
            ],
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const converted = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version: response.json().version,
          state: {
            nodes: [
              { id: node.id, type: 'question', data: {} },
              { id: 'node-note', type: 'question', data: {} },
            ],
          },
        },
      });
      expect(converted.statusCode).toBe(200);
      const question = (await currentCanvas()).state.nodes.find(
        (entry) => (entry as CanvasNode).id === 'node-note',
      ) as CanvasNode;
      expect(question.data).toMatchObject({ bindingState: 'editing' });
      expect(question.data).not.toHaveProperty('status');
      expect(question.data.threadId).not.toBe('reference');
    });

    it('retains live FSM and preparation when reverting an unrelated historical edit', async () => {
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        bindingState: 'bound',
        invocationToken: 'current',
        status: 'running',
      });
      const before = {
        ...node,
        position: { x: 50, y: 0 },
        data: { ...node.data, content: '', label: 'Agent' },
      };
      const after = { ...before, position: { x: 0, y: 0 } };
      await applyDeltasOnServer({
        canvasId,
        originator: { source: 'ui' },
        deltas: [{ type: 'REPLACE_NODE', prev: before, next: after }],
      });
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        invocationToken: 'current',
        status: 'running',
      });
      await expect(
        executeOnServer({
          canvasId,
          originator: { source: 'ui' },
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: 'node-agent',
                  patch: {
                    agentBinding: {
                      kind: 'external',
                      alias: 'Other',
                      profileId: 'other',
                    },
                  },
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow('after binding');
    });

    it('distinguishes an omitted prompt from an explicit empty prompt', async () => {
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        invocationToken: 'first',
        status: 'error',
        initialContent: 'Submitted intent',
      });
      const omitted = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}/nodes/${node.id}/content`,
        payload: { nodeType: 'question', label: 'Renamed' },
      });
      expect(omitted.statusCode).toBe(200);
      expect((await space(canvasId).nodes.read(node.id))?.record.content).toBe(
        'Submitted intent',
      );
      const cleared = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}/nodes/${node.id}/content`,
        payload: { nodeType: 'question', content: '' },
      });
      expect(cleared.statusCode).toBe(200);
      expect((await space(canvasId).nodes.read(node.id))?.record.content).toBe(
        '',
      );
      expect((await current()).data.invocationToken).toBe('first');
    });

    it('does not reset a live identity by deleting and recreating the same node in one command batch', async () => {
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        bindingState: 'bound',
        invocationToken: 'current',
        status: 'done',
      });
      await expect(
        executeOnServer({
          canvasId,
          originator: { source: 'ui' },
          commands: [
            { type: 'DELETE_NODES', nodeIds: ['node-agent'] },
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-agent',
                  nodeType: 'question',
                  position: { x: 0, y: 0 },
                  data: { threadId: 'other' },
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow('cannot be recreated');
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        threadId: 'thread-agent',
        invocationToken: 'current',
      });
    });

    it('promotes an existing canonical record before rejecting a legacy draft edit without reentering the Canvas lock', async () => {
      const record = {
        spec: {
          threadId: 'thread-agent',
          namespace: { name: canvasId },
          kind: 'internal',
          workloadType: 'Deployment',
          spec: {},
        },
        state: { driverState: {} },
        driverSchemaVersion: 1,
      } as NonNullable<ReturnType<typeof agenetes.record>>;
      const readRecord = vi.spyOn(agenetes, 'record').mockReturnValue(record);
      const response = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version: 1,
          state: {
            nodes: [
              {
                id: node.id,
                type: 'question',
                data: {
                  agentBinding: {
                    kind: 'external',
                    alias: 'Different',
                    profileId: 'different',
                  },
                },
              },
            ],
            edges: [],
          },
        },
      });
      expect(response.statusCode).toBe(409);
      expect((await current()).data).toMatchObject({
        bindingState: 'bound',
        agentBinding: { kind: 'internal' },
      });
      expect(readRecord).toHaveBeenCalledOnce();
      const saved = await app.inject({
        method: 'PUT',
        url: `/canvas/${canvasId}`,
        payload: {
          version: (await currentCanvas()).version,
          state: {
            nodes: [
              {
                id: node.id,
                type: 'question',
                position: { x: 10, y: 10 },
                data: {},
              },
            ],
            edges: [],
          },
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(readRecord).toHaveBeenCalledOnce();
    });

    it('allows an explicit override reset while Editing and rejects its inverse after Bound', async () => {
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-agent',
                patch: { agentLaunchOverrides: { workingDirPath: '/work' } },
              },
            ],
          },
        ],
      });
      const reset = await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              { nodeId: 'node-agent', patch: { agentLaunchOverrides: null } },
            ],
          },
        ],
      });
      expect((await current()).data).not.toHaveProperty('agentLaunchOverrides');
      await projectAgentNodeState(canvasId, node.id, {
        threadId: 'thread-agent',
        bindingState: 'bound',
      });
      const delta = reset.deltas.find((item) => item.type === 'REPLACE_NODE');
      if (delta?.type !== 'REPLACE_NODE')
        throw new Error('Missing override inverse');
      await expect(
        applyDeltasOnServer({
          canvasId,
          originator: { source: 'ui' },
          deltas: [
            { type: 'REPLACE_NODE', prev: delta.next, next: delta.prev },
          ],
        }),
      ).rejects.toThrow('after binding');
      expect((await current()).data).not.toHaveProperty('agentLaunchOverrides');
    });
  });
});
