// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { assert, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from './canvasStore';
import { selectThreadHistoryLoaded, useChatStore } from './chatStore';
import {
  beginConversationRealization,
  conversationControlTarget,
  createConversation,
  observeConversationExecution,
  preparationKey,
  resolveConversationPreparation,
  runConversationControl,
  saveConversationAgent,
  saveConversationWorkingDirectory,
  useConversationPreparationStore,
} from './conversationPreparation';

import type * as Owner from './conversationOwner';
import type { ChatSession } from '@/hooks/useChatSession';
import type { AgentBinding } from '@huabu/shared';

const ownerMocks = vi.hoisted(() => ({
  saveDirectory: vi.fn().mockResolvedValue(undefined),
  saveDraft: vi.fn().mockResolvedValue(undefined),
  awaitDraft: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./conversationOwner', async (original) => ({
  ...(await original<typeof Owner>()),
  saveConversationWorkingDirectoryOverride: ownerMocks.saveDirectory,
  saveConversationDraft: ownerMocks.saveDraft,
  awaitConversationDraft: ownerMocks.awaitDraft,
}));

const binding: AgentBinding = {
  kind: 'external',
  profileId: 'profile-1',
  alias: 'Agent',
};

function createSession(node: boolean): ChatSession {
  const threadId = createConversation({ canvasId: 'canvas', binding });
  if (node) {
    useCanvasStore.getState()._setStateRaw({
      nodes: [
        {
          id: 'node-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { threadId, agentBinding: binding, bindingState: 'editing' },
        },
      ],
    });
  }
  return {
    canvasId: 'canvas',
    ownerCanvasId: 'canvas',
    threadId,
    conversationView: node
      ? {
          presentationAnchor: { canvasId: 'canvas', nodeId: 'node-1' },
          conversationOwner: { canvasId: 'canvas', nodeId: 'node-1', threadId },
        }
      : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    threadsById: {},
    bindingByThread: {},
    ephemeralMetadataThreads: {},
  });
  useCanvasStore.getState()._setStateRaw({ canvasId: 'canvas', nodes: [] });
  useConversationPreparationStore.setState({
    directories: {},
    executions: {},
    pending: {},
    queuedControls: {},
    locked: {},
    revisions: {},
  });
});

