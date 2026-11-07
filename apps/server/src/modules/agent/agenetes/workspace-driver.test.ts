// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mountAgenetes } from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  conversationEventLogStore,
  conversationThreadStore,
  conversationTurnStore,
} from './conversation-stores.js';
import { withWorkspaceStateReports } from './workspace-driver.js';
import {
  closeStorage,
  createSpace,
  getStructuredStore,
  openWorkspace,
  resetStorageCache,
} from '../../storage/index.js';
import {
  currentWorkspaceScope,
  runInWorkspace,
} from '../../workspace/context.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import { createWorkspace } from '../../workspace-activation.js';
import { getWorkspaceHandle, setWorkspacePath } from '../../workspace.js';

import type { Agenetes } from '@agenetes/agenetes';
import type { AgentStateSnapshot } from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

vi.mock('../memory/index.js', () => ({
  readWorkspaceMemory: () => '',
}));

let tmp: string;
let previousDataDir: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-workspace-reports-'));
  previousDataDir = process.env.HUABU_DATA_DIR;
  process.env.HUABU_DATA_DIR = join(tmp, 'data');
  mkdirSync(join(tmp, 'server'));
  resetStorageCache();
  setWorkspacePath(join(tmp, 'server'));
});
afterEach(async () => {
  await closeStorage();
  if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
  else process.env.HUABU_DATA_DIR = previousDataDir;
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

it.each([false, true])(
  'persists out-of-request reports and turns across a Space rename (request-scoped: %s)',
  async (scoped) => {
    const canvasId = 'canvas-reports';
    const threadId = 'thread-reports';
    await createSpace(canvasId, 'Process Space');
    const processNamespace = canvasAcpNamespace(canvasId);
    const scope = scoped
      ? await openWorkspace(await createWorkspace('Agent Workspace'))
      : undefined;
    const inOwner = <T>(fn: () => T): T =>
      scope ? runInWorkspace(scope, fn) : fn();
    if (scope) await inOwner(() => createSpace(canvasId, 'Scoped Space'));
    const namespace = inOwner(() => canvasAcpNamespace(canvasId));
    const gateway = new EventEmitter();
    const raw: AgentHandle = {
      capabilities: { supportedControlMessages: [], turnInput: 'blocking' },
      onState(listener) {
        gateway.on('state', listener);
        return () => {
          gateway.off('state', listener);
        };
      },
      async control() {
        return { ok: false, code: 'unsupported', error: 'Unsupported' };
      },
      async *run() {
        yield { type: 'end', data: {} };
      },
      close() {},
    };
    const instance: Agenetes = mountAgenetes({
      drivers: {
        test: withWorkspaceStateReports(
          defineDriver({
            schemaVersion: 1,
            workloadTypes: ['Deployment'],
            specSchema: z.object({}),
            stateSchema: z.object({ count: z.number() }),
            initialState: () => ({ count: 0 }),
            create: () => raw,
          }),
        ),
      },
      threadStore: conversationThreadStore,
      eventLogStore: conversationEventLogStore,
      turnStore: conversationTurnStore,
    });
    const handle = await inOwner(() =>
      instance.create({
        kind: 'test',
        workloadType: 'Deployment',
        threadId,
        namespace,
        spec: {},
      }),
    );
    let activeNamespace = namespace;
    try {
      expect(currentWorkspaceScope()).toBeUndefined();
      // The Gateway's event emitter was created outside the request chain.
      const report: AgentStateSnapshot = { driverState: { count: 42 } };
      gateway.emit('state', report);
      expect(
        (await inOwner(() => instance.record(namespace, threadId)))?.state,
      ).toMatchObject(report);
      await inOwner(async () => {
        const events = [];
        for await (const event of handle.run(null, {})) events.push(event);
        expect(events).toEqual([{ type: 'end', data: {} }]);
      });
      expect(
        (await inOwner(() => instance.history(namespace, threadId))).turns,
      ).toHaveLength(1);
      expect(
        (
          await inOwner(() =>
            getStructuredStore()
              .spaces()
              .rename({ canvasId, title: 'Renamed Space' }),
          )
        ).ok,
      ).toBe(true);
      activeNamespace = inOwner(() => canvasAcpNamespace(canvasId));
      expect(activeNamespace.storage?.root).not.toBe(namespace.storage?.root);
      expect(inOwner(() => instance.get(threadId, activeNamespace))).toBe(
        handle,
      );
      expect(
        await inOwner(() =>
          instance.create({
            kind: 'test',
            workloadType: 'Deployment',
            threadId,
            namespace: activeNamespace,
            spec: {},
          }),
        ),
      ).toBe(handle);
      gateway.emit('state', { driverState: { count: 43 } });
      expect(
        (await inOwner(() => instance.record(activeNamespace, threadId)))
          ?.state,
      ).toMatchObject({ driverState: { count: 43 } });
      await inOwner(async () => {
        for await (const _event of handle.run(null, {})) {
          // Drain the turn after the directory move.
        }
      });
      expect(
        (await inOwner(() => instance.history(activeNamespace, threadId)))
          .turns,
      ).toHaveLength(2);
      if (scoped)
        expect(
          await conversationThreadStore.get(processNamespace, threadId),
        ).toBeUndefined();
    } finally {
      await inOwner(() => instance.close(threadId, activeNamespace));
    }
  },
);

it('lets one Workspace displace a handle another Workspace holds under its thread id', async () => {
  const canvasId = 'canvas-shared-id';
  const threadId = 'thread-shared-id';
  const carol = await openWorkspace(await createWorkspace('Carol'));
  const erin = await openWorkspace(await createWorkspace('Erin'));
  const closedIn: Array<string | undefined> = [];
  const instance: Agenetes = mountAgenetes({
    drivers: {
      test: withWorkspaceStateReports(
        defineDriver({
          schemaVersion: 1,
          workloadTypes: ['Deployment'],
          specSchema: z.object({}),
          stateSchema: z.object({}),
          initialState: () => ({}),
          create: () => ({
            capabilities: {
              supportedControlMessages: [],
              turnInput: 'blocking',
            },
            onState: () => () => {},
            async control() {
              return { ok: false, code: 'unsupported', error: 'Unsupported' };
            },
            async *run() {
              yield { type: 'end', data: {} };
            },
            close() {
              closedIn.push(getWorkspaceHandle()?.workspaceId);
            },
          }),
        }),
      ),
    },
    threadStore: conversationThreadStore,
    eventLogStore: conversationEventLogStore,
    turnStore: conversationTurnStore,
  });
  const workload = (namespace: ReturnType<typeof canvasAcpNamespace>) => ({
    kind: 'test',
    workloadType: 'Deployment' as const,
    threadId,
    namespace,
    spec: {},
  });
  // Carol's conversation exists but is idle; Erin reuses its id.
  const carolNamespace = await runInWorkspace(carol, async () => {
    await createSpace(canvasId, 'Carol Space');
    const namespace = canvasAcpNamespace(canvasId);
    await instance.create(workload(namespace));
    await instance.close(threadId, namespace);
    return namespace;
  });
  closedIn.length = 0;
  const erinHandle = await runInWorkspace(erin, async () => {
    await createSpace(canvasId, 'Erin Space');
    return instance.create(workload(canvasAcpNamespace(canvasId)));
  });

  await runInWorkspace(carol, async () => {
    // Erin's handle is refused in Carol's Workspace...
    await expect(async () => {
      for await (const _event of erinHandle.run(null, {})) {
        // Never reached.
      }
    }).rejects.toThrow();
    // Carol resumes her own same-ID conversation without touching Erin's handle.
    await expect(
      instance.create(workload(carolNamespace)),
    ).resolves.toBeDefined();
    await instance.close(threadId, carolNamespace);
  });
  expect(closedIn).toEqual([carol.handle.workspaceId]);
  await runInWorkspace(erin, async () => {
    expect(instance.get(threadId, canvasAcpNamespace(canvasId))).toBe(
      erinHandle,
    );
    await instance.close(threadId, canvasAcpNamespace(canvasId));
  });
  expect(closedIn).toEqual([carol.handle.workspaceId, erin.handle.workspaceId]);
});
