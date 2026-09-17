// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace/paths.js', () => ({
  canvasAcpNamespace: (canvasId: string) => ({
    name: canvasId,
    storage: { root: `/spaces/${canvasId}/.history` },
  }),
}));

import { ExternalAgentRealizationService } from './external-agent-realization.js';
import { AgentNodeBindingCoordinator } from '../agent-node-binding.js';

import type { ExternalAgentRealizationError } from './external-agent-realization.js';
import type { AcpHandle, AcpWorkloadSpec } from '../agenetes/drivers.js';
import type {
  AgentNodeTarget,
  FixedAgentNodeTarget,
} from '../agent-thread-resolver.js';
import type { AcpSessionEntry } from '@agenetes/acp-driver';
import type { ThreadRecord } from '@agenetes/agenetes';
import type { CanvasNodeId } from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

const logger = {
  warn: vi.fn(),
} as unknown as FastifyBaseLogger;

const target: FixedAgentNodeTarget = {
  canvasId: 'canvas-1',
  nodeId: 'node-1' as CanvasNodeId,
  threadId: 'thread-1',
  agentBinding: {
    kind: 'external',
    alias: 'Fixed Agent',
    profileId: 'profile-fixed',
  },
  launchOverrides: {
    workingDirPath: '/fixed/work',
    additionalInitialPreamble: 'Node instructions',
  },
  status: 'idle',
  content: '',
};
const targetBinding = target.agentBinding as Extract<
  typeof target.agentBinding,
  { kind: 'external' }
>;
const selectableTarget: AgentNodeTarget = {
  canvasId: target.canvasId,
  nodeId: 'node-selectable' as CanvasNodeId,
  threadId: target.threadId,
};

