// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  FileEventLogStore,
  InMemoryEventLogStore,
  mountAgenetes,
} from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './agenetes/conversation-stores.js';
import { PostgresEventLogStore } from './agenetes/postgres-stores.js';
import { SqliteEventLogStore } from './agenetes/sqlite-stores.js';
import {
  appendRecentConversationTurn,
  readRecentCanvasConversation,
} from './recent-conversation.js';
import * as documents from './substrate-store.js';
import { resolveDirectChildPath, safeJoin } from '../../utils/fs.js';
import canvasRoutes from '../canvas/canvas.route.js';
import { withCanvasMutex } from '../canvas/write-coordinator.js';
import { getStructuredStore, space } from '../storage/index.js';
import {
  mountTestWorkspace,
  PRODUCT_STORAGE_PROFILES,
  type MountedTestStorage,
} from '../storage/testing.js';
import { canvasAcpNamespace } from '../workspace/paths.js';
import {
  beginWorkspaceActivation,
  setWorkspacePath,
  WorkspaceOperationInProgressError,
} from '../workspace.js';

import type { AgentSubmission } from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

let mounted: MountedTestStorage | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await mounted?.close();
  mounted = undefined;
});

function submission(nodeId: string, inputKind = 'text'): AgentSubmission {
  return {
    type: 'huabu.chat',
    content: { user: { text: '', inputKind }, focus: { anchor: { nodeId } } },
    rendered: [{ type: 'text', text: 'canonical input' }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seed(canvasId = 'canvas-recent') {
  const result = await getStructuredStore()
    .spaces()
    .create({ canvasId, title: canvasId });
  if (!result.ok) throw new Error('Space creation failed');
  const record = result.record;
  await space(canvasId).write({
    expectedVersion: record.version,
    nextRecord: {
      ...record,
      version: record.version + 1,
      state: {
        nodes: ['a', 'b'].map((id) => ({
          id,
          type: 'question',
          data: { threadId: `thread-${id}` },
        })),
        edges: [],
      },
    },
    nodeMutations: [],
  });
  return canvasAcpNamespace(canvasId);
}

describe.each(PRODUCT_STORAGE_PROFILES)(
  'recent conversation on %j',
  (profile) => {
    it('keeps a reused live Agent handle and all canonical history on the renamed Space', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-rename-');
      const original = await seed();
      const instance = mountAgenetes({
        drivers: {
          test: defineDriver({
            schemaVersion: 1,
            workloadTypes: ['Deployment'],
            specSchema: z.object({}),
            stateSchema: z.object({}),
            initialState: () => ({}),
            create: () =>
              ({
                async *run() {
                  yield { type: 'text_delta', data: { content: 'answer' } };
                  yield { type: 'end', data: {} };
                },
                close() {},
              }) as unknown as AgentHandle,
          }),
        },
        threadStore: conversationThreadStore,
        eventLogStore: conversationEventLogStore,
        turnStore: conversationTurnStore,
      });
      const handle = await instance.create({
        kind: 'test',
        workloadType: 'Deployment',
        threadId: 'thread-a',
        namespace: original,
        spec: {},
      });
      try {
        for await (const _event of handle.run(submission('a'), {})) {
          /* Drain the canonical run. */
        }
        await conversationEventLogStore.appendTurnStart(
          original,
          'thread-b',
          submission('b'),
        );
        expect(
          (
            await getStructuredStore().spaces().rename({
              canvasId: original.name,
              title: 'Renamed conversation Space',
            })
          ).ok,
        ).toBe(true);
        for await (const _event of handle.run(
          submission('a', 'ink-intent'),
          {},
        )) {
          /* Reuse the original logging wrapper. */
        }
        const current = canvasAcpNamespace(original.name);
        expect(
          await readRecentCanvasConversation(
            current.name,
            conversationEventLogStore,
          ),
        ).toEqual({
          conversation: { nodeId: 'a', threadId: 'thread-a' },
        });
        const records = await conversationEventLogStore.readRecords(
          current,
          'thread-a',
        );
        expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(
          await conversationEventLogStore.readRecords(original, 'thread-a'),
        ).toEqual(records);
        expect(
          await conversationEventLogStore.readRecords(
            structuredClone(original),
            'thread-a',
          ),
        ).toEqual(records);
        expect(
          (await instance.history(current, 'thread-a')).turns,
        ).toHaveLength(2);
        expect(await conversationTurnStore.count(current, 'thread-a')).toBe(2);
        expect(
          (await conversationThreadStore.get(current, 'thread-a'))?.spec
            .namespace,
        ).toEqual(current);
        if (original.storage?.root) {
          expect(current.storage?.root).not.toBe(original.storage.root);
          expect(existsSync(original.storage.root)).toBe(false);
        }
      } finally {
        await instance.close('thread-a');
      }
    });

    it('holds Workspace admission while queued and while recovering a pending accepted turn', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-lease-');
      const original = await seed();
      const workspaceA = mounted.workspacePath;
      const workspaceB = path.join(workspaceA, 'another-workspace');
      if (profile.structured.kind === 'disk') {
        setWorkspacePath(workspaceB);
        const other = await seed();
        await conversationEventLogStore.appendTurnStart(
          other,
          'thread-b',
          submission('b'),
        );
        setWorkspacePath(workspaceA);
      }
      const originalWrite = documents.writeSubstrateDocument;
      let writes = 0;
      vi.spyOn(documents, 'writeSubstrateDocument').mockImplementation(
        async (...args) => {
          if (++writes === 2) throw new Error('Leave a pending accepted turn');
          return originalWrite(...args);
        },
      );
      await conversationEventLogStore.appendTurnStart(
        original,
        'thread-a',
        submission('a'),
      );
      vi.restoreAllMocks();
      const queued = deferred();
      const unlock = deferred();
      const holder = withCanvasMutex(original.name, async () => {
        queued.resolve();
        await unlock.promise;
      });
      await queued.promise;
      const recovering = deferred();
      const resume = deferred();
      const originalRead = documents.readSubstrateDocument;
      vi.spyOn(documents, 'readSubstrateDocument').mockImplementation(
        async (...args) => {
          const value = await originalRead(...args);
          recovering.resolve();
          await resume.promise;
          return value;
        },
      );
      const acceptance = conversationEventLogStore.appendTurnStart(
        original,
        'thread-a',
        submission('a', 'ink-intent'),
      );
      try {
        expect(() => beginWorkspaceActivation(workspaceB)).toThrow(
          WorkspaceOperationInProgressError,
        );
        unlock.resolve();
        await holder;
        await recovering.promise;
        expect(() => beginWorkspaceActivation(workspaceB)).toThrow(
          WorkspaceOperationInProgressError,
        );
        if (profile.structured.kind === 'disk') {
          expect(() => setWorkspacePath(workspaceB)).toThrow(
            WorkspaceOperationInProgressError,
          );
        }
      } finally {
        unlock.resolve();
        resume.resolve();
        await holder;
        await acceptance;
      }
      vi.restoreAllMocks();
      const reservation = beginWorkspaceActivation(workspaceB);
      reservation.release();
      if (profile.structured.kind === 'disk') {
        setWorkspacePath(workspaceB);
        expect(
          await readRecentCanvasConversation(
            original.name,
            conversationEventLogStore,
          ),
        ).toEqual({
          conversation: { nodeId: 'b', threadId: 'thread-b' },
        });
        await expect(
          conversationEventLogStore.appendTurnStart(
            original,
            'thread-a',
            submission('a'),
          ),
        ).rejects.toThrow('namespace is no longer active');
        await expect(
          conversationEventLogStore.readRecords(
            structuredClone(original),
            'thread-a',
          ),
        ).rejects.toThrow('namespace is no longer active');
        setWorkspacePath(workspaceA);
      }
      expect(
        await readRecentCanvasConversation(
          original.name,
          conversationEventLogStore,
        ),
      ).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
    });

    it('persists both Chat and Ink acceptance, including failed execution and deleted targets', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({ conversation: null });
      await conversationEventLogStore.appendTurnStart(
        ns,
        'thread-a',
        submission('a'),
      );
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
      await conversationEventLogStore.appendTurnStart(
        ns,
        'thread-b',
        submission('b', 'ink-intent'),
      );
      await conversationEventLogStore.append(ns, 'thread-b', {
        type: 'error',
        data: { error: 'Execution failed' },
      });
      const record = await space(ns.name).read();
      if (!record) throw new Error('Expected the Space to exist');
      await space(ns.name).write({
        expectedVersion: record.version,
        nextRecord: {
          ...record,
          version: record.version + 1,
          state: { ...record.state, nodes: [] },
        },
        nodeMutations: [],
      });
      await mounted.reopen();
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({
        conversation: { nodeId: 'b', threadId: 'thread-b' },
      });
      const other = await seed('canvas-other');
      expect(
        await readRecentCanvasConversation(
          other.name,
          conversationEventLogStore,
        ),
      ).toEqual({ conversation: null });
    });

    it('does not replace an accepted target on rejection, missing anchor, or mismatched ownership', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      await conversationEventLogStore.appendTurnStart(
        ns,
        'thread-a',
        submission('a'),
      );
      const rejected = new InMemoryEventLogStore();
      vi.spyOn(rejected, 'appendTurnStart').mockImplementation(() => {
        throw new Error('Rejected before acceptance');
      });
      await expect(
        appendRecentConversationTurn(
          ns,
          'thread-b',
          submission('b', 'ink-intent'),
          rejected,
        ),
      ).rejects.toThrow('Rejected');
      await conversationEventLogStore.appendTurnStart(ns, 'thread-b', {
        type: 'huabu.chat',
        content: { user: { text: 'Unanchored' } },
      });
      await conversationEventLogStore.appendTurnStart(
        ns,
        'thread-b',
        submission('a'),
      );
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
    });

    it('serializes competing acceptances without letting delayed older finalization overwrite the latest', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      await Promise.all([
        conversationEventLogStore.appendTurnStart(
          ns,
          'thread-a',
          submission('a'),
        ),
        conversationEventLogStore.appendTurnStart(
          ns,
          'thread-b',
          submission('b', 'ink-intent'),
        ),
      ]);
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({
        conversation: { nodeId: 'b', threadId: 'thread-b' },
      });
    });

    it('recovers accepted pointer finalization failure from durable acceptance after restart', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      const original = documents.writeSubstrateDocument;
      let writes = 0;
      vi.spyOn(documents, 'writeSubstrateDocument').mockImplementation(
        async (...args) => {
          if (++writes === 2) throw new Error('Finalization unavailable');
          return original(...args);
        },
      );
      const accepted = await conversationEventLogStore.appendTurnStart(
        ns,
        'thread-a',
        submission('a'),
      );
      expect(accepted.kind).toBe('turn_start');
      vi.restoreAllMocks();
      await mounted.reopen();
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
      await conversationEventLogStore.delete(ns, 'thread-a');
      expect(
        await readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
    });

    it('recovers a canonical append whose acknowledgement fails after the durable commit', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      const events =
        profile.structured.kind === 'disk'
          ? new FileEventLogStore()
          : profile.structured.kind === 'sqlite'
            ? new SqliteEventLogStore()
            : new PostgresEventLogStore();
      const append = events.appendTurnStart.bind(events);
      vi.spyOn(events, 'appendTurnStart').mockImplementation(
        async (...args) => {
          await append(...args);
          throw new Error('Acknowledgement lost');
        },
      );
      const accepted = await appendRecentConversationTurn(
        ns,
        'thread-a',
        submission('a'),
        events,
      );
      expect(accepted.kind).toBe('turn_start');
      expect((await events.readRecords(ns, 'thread-a')).length).toBe(1);
      expect(await readRecentCanvasConversation(ns.name, events)).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
      expect(await readRecentCanvasConversation(ns.name, events)).toEqual({
        conversation: { nodeId: 'a', threadId: 'thread-a' },
      });
      expect((await events.readRecords(ns, 'thread-a')).length).toBe(1);
    });

    it('surfaces pending-acceptance history damage instead of returning an absent target', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      const original = documents.writeSubstrateDocument;
      let writes = 0;
      vi.spyOn(documents, 'writeSubstrateDocument').mockImplementation(
        async (...args) => {
          if (++writes === 2) throw new Error('Finalization unavailable');
          return original(...args);
        },
      );
      await conversationEventLogStore.appendTurnStart(
        ns,
        'thread-a',
        submission('a'),
      );
      vi.restoreAllMocks();
      if (ns.storage?.root) {
        await writeFile(
          resolveDirectChildPath(
            safeJoin(ns.storage.root, 'chat_v2'),
            'thread-a.events.jsonl',
          ),
          '{corrupt',
        );
      } else {
        vi.spyOn(conversationEventLogStore, 'readRecords').mockRejectedValue(
          new Error('History unavailable'),
        );
      }
      await expect(
        readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).rejects.toThrow();
    });

    it('does not leak remembered targets into another Workspace with the same Space ID', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const original = await seed();
      await conversationEventLogStore.appendTurnStart(
        original,
        'thread-a',
        submission('a'),
      );
      await mounted.close();
      mounted = await mountTestWorkspace(profile, 'huabu-recent-other-');
      const current = await seed();
      expect(
        await readRecentCanvasConversation(
          current.name,
          conversationEventLogStore,
        ),
      ).toEqual({ conversation: null });
      if (original.storage?.root) {
        await expect(
          conversationEventLogStore.appendTurnStart(
            original,
            'thread-b',
            submission('b'),
          ),
        ).rejects.toThrow('namespace is no longer active');
        expect(
          await readRecentCanvasConversation(
            current.name,
            conversationEventLogStore,
          ),
        ).toEqual({ conversation: null });
      }
    });

    it('rejects reservation storage failure before durable acceptance and surfaces corrupt reads', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      const events = new InMemoryEventLogStore();
      vi.spyOn(documents, 'writeSubstrateDocument').mockRejectedValue(
        new Error('Storage offline'),
      );
      await expect(
        appendRecentConversationTurn(ns, 'thread-a', submission('a'), events),
      ).rejects.toThrow('Storage offline');
      expect(events.readRecords(ns, 'thread-a')).toEqual([]);
      vi.restoreAllMocks();
      const substrate = await space(ns.name).extension(
        'huabu.recentconversation',
      );
      if (!substrate) throw new Error('Expected the extension to exist');
      await documents.writeSubstrateDocument(substrate, 'target', {
        broken: true,
      });
      await expect(
        readRecentCanvasConversation(ns.name, conversationEventLogStore),
      ).rejects.toThrow();
      if (substrate.kind === 'disk') {
        await writeFile(
          resolveDirectChildPath(substrate.directory, 'target.json'),
          '{broken',
        );
        await expect(
          readRecentCanvasConversation(ns.name, conversationEventLogStore),
        ).rejects.toThrow();
      }
    });

    it('serves the shared API with explicit invalid, missing, and unavailable responses', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-recent-');
      const ns = await seed();
      const app = fastify();
      await app.register(canvasRoutes, { prefix: '/api/canvas' });
      try {
        const get = (id: string) =>
          app.inject({ url: `/api/canvas/${id}/recent-conversation` });
        expect((await get(ns.name)).json()).toEqual({ conversation: null });
        expect((await get('canvas%2Fbad')).statusCode).toBe(400);
        expect((await get('missing')).statusCode).toBe(404);
        await conversationEventLogStore.appendTurnStart(
          ns,
          'thread-a',
          submission('a'),
        );
        expect((await get(ns.name)).json()).toEqual({
          conversation: { nodeId: 'a', threadId: 'thread-a' },
        });
        const substrate = await space(ns.name).extension(
          'huabu.recentconversation',
        );
        if (!substrate) throw new Error('Expected the extension to exist');
        await documents.writeSubstrateDocument(substrate, 'target', {
          broken: true,
        });
        const failed = await get(ns.name);
        expect(failed.statusCode).toBe(500);
        expect(failed.json()).toMatchObject({
          code: 'RECENT_CONVERSATION_READ_FAILED',
        });
      } finally {
        await app.close();
      }
    });
  },
);
