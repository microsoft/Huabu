// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AsyncLocalStorage } from 'node:async_hooks';

import { InMemoryBubbleStore } from '@octostaff/bubble';
import { Images } from 'openai/resources/images';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HUABU_AGENT_PROFILE_ID } from '@huabu/shared';

import { executeTool } from './executor.js';
import { executeOnServer } from '../../canvas/canvas-executor.js';
import { withCanvasMutex } from '../../canvas/write-coordinator.js';
import { openBubbleIdentity } from '../../identity/bubble.js';
import {
  callerAccess,
  openPersonalSettings,
  useCaller,
} from '../../identity/personal-settings.js';
import { createMemoryWorkspacePreferences } from '../../identity/preferences.js';
import { storageResourceDirectory } from '../../identity/resources.js';
import { serviceProvisioner } from '../../services/index.js';
import { mountTestWorkspace } from '../../storage/testing.js';
import { runLauncher } from '../../task/run-launcher.js';
import { taskService } from '../../task/task.service.js';
import { runInWorkspace } from '../../workspace/context.js';
import { getWorkspaceHandle } from '../../workspace.js';
import { agentThreadService } from '../agent-thread.service.js';
import { beginActiveInkIntentTurn } from '../ink-intent-runtime.js';

import type { MountedTestStorage } from '../../storage/testing.js';
import type { TaskRecord, TaskRunRecord } from '@huabu/shared';
import type { MockInstance } from 'vitest';

const SPACE_ID = 'retained-write-space';
const MEMBER_ID = 'write-member';
const REFERENCE_SRC = 'private-reference.png';
const INK_NODE_ID = 'node-ink-placeholder';
const INK_THREAD_ID = 'ink-thread';
const CREATED_NODE_ID = 'node-created-by-tool';
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

const tools = [
  'space_commands',
  'create_task',
  'start_task_run',
  'complete_task_run',
  'generate_image',
  'report_ink_intent',
] as const;
const states = [
  'editor',
  'local',
  'viewer downgrade',
  'admission revoked',
] as const;