describe.each([false, true])(
  'conversation preparation with node=%s',
  (node) => {
    it('initializes empty history and editable preparation for either presentation', () => {
      const session = createSession(node);
      expect(
        selectThreadHistoryLoaded(useChatStore.getState(), session.threadId),
      ).toBe(true);
      expect(resolveConversationPreparation(session)).toMatchObject({
        editable: true,
        binding,
        workingDirPath: undefined,
      });
    });

    it('validates directory intent before saving it', async () => {
      const session = createSession(node);
      await expect(
        saveConversationWorkingDirectory(session, 'relative/path'),
      ).rejects.toThrow();
      expect(ownerMocks.saveDirectory).not.toHaveBeenCalled();
      await saveConversationWorkingDirectory(session, ' /project ');
      if (node) {
        expect(ownerMocks.saveDirectory).toHaveBeenCalledWith(
          session.conversationView,
          '/project',
        );
        expect(useConversationPreparationStore.getState().directories).toEqual(
          {},
        );
      } else {
        expect(conversationControlTarget(session).cwd).toBe('/project');
        await saveConversationWorkingDirectory(session, null);
        expect(conversationControlTarget(session).cwd).toBeUndefined();
      }
    });

    it('uses one control admission path and locks settings during realization', async () => {
      const session = createSession(node);
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const control = vi.fn(async () => wait);
      const refresh = vi.fn(async () => {
        observeConversationExecution('canvas', session.threadId, {
          binding,
          workingDirPath: '/frozen',
        });
      });
      const operation = runConversationControl(session, control, refresh);
      await vi.waitFor(() => expect(control).toHaveBeenCalledOnce());
      expect(resolveConversationPreparation(session).editable).toBe(false);
      await expect(
        saveConversationWorkingDirectory(session, '/other'),
      ).rejects.toThrow('locked');
      await expect(
        saveConversationAgent(session, { binding, mode: 'ask' }),
      ).rejects.toThrow('locked');
      const nextControl = vi.fn().mockResolvedValue(undefined);
      const nextOperation = runConversationControl(
        session,
        nextControl,
        refresh,
      );
      expect(nextControl).not.toHaveBeenCalled();
      finish();
      await Promise.all([operation, nextOperation]);
      expect(control).toHaveBeenCalledOnce();
      expect(nextControl).toHaveBeenCalledOnce();
      expect(ownerMocks.awaitDraft).toHaveBeenCalledTimes(node ? 2 : 0);
      expect(resolveConversationPreparation(session)).toMatchObject({
        editable: false,
        pending: false,
        workingDirPath: '/frozen',
      });
    });

    it('unlocks after a confirmed pre-realization failure, not an ambiguous transport failure', async () => {
      const session = createSession(node);
      await expect(
        runConversationControl(
          session,
          async () => {
            throw new Error('offline');
          },
          async () => {},
        ),
      ).rejects.toThrow('offline');
      expect(resolveConversationPreparation(session).editable).toBe(false);
      observeConversationExecution('canvas', session.threadId, undefined);
      expect(resolveConversationPreparation(session).editable).toBe(true);
    });

    it('does not let a pre-start cache response unlock a newer realization', () => {
      const session = createSession(node);
      const release = beginConversationRealization(session);
      release();
      observeConversationExecution('canvas', session.threadId, undefined, 0);
      expect(resolveConversationPreparation(session).editable).toBe(false);
    });

    it('keeps runtime controls available without permitting launch-identity edits', async () => {
      const session = createSession(node);
      observeConversationExecution('canvas', session.threadId, {
        binding,
        workingDirPath: '/frozen',
      });
      useChatStore.getState().setThreadLoading(session.threadId, true);
      const control = vi.fn().mockResolvedValue(undefined);
      await runConversationControl(session, control, async () => {});
      expect(control).toHaveBeenCalledOnce();
      expect(resolveConversationPreparation(session).editable).toBe(false);
    });

    it('continues queued controls after a failure and surfaces the original error', async () => {
      const session = createSession(node);
      const calls: string[] = [];
      const first = runConversationControl(
        session,
        async () => {
          calls.push('first');
          throw new Error('rejected model');
        },
        async () => {
          calls.push('refresh first');
          observeConversationExecution('canvas', session.threadId, undefined);
          expect(resolveConversationPreparation(session).pending).toBe(true);
          expect(resolveConversationPreparation(session).editable).toBe(false);
          expect(() => beginConversationRealization(session)).toThrow(
            'preparing',
          );
        },
      );
      const rejection = expect(first).rejects.toThrow('rejected model');
      const second = runConversationControl(
        session,
        async () => {
          calls.push('second');
        },
        async () => {
          calls.push('refresh second');
          observeConversationExecution('canvas', session.threadId, undefined);
        },
      );
      await Promise.all([rejection, second]);
      expect(calls).toEqual([
        'first',
        'refresh first',
        'second',
        'refresh second',
      ]);
      expect(resolveConversationPreparation(session)).toMatchObject({
        pending: false,
        editable: true,
      });
      expect(useConversationPreparationStore.getState().queuedControls).toEqual(
        {},
      );
    });

    it.each([null, '/frozen'])(
      'distinguishes frozen directory origin %s from the effective path',
      (override) => {
        const session = createSession(node);
        observeConversationExecution('canvas', session.threadId, {
          binding,
          workingDirPath: '/frozen',
          workingDirectoryOverride: override,
        });
        expect(resolveConversationPreparation(session)).toMatchObject({
          realized: true,
          workingDirPath: '/frozen',
          workingDirectoryOverride: override ?? undefined,
          workingDirectorySource: override === null ? 'profile' : 'override',
        });
      },
    );
  },
);

it('does not serialize controls from independent conversations', async () => {
  const firstSession = createSession(false);
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = runConversationControl(
    firstSession,
    async () => wait,
    async () => {},
  );
  const secondControl = vi.fn().mockResolvedValue(undefined);
  await runConversationControl(
    createSession(false),
    secondControl,
    async () => {},
  );
  expect(secondControl).toHaveBeenCalledOnce();
  expect(resolveConversationPreparation(firstSession).pending).toBe(true);
  finish();
  await first;
});

it.each([false, true])(
  'restores the prior execution lock after draft preparation fails (previously locked=%s)',
  async (locked) => {
    const session = createSession(true);
    useConversationPreparationStore.setState((state) => ({
      locked: { ...state.locked, [preparationKey(session)]: locked },
    }));
    ownerMocks.awaitDraft.mockRejectedValueOnce(new Error('Draft save failed'));
    const control = vi.fn();
    const refresh = vi.fn().mockRejectedValue(new Error('Cache unavailable'));
    await expect(
      runConversationControl(session, control, refresh),
    ).rejects.toThrow('Draft save failed');
    expect(control).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(resolveConversationPreparation(session)).toMatchObject({
      editable: !locked,
      pending: false,
    });
    expect(useConversationPreparationStore.getState().queuedControls).toEqual(
      {},
    );
    if (!locked) {
      await saveConversationAgent(session, { binding, mode: 'ask' });
      expect(ownerMocks.saveDraft).toHaveBeenCalledOnce();
    }
  },
);

