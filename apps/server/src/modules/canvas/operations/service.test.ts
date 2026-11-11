// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCanvasOperationsEnabled } from './scope.js';
import { submitCanvasOperation } from './service.js';
import { validateOperationWrite } from '../../storage/ports/operation-rules.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';

import type {
  SpaceOperationSnapshot,
  SpaceOperationWrite,
  SpaceOperationKey,
} from '../../storage/ports/operations.js';
import type {
  CanvasOperationLookup,
  CanvasOperationReceipt,
} from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  trace: [] as string[],
  space: vi.fn(),
  release: vi.fn(),
  reviewConfig: vi.fn(),
}));
vi.mock('../../agent/change-review-config.js', () => ({
  getAgentChangeReviewConfig: mocks.reviewConfig,
}));
vi.mock('../../storage/index.js', () => ({
  space: (...args: unknown[]) => {
    mocks.trace.push('resolve');
    return mocks.space(...args);
  },
}));
vi.mock('../../workspace.js', () => ({
  acquireWorkspaceOperationLease: () => {
    mocks.trace.push('lease');
    return { workspaceKey: 'workspace:test', release: mocks.release };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trace.length = 0;
  setCanvasOperationsEnabled(true);
});
afterEach(() => setCanvasOperationsEnabled(undefined));

function request() {
  return {
    protocolVersion: 1,
    spaceEpoch: randomUUID(),
    sessionId: randomUUID(),
    operationId: randomUUID(),
    observedVersion: 0,
    mode: 'atomic',
    commands: [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'node-a', position: { x: 1, y: 2 } }],
      },
    ],
    preconditions: [],
  };
}

