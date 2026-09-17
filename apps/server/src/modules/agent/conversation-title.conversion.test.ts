// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createId, type CanvasNodeId } from '@huabu/shared';

import { agenetes } from './agenetes/drivers.js';
import { buildHuabuPiWorkloadSpec } from './agenetes/pi-driver.js';
import {
  ConversationTitleService,
  CONVERSATION_TITLE_METADATA_KEY,
  conversationTitleService,
} from './conversation-title.service.js';
import {
  executeOnServer,
  hydrateCanvasNodes,
  applyDeltasOnServerAlreadyLocked,
} from '../canvas/canvas-executor.js';
import { subscribeCanvasUpdates } from '../canvas/canvas-sync.js';
import { PreprocessDispatcher } from '../preprocessing/dispatcher.js';
import { ProviderManager } from '../preprocessing/provider-manager.js';
import { createSpace, space, withCanvasMutex } from '../storage/index.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';

import type { CanvasNode } from '@huabu/shared/canvas-engine';
import type { MockInstance } from 'vitest';

forEachProductProfile((profile, label) => {
  describe(`Unified conversation naming (${label})`, () => {
    let mounted: MountedTestStorage;
    let canvasId: string;
    let threadId: string;
    let nodeId: CanvasNodeId;
    let service: ConversationTitleService;
    let generate: MockInstance<ProviderManager['generateContentMeta']>;
    beforeEach(async () => {
      mounted = await mountTestWorkspace(profile, 'unified-titles-');
      canvasId = createId('canvas');
      threadId = createId('thread');
      nodeId = createId('node');
      await createSpace(canvasId, 'Titles');
      service = new ConversationTitleService();
      generate = vi
        .spyOn(ProviderManager.prototype, 'generateContentMeta')
        .mockResolvedValue({ label: 'Generated title' });
    });
    afterEach(async () => {
      agenetes.close(threadId);
      vi.restoreAllMocks();
      await mounted.close();
    });
    function realize() {
      return agenetes.create(
        buildHuabuPiWorkloadSpec({
          kind: 'internal',
          workloadType: 'Deployment',
          threadId,
          namespace: canvasAcpNamespace(canvasId),
          canvasId,
          systemPrompt: 'Test',
          toolNames: [],
          initialMessages: [],
          maxIterations: 1,
          toolExecution: 'sequential',
        }),
      );
    }
    async function create(data: Record<string, unknown> = {}) {
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: nodeId,
                nodeType: 'question',
                position: { x: 0, y: 0 },
                data: {
                  threadId,
                  content: 'First user prompt',
                  label: 'Question',
                  labelSource: 'auto',
                  ...data,
                },
              },
            ],
          },
        ],
      });
    }
    async function current() {
      const handle = space(canvasId);
      const canvas = await handle.read();
      const node = hydrateCanvasNodes(
        await handle.nodes.list(),
        canvas?.state.nodes as CanvasNode[],
      ).find((node) => node.id === nodeId);
      if (!node) throw new Error(`Expected Question node ${nodeId}`);
      return node;
    }
    async function rename(
      labelSource: 'user' | 'agent',
      label = 'Explicit name',
    ) {
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [{ nodeId, patch: { label, labelSource } }],
          },
        ],
      });
    }
    async function notify(title: string) {
      let finished = false;
      vi.spyOn(agenetes, 'notifications').mockImplementationOnce(
        async function* () {
          yield { sessionInfo: { title, updatedAt: null } };
          finished = true;
        },
      );
      service.subscribe(canvasId, threadId);
      await vi.waitFor(() => expect(finished).toBe(true));
    }
    function delayed() {
      let complete!: (value: { label: string }) => void;
      generate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      return { finish: (label = 'Delayed title') => complete({ label }) };
    }
    it('preprocess names before durable execution, coalesces with send, and returns no second fallback patch', async () => {
      await create();
      const createHandle = vi.spyOn(agenetes, 'create');
      const wait = delayed();
      const dispatcher = new PreprocessDispatcher();
      const request = {
        canvasId,
        nodeId,
        nodeType: 'question' as const,
        trigger: 'node_inserted' as const,
        snapshot: {
          content: 'First user prompt',
          title: 'Question',
          labelSource: 'auto',
        },
      };
      const pending = dispatcher.preprocess(request);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
      expect((await current()).data.label).toBe('First user prompt');
      await conversationTitleService.start(
        canvasId,
        threadId,
        'First user prompt',
      );
      expect(createHandle).not.toHaveBeenCalled();
      expect(
        agenetes.record(canvasAcpNamespace(canvasId), threadId),
      ).toBeUndefined();
      wait.finish();
      expect((await pending).patch).toEqual({});
      expect((await current()).data.label).toBe('Delayed title');
      const before = (await space(canvasId).read())?.version;
      await dispatcher.preprocess(request);
      expect((await space(canvasId).read())?.version).toBe(before);
      expect(generate).toHaveBeenCalledOnce();
      await mounted.reopen();
      expect(await service.get(canvasId, threadId)).toEqual({
        title: 'Delayed title',
        source: 'generated',
      });
    });
    it('start persists fallback before model completion and publishes the later upgrade', async () => {
      await create();
      const events = vi.fn();
      const unsubscribe = subscribeCanvasUpdates(canvasId, events);
      try {
        const wait = delayed();
        await service.start(canvasId, threadId, 'First user prompt');
        expect((await current()).data.label).toBe('First user prompt');
        await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
        wait.finish();
        await vi.waitFor(async () =>
          expect((await current()).data.label).toBe('Delayed title'),
        );
        expect(events).toHaveBeenCalledTimes(2);
        expect(events.mock.calls[1][0].data.agentNodeProjection).toBe(true);
      } finally {
        unsubscribe();
      }
    });
    it.each(['user', 'agent'] as const)(
      'protects an in-flight %s node rename and reports its effective title',
      async (owner) => {
        await create();
        const wait = delayed();
        const pending = service.initialize(
          canvasId,
          threadId,
          'First user prompt',
        );
        await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
        await rename(owner);
        wait.finish();
        await pending;
        await notify('Late ACP');
        expect((await current()).data.label).toBe('Explicit name');
        expect((await service.get(canvasId, threadId)).title).toBe(
          'Explicit name',
        );
        await service.initialize(canvasId, threadId, 'Later');
        expect(generate).toHaveBeenCalledOnce();
      },
    );
    it.each(['delete', 'content', 'thread'] as const)(
      'rejects delayed generation after %s changes',
      async (change) => {
        await create();
        const wait = delayed();
        const pending = service.initialize(
          canvasId,
          threadId,
          'First user prompt',
        );
        await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
        if (change === 'delete') {
          await executeOnServer({
            canvasId,
            originator: { source: 'ui' },
            commands: [{ type: 'DELETE_NODES', nodeIds: [nodeId] }],
          });
        } else {
          await withCanvasMutex(canvasId, async () => {
            const node = await current();
            await applyDeltasOnServerAlreadyLocked({
              canvasId,
              originator: { source: 'system' },
              agentNodeProjection: true,
              deltas: [
                {
                  type: 'REPLACE_NODE',
                  prev: node,
                  next: {
                    ...node,
                    data: {
                      ...node.data,
                      ...(change === 'thread'
                        ? { threadId: 'replacement-thread' }
                        : { content: 'Changed content' }),
                    },
                  },
                },
              ],
            });
          });
        }
        wait.finish();
        await pending;
        if (change === 'delete')
          expect(await space(canvasId).nodes.read(nodeId)).toBeNull();
        else expect((await current()).data.label).toBe('First user prompt');
      },
    );
    it('retains valid ACP across generation failure, filters multiline updates, retries and deduplicates', async () => {
      await create();
      realize();
      generate.mockRejectedValueOnce(new Error('offline'));
      await service.initialize(canvasId, threadId, 'First user prompt');
      await notify('ACP title');
      await notify('Bad\nACP');
      expect(await service.get(canvasId, threadId)).toEqual({
        title: 'ACP title',
        source: 'acp',
      });
      const version = (await space(canvasId).read())?.version;
      await notify('ACP title');
      expect((await space(canvasId).read())?.version).toBe(version);
      await service.initialize(canvasId, threadId, 'Later');
      await notify('Late ACP');
      expect(await service.get(canvasId, threadId)).toEqual({
        title: 'Generated title',
        source: 'generated',
      });
      expect(
        agenetes.record(canvasAcpNamespace(canvasId), threadId)?.hostMetadata,
      ).toBeUndefined();
    });
    it.each(['fallback', 'acp', 'generated', 'user'] as const)(
      'transfers %s Chat authority at conversion without freezing automatic names',
      async (source) => {
        realize();
        agenetes.updateHostMetadata(canvasAcpNamespace(canvasId), threadId, {
          [CONVERSATION_TITLE_METADATA_KEY]: {
            title: 'Latest backend title',
            source,
          },
        });
        await create({ label: 'Stale frontend title' });
        expect((await current()).data.label).toBe('Latest backend title');
        await service.initialize(canvasId, threadId, 'First user prompt');
        expect((await current()).data.label).toBe(
          source === 'user' || source === 'generated'
            ? 'Latest backend title'
            : 'Generated title',
        );
        await service.setUserTitle(
          canvasId,
          threadId,
          'Manual after conversion',
        );
        expect((await current()).data.labelSource).toBe('user');
        expect(await service.get(canvasId, threadId)).toEqual({
          title: 'Manual after conversion',
          source: 'user',
        });
      },
    );
    it('routes pre-conversion generation completion to the newly authoritative node', async () => {
      realize();
      const wait = delayed();
      const pending = service.initialize(
        canvasId,
        threadId,
        'First user prompt',
      );
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
      await create();
      wait.finish();
      await pending;
      expect((await current()).data.label).toBe('Delayed title');
      expect((await service.get(canvasId, threadId)).source).toBe('generated');
    });
    it('preprocess failure retains one fallback and later retries, while a stale request does no work', async () => {
      await create();
      generate.mockResolvedValueOnce(undefined);
      const dispatcher = new PreprocessDispatcher();
      const request = {
        canvasId,
        nodeId,
        nodeType: 'question' as const,
        trigger: 'node_updated' as const,
        snapshot: { content: 'First user prompt', title: 'Old request title' },
      };
      expect((await dispatcher.preprocess(request)).patch).toEqual({});
      expect((await current()).data.label).toBe('First user prompt');
      await dispatcher.preprocess({
        ...request,
        snapshot: { content: 'Stale' },
      });
      expect(generate).toHaveBeenCalledOnce();
      await dispatcher.preprocess(request);
      expect((await current()).data.label).toBe('Generated title');
    });
    it.each([
      { source: 'fallback', collision: false },
      { source: 'fallback', collision: true },
      { source: 'acp', collision: false },
      { source: 'acp', collision: true },
      { source: 'generated', collision: false },
      { source: 'generated', collision: true },
    ] as const)(
      'preserves punctuation in $source titles with collision=$collision across repeated writes and reload',
      async ({ source, collision }) => {
        const title = 'Plan: next steps?';
        await create({ content: title });
        if (collision) {
          await executeOnServer({
            canvasId,
            originator: { source: 'ui' },
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    nodeType: 'note',
                    position: { x: 300, y: 0 },
                    data: { label: 'Plan_ next steps_' },
                  },
                ],
              },
            ],
          });
        }
        generate.mockResolvedValue({ label: title });
        const synchronize = () =>
          source === 'fallback'
            ? service.ensureFallback(canvasId, threadId, title)
            : source === 'acp'
              ? notify(title)
              : service.initialize(canvasId, threadId, title);
        await synchronize();
        const expected = collision ? `${title} (2)` : title;
        expect((await current()).data.label).toBe(expected);
        expect(await service.get(canvasId, threadId)).toEqual({
          title: expected,
          source,
        });
        const version = (await space(canvasId).read())?.version;
        await synchronize();
        expect((await space(canvasId).read())?.version).toBe(version);
        await mounted.reopen();
        expect((await current()).data.label).toBe(expected);
        expect(await service.get(canvasId, threadId)).toEqual({
          title: expected,
          source,
        });
      },
    );
    it('uses the canonical deduplicated label without a repeat write', async () => {
      await create();
      await executeOnServer({
        canvasId,
        originator: { source: 'ui' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                nodeType: 'note',
                position: { x: 300, y: 0 },
                data: { label: 'Generated title' },
              },
            ],
          },
        ],
      });
      await service.initialize(canvasId, threadId, 'First user prompt');
      expect((await current()).data.label).toBe('Generated title (2)');
      const version = (await space(canvasId).read())?.version;
      await service.initialize(canvasId, threadId, 'Later');
      expect((await space(canvasId).read())?.version).toBe(version);
    });
  });
});
