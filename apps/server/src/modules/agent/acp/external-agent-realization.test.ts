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

import type { ExternalAgentRealizationError } from './external-agent-realization.js';
import type { AcpHandle, AcpWorkloadSpec } from '../agenetes/drivers.js';
import type { FixedAgentNodeTarget } from '../agent-thread-resolver.js';
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

function createHarness(options?: {
  record?: ThreadRecord;
  collect?: () => Promise<{
    markdown: string;
    diagnostics: {
      includedFrameIds: string[];
      includedNodeIds: string[];
      omittedUnsupportedIds: string[];
      omittedEmptyTextIds: string[];
      omittedMissingIds: string[];
      truncated: boolean;
    };
  } | null>;
}) {
  const handle = {
    control: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as AcpHandle;
  const createHandle = vi.fn(() => handle);
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
        truncated: false,
      },
    });
  const service = new ExternalAgentRealizationService({
    resolveFixedAgentNode: vi.fn().mockResolvedValue(target),
    collectSpacePrompt,
    readRecord: vi.fn(() => options?.record),
    createHandle,
    buildSpec,
    subscribeProfileCache: vi.fn(),
    ensureSession,
  });
  return {
    service,
    handle,
    createHandle,
    buildSpec,
    collectSpacePrompt,
    ensureSession,
  };
}

describe('ExternalAgentRealizationService', () => {
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
  });

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
