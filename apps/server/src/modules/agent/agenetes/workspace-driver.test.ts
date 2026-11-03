// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mountAgenetes } from '@agenetes/agenetes';
import { defineDriver } from '@agenetes/runtime';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
  openWorkspace,
  resetStorageCache,
} from '../../storage/index.js';
import {
  currentWorkspaceScope,
  runInWorkspace,
} from '../../workspace/context.js';
import { canvasAcpNamespace } from '../../workspace/paths.js';
import { createWorkspace } from '../../workspace-activation.js';
import { setWorkspacePath } from '../../workspace.js';

import type { Agenetes } from '@agenetes/agenetes';
import type { AgentStateSnapshot } from '@agenetes/protocol';
import type { AgentHandle } from '@agenetes/runtime';

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
  'persists out-of-request state reports and drains a turn (request-scoped: %s)',
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
      if (scoped)
        expect(
          await conversationThreadStore.get(processNamespace, threadId),
        ).toBeUndefined();
    } finally {
      await inOwner(() => instance.close(threadId));
    }
  },
);