it('keeps an attempted control locked when both dispatch and cache refresh fail', async () => {
  const session = createSession(true);
  const control = vi.fn().mockRejectedValue(new Error('Transport unavailable'));
  const refresh = vi.fn().mockRejectedValue(new Error('Cache unavailable'));
  await expect(
    runConversationControl(session, control, refresh),
  ).rejects.toThrow('Cache unavailable');
  expect(control).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
  expect(resolveConversationPreparation(session)).toMatchObject({
    editable: false,
    pending: false,
  });
});

it('runs the next queued control after a failed draft preflight', async () => {
  const session = createSession(true);
  ownerMocks.awaitDraft.mockRejectedValueOnce(new Error('Draft save failed'));
  const firstControl = vi.fn();
  const refresh = vi.fn();
  const first = runConversationControl(session, firstControl, refresh);
  const rejection = expect(first).rejects.toThrow('Draft save failed');
  const nextControl = vi.fn().mockResolvedValue(undefined);
  const next = runConversationControl(session, nextControl, refresh);
  await Promise.all([rejection, next]);
  expect(firstControl).not.toHaveBeenCalled();
  expect(nextControl).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
  expect(resolveConversationPreparation(session)).toMatchObject({
    pending: false,
    editable: false,
  });
});

it('keeps browser directory intent across cache eviction and never leaks it to another conversation', async () => {
  const session = createSession(false);
  await saveConversationWorkingDirectory(session, '/project');
  useChatStore.setState({ threadsById: {} });
  expect(conversationControlTarget(session).cwd).toBe('/project');
  expect(conversationControlTarget(createSession(false)).cwd).toBeUndefined();
  expect(
    conversationControlTarget({ ...session, ownerCanvasId: 'other' }).cwd,
  ).toBeUndefined();
});

it('uses frozen backend facts instead of stale browser intent', async () => {
  const session = createSession(false);
  await saveConversationWorkingDirectory(session, '/draft');
  observeConversationExecution('canvas', session.threadId, { binding });
  expect(
    resolveConversationPreparation(session).workingDirPath,
  ).toBeUndefined();
  expect(resolveConversationPreparation(session).editable).toBe(false);
  expect(resolveConversationPreparation(session).workingDirectorySource).toBe(
    'unknown',
  );
  expect(
    resolveConversationPreparation(session).workingDirectoryOverride,
  ).toBeUndefined();
});

it('persists only draft directory intent and restores it after reload', async () => {
  const session = createSession(false);
  await saveConversationWorkingDirectory(session, '/persisted/project');
  const saved = localStorage.getItem('huabu-conversation-preparation');
  assert(saved);
  expect(JSON.parse(saved).state).toEqual({
    directories: { [preparationKey(session)]: '/persisted/project' },
  });
  useConversationPreparationStore.setState({
    directories: {},
    executions: {},
    locked: {},
    pending: {},
  });
  localStorage.setItem('huabu-conversation-preparation', saved);
  await useConversationPreparationStore.persist.rehydrate();
  expect(conversationControlTarget(session).cwd).toBe('/persisted/project');
  expect(resolveConversationPreparation(session).editable).toBe(false);
});

it('waits for backend facts before editing an existing external conversation', () => {
  const session = createSession(false);
  useConversationPreparationStore.setState({ locked: {} });
  expect(resolveConversationPreparation(session).editable).toBe(false);
  expect(resolveConversationPreparation(session).ready).toBe(false);
  observeConversationExecution('canvas', session.threadId, undefined);
  expect(
    useConversationPreparationStore.getState().locked[preparationKey(session)],
  ).toBe(false);
  expect(resolveConversationPreparation(session).editable).toBe(true);
  expect(resolveConversationPreparation(session).ready).toBe(true);
});

it('does not mistake a draft save for realization when a cold cache read arrives during the save', async () => {
  const session = createSession(true);
  let finish!: () => void;
  ownerMocks.saveDirectory.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const save = saveConversationWorkingDirectory(session, '/project');
  observeConversationExecution('canvas', session.threadId, undefined);
  expect(resolveConversationPreparation(session).editable).toBe(false);
  finish();
  await save;
  expect(resolveConversationPreparation(session).editable).toBe(true);
});