for (const kind of ['disk', 'sqlite'] as const) {
  describe(`retained Built-In mutating tool access (${kind}/disk)`, () => {
    let opened: MountedTestStorage;
    let bubble: Awaited<ReturnType<typeof openBubbleIdentity>>;
    let preferences: ReturnType<typeof createMemoryWorkspacePreferences>;
    let resumed: ReturnType<typeof AsyncLocalStorage.snapshot>;
    let task: TaskRecord;
    let run: TaskRunRecord;
    let workspaceId: string;
    let finishInk: (() => void) | undefined;

    const invoke = vi.fn<typeof agentThreadService.invoke>();
    let edit: MockInstance<Images['edit']>;
    let generate: MockInstance<Images['generate']>;

    beforeEach(async () => {
      opened = await mountTestWorkspace(
        { structured: { kind }, blobs: { kind: 'disk' } },
        'huabu-executor-write-access-',
      );
      const made = await opened.storage.structured
        .spaces()
        .create({ canvasId: SPACE_ID, title: 'Private retained turn' });
      if (!made.ok) throw new Error('Expected the test Space');
      // Only external model transport/configuration and agent execution are
      // replaced. The actual commands, task services, and storage stay real.
      vi.spyOn(serviceProvisioner, 'resolveForServer').mockReturnValue({
        baseUrl: 'https://images.example.test/openai/v1',
        model: 'test-image-deployment',
        apiKey: 'test-only-key',
        apiVersion: '2025-04-01-preview',
        modelFamily: 'gpt-image-1',
        quality: 'low',
      });
      const response = {
        created: 1,
        data: [{ b64_json: TINY_PNG.toString('base64') }],
      };
      edit = vi.spyOn(Images.prototype, 'edit').mockResolvedValue(response);
      generate = vi
        .spyOn(Images.prototype, 'generate')
        .mockResolvedValue(response);
      invoke.mockImplementation(async () => ({
        binding: { kind: 'internal' },
        fixedTarget: null,
        signal: new AbortController().signal,
        acceptance: Promise.resolve(null),
        events: (async function* () {
          // No live provider or nondeterministic agent work in this fixture.
        })(),
        dispose: async () => {},
      }));
      vi.spyOn(agentThreadService, 'invoke').mockImplementation(invoke);
      task = await taskService.create(SPACE_ID, {
        goal: 'Original private task goal',
        defaultRootProfileId: HUABU_AGENT_PROFILE_ID,
        position: { x: 0, y: 0 },
      });
      run = await runLauncher.start(SPACE_ID, task.taskId, {});
      await opened.storage
        .space(SPACE_ID)
        .artifacts.put(REFERENCE_SRC, TINY_PNG);
      const ink = await executeOnServer({
        canvasId: SPACE_ID,
        originator: { source: 'system' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              {
                id: INK_NODE_ID,
                nodeType: 'question',
                position: { x: 0, y: 400 },
                data: {
                  label: 'New ink request',
                  threadId: INK_THREAD_ID,
                  pendingInkIntentLabel: true,
                  agentBinding: { kind: 'internal' },
                },
              },
            ],
          },
        ],
      });
      expect(ink.results[0]?.applied).toBe(true);
      const workspace = getWorkspaceHandle();
      if (!workspace) throw new Error('Expected the mounted Workspace');
      workspaceId = workspace.workspaceId;
      const store = new InMemoryBubbleStore();
      await store.principals.upsert({ principalId: MEMBER_ID, kind: 'user' });
      await store.grants.add({
        principalId: MEMBER_ID,
        target: { type: 'system' },
        role: 'member',
        grantedByPrincipalId: null,
      });
      preferences = createMemoryWorkspacePreferences();
      bubble = await openBubbleIdentity({
        authenticator: [{ driver: 'master-key', masterKey: 'test-only-key' }],
        owner: 'admin',
        store,
        preferences,
        resources: storageResourceDirectory,
      });
      await bubble.service.people.setWorkspaceRole(
        MEMBER_ID,
        workspaceId,
        'editor',
        'admin',
      );
      const identity = await bubble.service.resolvePrincipal?.(MEMBER_ID);
      if (!identity) throw new Error('Expected the admitted editor');
      resumed = runInWorkspace(
        { handle: workspace, path: opened.workspacePath },
        () =>
          openPersonalSettings(() => {
            useCaller(identity);
            return AsyncLocalStorage.snapshot();
          }),
      );
      invoke.mockClear();
    });

    afterEach(async () => {
      finishInk?.();
      finishInk = undefined;
      vi.restoreAllMocks();
      invoke.mockReset();
      await preferences?.close();
      await opened?.close();
    });

    const snapshot = async () =>
      JSON.parse(
        JSON.stringify({
          canvas: await opened.storage.space(SPACE_ID).read(),
          tasks: await opened.storage.space(SPACE_ID).tasks.read(),
          artifacts: (await opened.storage.space(SPACE_ID).artifacts.list())
            .map(({ name, size }) => ({ name, size }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          reference: (
            await opened.storage.space(SPACE_ID).artifacts.read(REFERENCE_SRC)
          )?.toString('hex'),
        }),
      );

    const argumentsFor = (name: (typeof tools)[number]) => {
      switch (name) {
        case 'space_commands':
          return {
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id: CREATED_NODE_ID,
                    nodeType: 'note',
                    position: { x: 500, y: 500 },
                    data: { label: 'Tool Note', content: 'Written by tool' },
                  },
                ],
              },
            ],
          };
        case 'create_task':
          return {
            goal: 'New task written by tool',
            defaultRootProfileId: HUABU_AGENT_PROFILE_ID,
            position: { x: 400, y: 500 },
          };
        case 'start_task_run':
          return { taskId: task.taskId };
        case 'complete_task_run':
          return { taskId: task.taskId, runId: run.runId, message: 'Finished' };
        case 'generate_image':
          return {
            prompt: 'Use this private source as a reference',
            referenceArtifactSrcs: [REFERENCE_SRC],
          };
        case 'report_ink_intent':
          return { text: 'Interpretation written by tool' };
      }
    };

    it.each(tools.flatMap((name) => states.map((state) => ({ name, state }))))(
      '$state: $name checks the live Space write boundary',
      async ({ name, state }) => {
        const retained = () => {
          const access = callerAccess();
          if (!access) throw new Error('Expected the retained Bubble access');
          return access;
        };
        expect(
          await resumed(() =>
            retained().can('manage', { type: 'workspace', id: workspaceId }),
          ),
        ).toBe(false);
        if (state === 'viewer downgrade') {
          await bubble.service.people.setWorkspaceRole(
            MEMBER_ID,
            workspaceId,
            'viewer',
            'admin',
          );
          expect(
            await resumed(() =>
              retained().can('read', { type: 'space', id: SPACE_ID }),
            ),
          ).toBe(true);
          expect(
            await resumed(() =>
              executeTool('get_space_outline', {}, { canvasId: SPACE_ID }),
            ),
          ).toEqual(expect.stringContaining(task.anchorNodeId));
        } else if (state === 'admission revoked') {
          await bubble.service.people.setMember(MEMBER_ID, false, 'admin');
        }
        const blocked =
          state === 'viewer downgrade' || state === 'admission revoked';
        expect(
          await resumed(() =>
            retained().can('write', { type: 'space', id: SPACE_ID }),
          ),
        ).toBe(!blocked);
        finishInk = beginActiveInkIntentTurn(
          SPACE_ID,
          INK_THREAD_ID,
          INK_NODE_ID,
        );
        const before = await snapshot();
        const context = {
          canvasId: SPACE_ID,
          ...(name === 'report_ink_intent' ? { threadId: INK_THREAD_ID } : {}),
        };
        const operation = () => executeTool(name, argumentsFor(name), context);
        const result = state === 'local' ? operation() : resumed(operation);
        if (blocked) {
          await expect
            .soft(result)
            .rejects.toThrow(/not writable|write access/);
          expect.soft(await snapshot()).toEqual(before);
          expect.soft(invoke).not.toHaveBeenCalled();
          expect.soft(edit).not.toHaveBeenCalled();
          expect.soft(generate).not.toHaveBeenCalled();
          return;
        }
        const raw = await result;
        if (typeof raw !== 'string')
          throw new Error('Expected a JSON tool result');
        const output = JSON.parse(raw);
        expect(await snapshot()).not.toEqual(before);
        switch (name) {
          case 'space_commands':
            expect(output.results[0]?.applied).toBe(true);
            expect(
              (await opened.storage.space(SPACE_ID).nodes.read(CREATED_NODE_ID))
                ?.record.content,
            ).toBe('Written by tool');
            break;
          case 'create_task':
            expect(output.task.goal).toBe('New task written by tool');
            expect(
              (await opened.storage.space(SPACE_ID).tasks.read()).tasks,
            ).toHaveLength(2);
            break;
          case 'start_task_run':
            expect(output.run.status).toBe('running');
            expect(
              (await opened.storage.space(SPACE_ID).tasks.read()).runs,
            ).toHaveLength(2);
            expect(invoke).toHaveBeenCalledOnce();
            break;
          case 'complete_task_run':
            expect(output.run.status).toBe('completed');
            expect(
              (await opened.storage.space(SPACE_ID).tasks.read()).runs.find(
                (stored) => stored.runId === run.runId,
              )?.completion?.message,
            ).toBe('Finished');
            break;
          case 'generate_image': {
            expect(
              await opened.storage.space(SPACE_ID).artifacts.read(output.src),
            ).toEqual(TINY_PNG);
            expect(edit).toHaveBeenCalledOnce();
            expect(generate).not.toHaveBeenCalled();
            const images = edit.mock.calls[0]?.[0].image;
            if (!Array.isArray(images))
              throw new Error('Expected reference uploads');
            const uploaded = images[0] as File;
            expect(uploaded.name).toBe(REFERENCE_SRC);
            expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(TINY_PNG);
            break;
          }
          case 'report_ink_intent':
            expect(output.renamed).toBe(true);
            expect(
              (await opened.storage.space(SPACE_ID).nodes.read(INK_NODE_ID))
                ?.record.label,
            ).toBe('Interpretation written by tool');
            break;
        }
      },
    );

    it('keeps a viewer active Ink report without a Question owner stateless', async () => {
      await bubble.service.people.setWorkspaceRole(
        MEMBER_ID,
        workspaceId,
        'viewer',
        'admin',
      );
      finishInk = beginActiveInkIntentTurn(SPACE_ID, INK_THREAD_ID);
      const before = await snapshot();
      const result = await resumed(() =>
        executeTool(
          'report_ink_intent',
          { text: 'Stateless interpretation' },
          { canvasId: SPACE_ID, threadId: INK_THREAD_ID },
        ),
      );
      expect(result).toBe(
        JSON.stringify({ text: 'Stateless interpretation', renamed: false }),
      );
      expect(await snapshot()).toEqual(before);
      expect(invoke).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    });

    it('refuses a viewer Ink owner that appears while its report waits on the actual Canvas mutex', async () => {
      await bubble.service.people.setWorkspaceRole(
        MEMBER_ID,
        workspaceId,
        'viewer',
        'admin',
      );
      finishInk = beginActiveInkIntentTurn(SPACE_ID, INK_THREAD_ID);
      let entered!: () => void;
      const holding = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = withCanvasMutex(SPACE_ID, async () => {
        entered();
        await gate;
      });
      let attemptedReport: Promise<unknown> | undefined;
      let finishOwner: (() => void) | undefined;
      try {
        await holding;
        const before = await snapshot();
        let settled = false;
        const attempt = resumed(() =>
          executeTool(
            'report_ink_intent',
            { text: 'Unauthorized interpretation' },
            { canvasId: SPACE_ID, threadId: INK_THREAD_ID },
          ),
        ).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        attemptedReport = attempt;
        // The real handler queues synchronously on withCanvasMutex; it must
        // choose and authorize its eventual owner after that queue releases.
        await Promise.resolve();
        expect(settled).toBe(false);
        finishOwner = beginActiveInkIntentTurn(
          SPACE_ID,
          INK_THREAD_ID,
          INK_NODE_ID,
        );
        release();
        await holder;
        expect(await attempt).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringMatching(/not writable|write access/),
          }),
        });
        expect(await snapshot()).toEqual(before);
        expect(
          (await opened.storage.space(SPACE_ID).nodes.read(INK_NODE_ID))?.record
            .label,
        ).toBe('New ink request');
      } finally {
        release();
        await holder;
        await attemptedReport;
        finishOwner?.();
      }
    });
  });
}
