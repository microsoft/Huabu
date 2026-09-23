// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { acpDriverFactory } from '@agenetes/acp-driver';
import { mountAgenetes } from '@agenetes/agenetes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FUNCTIONAL_TEXT_TIMEOUT_MS,
  runFunctionalText,
} from './functional-text.js';

import type * as ProfileSnapshot from './acp/profile-snapshot.js';
import type * as AgentDefaults from './agent-defaults.js';
import type { AcpCreateSpec, AcpTurnCtx } from '@agenetes/acp-driver';
import type { AgentProfileSnapshot } from '@agenetes/agent-profile';
import type { AgentStreamEvent, AgentSubmission } from '@agenetes/protocol';

const mocks = vi.hoisted(() => ({
  defaults: vi.fn(),
  selectable: vi.fn(),
  snapshot: vi.fn(),
  preferences: vi.fn(),
  create: vi.fn(),
  run: vi.fn<
    (
      submission: AgentSubmission,
      ctx: AcpTurnCtx,
    ) => AsyncGenerator<AgentStreamEvent, void>
  >(),
  close: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./agent-defaults.js', async (original) => ({
  ...(await original<typeof AgentDefaults>()),
  getAgentDefaults: mocks.defaults,
}));
vi.mock('./selectable-agent-profile.js', () => ({
  requireSelectableAgentProfile: mocks.selectable,
}));
vi.mock('./acp/profile-session-preferences.js', () => ({
  getProfileSessionPreferences: mocks.preferences,
}));
vi.mock('./acp/profile-snapshot.js', async (original) => ({
  ...(await original<typeof ProfileSnapshot>()),
  resolveProfileSnapshot: mocks.snapshot,
}));
vi.mock('./agenetes/drivers.js', () => ({
  EXTERNAL_DRIVER_KIND: 'external',
  agenetes: { create: mocks.create },
}));
vi.mock('./acp/reachback-env.js', () => ({
  buildReachbackEnv: (threadId: string, canvasId: string) => ({
    HUABU_THREAD_ID: threadId,
    CANVAS: canvasId,
  }),
}));
vi.mock('../workspace/paths.js', () => ({
  canvasAcpNamespace: (name: string) => ({ name }),
}));
vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: mocks.warn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const profile: AgentProfileSnapshot = {
  profileId: 'profile-a',
  agentletId: 'machine-a',
  workingDirPath: '/work',
  executionRevision: 3,
  launch: {
    kind: 'acp-harness',
    harnessId: 'copilot',
    options: { autoApprove: false },
  },
};
const context = { canvasId: 'canvas-a' };
const done: AgentStreamEvent = {
  type: 'done',
  data: { message: 'answer', meta: { stopReason: 'end_turn' } },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.defaults.mockReturnValue({
    profileId: 'profile-a',
    functionalModel: 'small-model',
  });
  mocks.selectable.mockReturnValue({ id: 'profile-a', alias: 'Agent' });
  mocks.snapshot.mockReturnValue(profile);
  mocks.preferences.mockReturnValue({
    model: 'profile-model',
    thoughtLevel: 'high',
  });
  mocks.create.mockReturnValue({ run: mocks.run, close: mocks.close });
  mocks.run.mockImplementation(async function* () {
    yield { type: 'text_delta', data: { content: 'ans' } };
    yield { type: 'text_delta', data: { content: 'wer' } };
    yield done;
  });
});
afterEach(() => vi.useRealTimers());