describe('guarded operation service', () => {
  it('binds trusted thread attribution and preserves auto-accept policy without reevaluating retries', async () => {
    mocks.reviewConfig.mockReturnValue({ autoAcceptSpaceChanges: false });
    const input = request();
    const incarnation = randomUUID();
    let snapshot: SpaceOperationSnapshot = {
      record: {
        canvasId: 'space-a',
        title: 'Space',
        version: 0,
        createdAt: 0,
        updatedAt: 0,
        state: {
          nodes: [
            { id: 'node-a', type: 'note', position: { x: 0, y: 0 }, data: {} },
          ],
          edges: [],
        },
      },
      sidecars: {},
      reviews: {},
      metadata: {
        modelVersion: 1,
        spaceEpoch: input.spaceEpoch,
        earliestReplayVersion: 0,
        reviewRevision: 0,
        siblingOrderVersions: [{ parentId: null, version: 0 }],
        nodes: {
          'node-a': {
            incarnation,
            membershipVersion: 0,
            coordinateContext: `root:${input.spaceEpoch}`,
            fieldVersions: { position: 0, 'style.accent': 0 },
          },
        },
      },
    };
    const source = {
      ...input,
      preconditions: [
        {
          kind: 'coordinates',
          commandIndex: 0,
          nodeId: 'node-a',
          incarnation,
          parentId: null,
          membershipVersion: 0,
          coordinateContext: `root:${input.spaceEpoch}`,
        },
      ],
    };
    const receipts = new Map<string, SpaceOperationWrite>();
    const operations = {
      async lookup(key: SpaceOperationKey, digest: string) {
        const prior = receipts.get(key.operationId);
        if (!prior) return { status: 'absent' };
        if (prior.digest !== digest)
          throw new SpaceOperationError(
            'operation-id-reused',
            'Request changed',
          );
        return { status: 'terminal', receipt: prior.receipt };
      },
      readSnapshot: async () => snapshot,
      commit: vi.fn(async (plan: SpaceOperationWrite) => {
        validateOperationWrite(snapshot, plan);
        receipts.set(plan.key.operationId, plan);
        snapshot = {
          ...snapshot,
          record: plan.structure?.nextRecord ?? snapshot.record,
          metadata: plan.metadata,
          reviews: {
            ...snapshot.reviews,
            ...Object.fromEntries(
              plan.review.map(({ threadId, records }) => [threadId, records]),
            ),
          },
        };
        return plan.receipt;
      }),
    };
    mocks.space.mockReturnValue({ operations });
    const submit = (body: unknown, threadId = 'thread-a') =>
      submitCanvasOperation({
        canvasId: 'space-a',
        request: body,
        principalId: 'owner',
        origin: { kind: 'agent' },
        reviewThreadId: threadId,
      });
    const receipt = await submit(source);
    expect(receipt).toMatchObject({
      status: 'committed',
      commit: { reviewRevision: 1, reviewRecord: { threadId: 'thread-a' } },
    });
    expect(snapshot.reviews['thread-a']).toHaveLength(1);
    mocks.reviewConfig.mockReturnValue({ autoAcceptSpaceChanges: true });
    expect(await submit(source)).toEqual(receipt);
    expect(mocks.reviewConfig).toHaveBeenCalledOnce();
    expect(operations.commit).toHaveBeenCalledOnce();
    await expect(submit(source, 'thread-b')).rejects.toMatchObject({
      code: 'operation-id-reused',
    });
    expect(
      await submit({
        ...source,
        operationId: randomUUID(),
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [{ nodeId: 'node-a', position: { x: 30, y: 40 } }],
          },
        ],
      }),
    ).toMatchObject({ status: 'committed' });
    expect(snapshot.metadata.reviewRevision).toBe(1);
    expect(snapshot.reviews['thread-a']).toHaveLength(1);
  });

  it.each([
    { enabled: true, trace: ['lease', 'resolve'] },
    { enabled: false, trace: ['lease'] },
    { enabled: undefined, trace: ['lease'] },
  ])(
    'refuses a missing adapter or a disabled switch ($enabled) and releases the captured lease',
    async ({ enabled, trace }) => {
      setCanvasOperationsEnabled(enabled);
      const lookup = vi.fn();
      mocks.space.mockReturnValue(
        enabled ? { operations: undefined } : { operations: { lookup } },
      );
      await expect(
        submitCanvasOperation({
          canvasId: 'space-a',
          request: request(),
          principalId: 'owner',
          origin: { kind: 'ui' },
        }),
      ).rejects.toMatchObject({ code: 'collaboration-disabled' });
      expect(mocks.trace).toEqual(trace);
      expect(lookup).not.toHaveBeenCalled();
      expect(mocks.release).toHaveBeenCalledOnce();
    },
  );

  it('holds the lease through receipt resolution and does not rerun a terminal operation', async () => {
    const input = request();
    const receipt: CanvasOperationReceipt = {
      spaceEpoch: input.spaceEpoch,
      sessionId: input.sessionId,
      operationId: input.operationId,
      status: 'noop',
      atVersion: 0,
      commit: null,
      results: [{ commandIndex: 0, applied: false, reason: 'no-change' }],
    };
    let resolve!: (value: CanvasOperationLookup) => void;
    const outcome = new Promise<CanvasOperationLookup>((done) => {
      resolve = done;
    });
    const lookup = vi.fn(() => outcome);
    const readSnapshot = vi.fn();
    mocks.space.mockReturnValue({
      operations: { lookup, readSnapshot },
    });
    const pending = submitCanvasOperation({
      canvasId: 'space-a',
      request: input,
      principalId: 'owner',
      origin: { kind: 'ui' },
    });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    expect(mocks.trace).toEqual(['lease', 'resolve']);
    expect(mocks.release).not.toHaveBeenCalled();
    resolve({ status: 'terminal', receipt });
    expect(await pending).toEqual(receipt);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('does not convert an uncertain storage failure into rejection or re-execution', async () => {
    const failure = new Error('Connection lost while resolving the outcome');
    const lookup = vi.fn().mockRejectedValue(failure);
    mocks.space.mockReturnValue({
      operations: { lookup },
    });
    await expect(
      submitCanvasOperation({
        canvasId: 'space-a',
        request: request(),
        principalId: 'owner',
        origin: { kind: 'ui' },
      }),
    ).rejects.toBe(failure);
    expect(lookup).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