function createHarness(options?: {
  bindingCoordinator?: boolean;
  agentTarget?: AgentNodeTarget | null;
  record?: ThreadRecord;
  collect?: () => Promise<{
    markdown: string;
    diagnostics: {
      includedFrameIds: string[];
      includedNodeIds: string[];
      omittedUnsupportedIds: string[];
      omittedEmptyTextIds: string[];
      omittedMissingIds: string[];
      omittedBudgetNodeIds: string[];
      truncatedNoteIds: string[];
      truncated: boolean;
    };
  } | null>;
}) {
  const handle = {
    control: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as AcpHandle;
  let durableRecord = options?.record;
  const createHandle = vi.fn((spec: AcpWorkloadSpec) => {
    durableRecord ??= {
      spec,
      driverSchemaVersion: 1,
      state: { driverState: {} },
    };
    return handle;
  });
  const promote = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn();
  const acquireTurn = vi.fn((): (() => void) | null => release);
  const binding = new AgentNodeBindingCoordinator({
    record: () => durableRecord,
    hasHistory: () => false,
    promote,
    acquireTurn,
  });
  const subscribeTitles = vi.fn();
  const buildSpec = vi.fn(
    ({
      binding,
      threadId,
      canvasId,
      launchOverrides,
      spacePrompt,
      cwd,
    }: {
      binding: { alias: string; profileId: string };
      threadId: string;
      canvasId?: string;
      cwd?: string;
      launchOverrides?: {
        workingDirPath?: string;
        additionalInitialPreamble?: string;
      };
      spacePrompt?: string;
    }): AcpWorkloadSpec => ({
      threadId,
      namespace: {
        name: canvasId ?? '',
        storage: { root: `/spaces/${canvasId ?? ''}/.history` },
      },
      kind: 'external',
      workloadType: 'Deployment',
      spec: {
        binding,
        agentletId: 'agentlet-1',
        cwd: launchOverrides?.workingDirPath ?? cwd,
        recipe: null,
        initialPreamble: [
          'Huabu bootstrap',
          ...(spacePrompt ? [spacePrompt] : []),
          ...(launchOverrides?.additionalInitialPreamble
            ? [launchOverrides.additionalInitialPreamble]
            : []),
        ],
      },
    }),
  );
  const ensureSession = vi.fn().mockResolvedValue({
    profileId: 'profile-fixed',
    configOptions: [],
  } as unknown as AcpSessionEntry);
  const collectSpacePrompt =
    options?.collect ??
    vi.fn().mockResolvedValue({
      markdown: '<space_prompt>Space rules</space_prompt>',
      diagnostics: {
        includedFrameIds: [],
        includedNodeIds: [],
        omittedUnsupportedIds: [],
        omittedEmptyTextIds: [],
        omittedMissingIds: [],
        omittedBudgetNodeIds: [],
        truncatedNoteIds: [],
        truncated: false,
      },
    });
  const service = new ExternalAgentRealizationService({
    resolveAgentNode: vi
      .fn()
      .mockResolvedValue(
        options && 'agentTarget' in options
          ? (options.agentTarget ?? null)
          : target,
      ),
    resolveFixedAgentNode: vi.fn().mockResolvedValue(target),
    collectSpacePrompt,
    readRecord: vi.fn(() => durableRecord),
    createHandle,
    buildSpec,
    subscribeProfileCache: vi.fn(),
    subscribeTitles,
    ensureSession,
    ...(options?.bindingCoordinator
      ? {
          confirmBinding: (...args: Parameters<typeof binding.confirm>) =>
            binding.confirm(...args),
          acquireTurn,
        }
      : {}),
  });
  return {
    service,
    handle,
    createHandle,
    subscribeTitles,
    buildSpec,
    collectSpacePrompt,
    ensureSession,
    promote,
    acquireTurn,
    release,
    record: () => durableRecord,
  };
}

describe('ExternalAgentRealizationService', () => {
  it('rejects a persisted internal node before opening its mismatched external execution', async () => {
    const node = {
      ...target,
      agentBinding: { kind: 'internal' as const },
      bindingState: 'editing' as const,
    };
    const h = createHarness({
      bindingCoordinator: true,
      agentTarget: node,
      record: {
        spec: {
          threadId: target.threadId,
          namespace: { name: target.canvasId },
          kind: 'external',
          workloadType: 'Deployment',
          spec: { binding: targetBinding },
        },
        driverSchemaVersion: 1,
        state: { driverState: {} },
      } as ThreadRecord,
    });
    await expect(
      h.service.realize({
        canvasId: node.canvasId,
        threadId: node.threadId,
        agentTarget: node,
        fixedTarget: null,
        logger,
      }),
    ).rejects.toMatchObject({ code: 'agent_binding_conflict' });
    expect(h.promote).toHaveBeenCalledOnce();
    expect(h.createHandle).not.toHaveBeenCalled();
    expect(h.ensureSession).not.toHaveBeenCalled();
  });

  it('binds a first control before opening the session without a prompt projection', async () => {
    const node = { ...target, bindingState: 'editing' as const };
    const h = createHarness({ bindingCoordinator: true, agentTarget: node });
    h.promote.mockImplementation(async () => {
      expect(h.record()?.spec.kind).toBe('external');
      expect(h.ensureSession).not.toHaveBeenCalled();
      expect(h.handle.control).not.toHaveBeenCalled();
    });
    const realized = await h.service.realize({
      canvasId: node.canvasId,
      threadId: node.threadId,
      fixedTarget: node,
      requestedBinding: targetBinding,
      logger,
    });
    expect(h.promote).toHaveBeenCalledOnce();
    expect(node).not.toHaveProperty('invocationToken');
    expect(node.status).toBe('idle');
    expect(node.content).toBe('');
    expect(h.release).toHaveBeenCalledOnce();
    await h.service.ensureSession(realized, logger);
  });

  it('keeps canonical execution after promotion fails and completes it on retry', async () => {
    const node = { ...target, bindingState: 'editing' as const };
    const h = createHarness({ bindingCoordinator: true, agentTarget: node });
    h.promote.mockRejectedValueOnce(new Error('Bound persistence failed'));
    const options = {
      canvasId: node.canvasId,
      threadId: node.threadId,
      fixedTarget: node,
      requestedBinding: targetBinding,
      logger,
    };
    await expect(h.service.realize(options)).rejects.toThrow(
      'Bound persistence failed',
    );
    expect(h.record()).toBeDefined();
    expect(node.bindingState).toBe('editing');
    expect(h.ensureSession).not.toHaveBeenCalled();
    await h.service.realize(options);
    expect(node.bindingState).toBe('bound');
    expect(h.promote).toHaveBeenCalledTimes(2);
    expect(h.buildSpec).toHaveBeenCalledOnce();
  });

  it('refuses first control realization while another operation owns admission', async () => {
    const h = createHarness({ bindingCoordinator: true });
    h.acquireTurn.mockReturnValueOnce(null);
    await expect(
      h.service.realize({
        canvasId: 'canvas-1',
        threadId: 'thread-1',
        fixedTarget: target,
        requestedBinding: targetBinding,
        logger,
      }),
    ).rejects.toMatchObject({ code: 'agent_draft_busy' });
    expect(h.createHandle).not.toHaveBeenCalled();
  });

  it('does not create a delayed execution after preparation is cancelled', async () => {
    const controller = new AbortController();
    const h = createHarness({
      bindingCoordinator: true,
      agentTarget: { ...target },
      collect: async () => {
        controller.abort();
        return null;
      },
    });
    await expect(
      h.service.realize({
        canvasId: 'canvas-1',
        threadId: 'thread-1',
        fixedTarget: { ...target },
        requestedBinding: targetBinding,
        signal: controller.signal,
        logger,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.createHandle).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('realizes first control with the fixed Space Prompt and node instructions', async () => {
    const harness = createHarness();
    const realized = await harness.service.realize({
      threadId: 'thread-1',
      canvasId: 'canvas-1',
      requestedBinding: targetBinding,
      fixedTarget: target,
      logger,
    });

    await harness.service.ensureSession(realized, logger);
    expect(harness.subscribeTitles).toHaveBeenCalledWith(
      'canvas-1',
      'thread-1',
    );
    await realized.handle.control({
      type: 'set_mode',
      data: { modeId: 'plan' },
    });

    expect(realized.spec.spec).toMatchObject({
      binding: {
        alias: 'Fixed Agent',
        profileId: 'profile-fixed',
      },
      cwd: '/fixed/work',
      initialPreamble: [
        'Huabu bootstrap',
        '<space_prompt>Space rules</space_prompt>',
        'Node instructions',
      ],
    });
    expect(harness.ensureSession).toHaveBeenCalledWith(realized, logger);
    expect(harness.handle.control).toHaveBeenCalledOnce();
  });

  it('captures the Space Prompt for a selectable Agent Node', async () => {
    const harness = createHarness({ agentTarget: selectableTarget });
    const realized = await harness.service.realize({
      threadId: 'thread-1',
      canvasId: 'canvas-1',
      requestedBinding: {
        kind: 'external',
        alias: 'Selectable Agent',
        profileId: 'profile-selectable',
      },
      fixedTarget: null,
      logger,
    });

    expect(harness.collectSpacePrompt).toHaveBeenCalledWith(
      'canvas-1',
      selectableTarget.nodeId,
    );
    expect(realized.spec.spec.initialPreamble).toEqual([
      'Huabu bootstrap',
      '<space_prompt>Space rules</space_prompt>',
    ]);
    expect(harness.subscribeTitles).toHaveBeenCalledWith(
      'canvas-1',
      'thread-1',
    );
  });

  it('does not capture a Space Prompt for a node-less external thread', async () => {
    const harness = createHarness({ agentTarget: null });
    const realized = await harness.service.realize({
      threadId: 'thread-1',
      canvasId: 'canvas-1',
      requestedBinding: {
        kind: 'external',
        alias: 'Standalone Agent',
        profileId: 'profile-standalone',
      },
      fixedTarget: null,
      logger,
    });

    expect(harness.collectSpacePrompt).not.toHaveBeenCalled();
    expect(realized.spec.spec.initialPreamble).toEqual(['Huabu bootstrap']);
    await harness.service.ensureSession(realized, logger);
    await realized.handle.control({
      type: 'set_mode',
      data: { modeId: 'plan' },
    });
    expect(harness.subscribeTitles).toHaveBeenCalledWith(
      'canvas-1',
      'thread-1',
    );
    expect(harness.createHandle.mock.invocationCallOrder[0]).toBeLessThan(
      harness.subscribeTitles.mock.invocationCallOrder[0],
    );
    expect(harness.subscribeTitles.mock.invocationCallOrder[0]).toBeLessThan(
      harness.ensureSession.mock.invocationCallOrder[0],
    );
    expect(harness.handle.control).toHaveBeenCalledOnce();
  });

  it('rejects a fixed Profile mismatch before creating a workload', async () => {
    const harness = createHarness();

    await expect(
      harness.service.realize({
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        requestedBinding: {
          kind: 'external',
          alias: 'Other',
          profileId: 'profile-other',
        },
        fixedTarget: target,
        logger,
      }),
    ).rejects.toMatchObject({
      code: 'external_binding_conflict',
    } satisfies Partial<ExternalAgentRealizationError>);
    expect(harness.collectSpacePrompt).not.toHaveBeenCalled();
    expect(harness.createHandle).not.toHaveBeenCalled();
  });

  it('rejects a fixed working-directory mismatch before creating a workload', async () => {
    const harness = createHarness();

    await expect(
      harness.service.realize({
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        requestedBinding: targetBinding,
        requestedCwd: '/client/override',
        fixedTarget: target,
        logger,
      }),
    ).rejects.toMatchObject({
      code: 'external_working_directory_conflict',
    } satisfies Partial<ExternalAgentRealizationError>);
    expect(harness.createHandle).not.toHaveBeenCalled();
  });

  it('reuses the persisted canonical workload without recollecting Prompt Frames', async () => {
    const persisted: AcpWorkloadSpec = {
      threadId: 'thread-1',
      namespace: {
        name: 'canvas-1',
        storage: { root: '/spaces/canvas-1/.history' },
      },
      kind: 'external',
      workloadType: 'Deployment',
      spec: {
        binding: { alias: 'Fixed Agent', profileId: 'profile-fixed' },
        agentletId: 'agentlet-1',
        cwd: '/fixed/work',
        recipe: null,
        initialPreamble: [
          'Huabu bootstrap',
          '<space_prompt>Original rules</space_prompt>',
          'Node instructions',
        ],
      },
    };
    const harness = createHarness({
      record: {
        driverSchemaVersion: 1,
        spec: persisted,
        state: { driverState: { initialPreambleDelivered: false } },
      },
    });

    const realized = await harness.service.realize({
      threadId: 'thread-1',
      canvasId: 'canvas-1',
      requestedBinding: targetBinding,
      fixedTarget: target,
      logger,
    });

    expect(realized.spec).toBe(persisted);
    expect(harness.buildSpec).not.toHaveBeenCalled();
    expect(harness.collectSpacePrompt).not.toHaveBeenCalled();
    expect(harness.subscribeTitles).toHaveBeenCalledWith(
      'canvas-1',
      'thread-1',
    );
  });

  it.each([false, true])(
    'gates persisted-thread subscriptions by current selectable ownership (%s)',
    async (questionOwned) => {
      const initial = createHarness({ agentTarget: null });
      const { spec } = await initial.service.realize({
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        requestedBinding: targetBinding,
        fixedTarget: null,
        logger,
      });
      const harness = createHarness({
        agentTarget: questionOwned ? selectableTarget : null,
        record: {
          driverSchemaVersion: 1,
          spec,
          state: { driverState: { initialPreambleDelivered: false } },
        },
      });
      const realized = await harness.service.realize({
        threadId: 'thread-1',
        canvasId: 'canvas-1',
        fixedTarget: null,
        logger,
      });

      await harness.service.ensureSession(realized, logger);
      expect(harness.subscribeTitles).toHaveBeenCalledTimes(1);
      expect(harness.buildSpec).not.toHaveBeenCalled();
      expect(harness.collectSpacePrompt).not.toHaveBeenCalled();
    },
  );

  it('single-flights simultaneous first interactions', async () => {
    let releaseCollection!: () => void;
    const collectionGate = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    const collect = vi.fn(async () => {
      await collectionGate;
      return {
        markdown: '<space_prompt>Space rules</space_prompt>',
        diagnostics: {
          includedFrameIds: [],
          includedNodeIds: [],
          omittedUnsupportedIds: [],
          omittedEmptyTextIds: [],
          omittedMissingIds: [],
          omittedBudgetNodeIds: [],
          truncatedNoteIds: [],
          truncated: false,
        },
      };
    });
    const harness = createHarness({ collect });
    const options = {
      threadId: 'thread-1',
      canvasId: 'canvas-1',
      requestedBinding: targetBinding,
      fixedTarget: target,
      logger,
    };

    const first = harness.service.realize(options);
    const second = harness.service.realize(options);
    await Promise.resolve();
    expect(collect).toHaveBeenCalledOnce();

    releaseCollection();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.spec).toBe(secondResult.spec);
    expect(harness.buildSpec).toHaveBeenCalledOnce();
    expect(harness.createHandle).toHaveBeenCalledOnce();
  });
});