describe('external functional text', () => {
  it('passes the actual ACP driver validation through Agenetes without storing transient task history', async () => {
    const driver = acpDriverFactory();
    const create = driver.create.bind(driver);
    vi.spyOn(driver, 'create').mockImplementation((spec, recovery) => {
      const handle = create(spec, recovery);
      vi.spyOn(handle, 'run').mockImplementation(async function* () {
        yield { type: 'text_delta', data: { content: 'result' } };
        yield done;
      });
      return handle;
    });
    const runtime = mountAgenetes({ drivers: { external: driver } });
    mocks.create.mockImplementation((spec) => runtime.create(spec));
    await expect(runFunctionalText('task one', context)).resolves.toBe(
      'result',
    );
    await expect(runFunctionalText('task two', context)).resolves.toBe(
      'result',
    );
    expect(driver.create).toHaveBeenCalledTimes(2);
    expect(runtime.records({ name: 'canvas-a' })).toEqual([]);
    expect(runtime.history({ name: 'canvas-a' }, '').turns).toEqual([]);
    expect(runtime.get('')).toBeUndefined();
  });
  it('uses a transient Job and frozen Profile without changing chat preferences or creating a visible conversation', async () => {
    await expect(runFunctionalText('summarize', context)).resolves.toBe(
      'answer',
    );
    const spec: AcpCreateSpec = mocks.create.mock.calls[0][0];
    expect(spec).toMatchObject({
      workloadType: 'Job',
      threadId: '',
      namespace: { name: 'canvas-a' },
      spec: {
        agentletId: 'machine-a',
        profileExecutionRevision: 3,
        cwd: '/work',
        initialPreferences: { model: 'small-model' },
        recipe: { launch: profile.launch },
      },
    });
    expect(mocks.run).toHaveBeenCalledWith(
      {
        type: 'huabu.functional-text',
        content: 'summarize',
        rendered: [{ type: 'text', text: 'summarize' }],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.close).not.toHaveBeenCalled();
    await runFunctionalText('second task', context);
    expect(mocks.create.mock.calls[1][0].spec.env.HUABU_THREAD_ID).not.toBe(
      spec.spec.env?.HUABU_THREAD_ID,
    );
    expect(profile.launch).toMatchObject({ options: { autoApprove: false } });
  });

  it('inherits the Profile model when no functional override is selected', async () => {
    mocks.defaults.mockReturnValue({
      profileId: 'profile-a',
      functionalModel: '',
    });
    await runFunctionalText('task', context);
    expect(mocks.create.mock.calls[0][0].spec.initialPreferences).toEqual({
      model: 'profile-model',
    });
  });

  it('inherits the harness default when neither model preference is selected', async () => {
    mocks.defaults.mockReturnValue({
      profileId: 'profile-a',
      functionalModel: '',
    });
    mocks.preferences.mockReturnValue({});
    await runFunctionalText('task', context);
    expect(
      mocks.create.mock.calls[0][0].spec.initialPreferences,
    ).toBeUndefined();
  });

  it('does not inject model configuration into Custom commands', async () => {
    mocks.snapshot.mockReturnValue({
      ...profile,
      launch: { kind: 'acp-command', command: 'agent --acp' },
    });
    await runFunctionalText('task', context);
    expect(
      mocks.create.mock.calls[0][0].spec.initialPreferences,
    ).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('fails without a default instead of invoking any driver', async () => {
    mocks.defaults.mockReturnValue({ profileId: null, functionalModel: '' });
    await expect(runFunctionalText('task', context)).rejects.toMatchObject({
      code: 'default_profile_unconfigured',
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('surfaces deleted or unavailable Profiles without fallback', async () => {
    mocks.selectable.mockImplementationOnce(() => {
      throw new Error('Profile unavailable');
    });
    await expect(runFunctionalText('task', context)).rejects.toThrow(
      'Profile unavailable',
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'error', data: { error: 'machine offline' } }, 'machine offline'],
    [
      {
        type: 'permission_request',
        data: { requestId: 'permission', toolCall: {}, options: [] },
      },
      'interactive permission',
    ],
    [
      {
        type: 'done',
        data: { message: '', meta: { stopReason: 'cancelled' } },
      },
      'cancelled',
    ],
  ] satisfies [AgentStreamEvent, string][])(
    'rejects unsuccessful execution %j',
    async (event, message) => {
      mocks.run.mockImplementationOnce(async function* () {
        yield event;
      });
      await expect(runFunctionalText('task', context)).rejects.toThrow(message);
      expect(mocks.run.mock.calls[0][1].signal?.aborted).toBe(true);
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rejects missing or empty output (done=%s)',
    async (emitDone) => {
      mocks.run.mockImplementationOnce(async function* () {
        if (emitDone) yield done;
      });
      await expect(runFunctionalText('task', context)).rejects.toThrow(
        emitDone ? 'empty text' : 'without a result',
      );
    },
  );

  it('bounds a hung harness and forwards cancellation without pretending to reclaim its process', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    mocks.run.mockImplementationOnce(async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield done;
    });
    const result = expect(runFunctionalText('task', context)).rejects.toThrow(
      'timed out',
    );
    await vi.advanceTimersByTimeAsync(FUNCTIONAL_TEXT_TIMEOUT_MS);
    await result;
    expect(mocks.run.mock.calls[0][1].signal?.aborted).toBe(true);
    release();
  });

  it('does not start for a pre-aborted caller', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(
      runFunctionalText('task', { ...context, signal: controller.signal }),
    ).rejects.toThrow('caller cancelled');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns promptly when a running caller cancels', async () => {
    const controller = new AbortController();
    let release!: () => void;
    mocks.run.mockImplementationOnce(async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield done;
    });
    const result = expect(
      runFunctionalText('task', { ...context, signal: controller.signal }),
    ).rejects.toThrow('caller cancelled');
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await result;
    expect(mocks.run.mock.calls[0][1].signal?.aborted).toBe(true);
    release();
  });
});
