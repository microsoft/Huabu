// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { randomUUID } from 'node:crypto';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  canvasOperationSnapshotSchema,
} from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { publishCanvasUpdate, subscribeCanvasUpdates } from '../canvas-sync.js';
import operationRoutes from './routes.js';
import { operationChannel, setCanvasOperationsEnabled } from './scope.js';
import { setRequestIdentity } from '../../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../../identity/service.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';
import syncRoutes from '../sync.route.js';

import type { SpaceOperationWrite } from '../../storage/ports/operations.js';
import type {
  CanvasOperationCommit,
  CanvasOperationReceipt,
} from '@huabu/shared';

const mocks = vi.hoisted(() => ({
  operations: {
    readSnapshot: vi.fn(),
    createSession: vi.fn(),
    lookup: vi.fn(),
    readCommits: vi.fn(),
    commit: vi.fn(),
  },
  release: vi.fn(),
}));
vi.mock('../../storage/index.js', () => ({
  space: () => ({ operations: mocks.operations }),
}));
vi.mock('../../workspace.js', () => ({
  acquireWorkspaceOperationLease: () => ({
    workspaceKey: 'workspace:test',
    release: mocks.release,
  }),
}));
const disposers: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.resetAllMocks();
  setCanvasOperationsEnabled(true);
});
afterEach(async () => {
  setCanvasOperationsEnabled(undefined);
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const epoch = randomUUID();
const sessionId = randomUUID();
function commit(fromVersion = 0): CanvasOperationCommit {
  return {
    spaceEpoch: epoch,
    sessionId,
    operationId: randomUUID(),
    fromVersion,
    toVersion: fromVersion + 1,
    origin: { kind: 'ui' },
    events: [
      {
        type: 'SET_SIBLING_ORDER',
        parentId: null,
        before: ['a', 'b'],
        after: ['b', 'a'],
        orderVersion: fromVersion + 1,
      },
    ],
    results: [{ commandIndex: 0, applied: true }],
  };
}
async function app(owner: boolean | null = true) {
  const instance = Fastify();
  if (owner !== null)
    instance.addHook('onRequest', async (request) => {
      setRequestIdentity(request, {
        principal: { principalId: 'owner', kind: 'user' },
        member: true,
        owner,
        access: UNRESTRICTED_ACCESS,
      });
    });
  await instance.register(operationRoutes);
  await instance.register(syncRoutes);
  disposers.push(() => instance.close());
  return instance;
}

describe('operation HTTP contracts', () => {
  it('uses the existing gated endpoint for creation and returns generated IDs without the initial body', async () => {
    const instance = await app();
    mocks.operations.lookup.mockResolvedValue({ status: 'absent' });
    mocks.operations.readSnapshot.mockResolvedValue({
      record: {
        canvasId: 'space',
        title: 'Space',
        version: 0,
        updatedAt: 0,
        state: { nodes: [], edges: [] },
      },
      metadata: {
        modelVersion: 1,
        spaceEpoch: epoch,
        earliestReplayVersion: 0,
        reviewRevision: 0,
        nodes: {},
        siblingOrderVersions: [{ parentId: null, version: 0 }],
      },
      sidecars: {},
      reviews: {},
    });
    mocks.operations.commit.mockImplementation(
      async (plan: SpaceOperationWrite) => plan.receipt,
    );
    const payload = {
      protocolVersion: 1,
      spaceEpoch: epoch,
      sessionId,
      operationId: randomUUID(),
      observedVersion: 0,
      mode: 'atomic',
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'text',
              position: { x: 1, y: 2 },
              data: { content: 'Private initial body' },
            },
          ],
        },
      ],
      preconditions: [],
    };
    const response = await instance.inject({
      method: 'POST',
      url: '/space/operations',
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'committed',
      results: [
        {
          commandIndex: 0,
          applied: true,
          nodeIds: [expect.stringMatching(/^node-/)],
        },
      ],
    });
    expect(response.body).not.toContain('Private initial body');
    const plan = mocks.operations.commit.mock
      .calls[0]?.[0] as SpaceOperationWrite;
    expect(plan.structure?.nodeMutations[0]).toMatchObject({
      kind: 'put',
      record: { content: 'Private initial body' },
    });
    mocks.operations.lookup.mockResolvedValue({
      status: 'terminal',
      receipt: response.json(),
    });
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/space/operations',
          payload,
        })
      ).json(),
    ).toEqual(response.json());
    expect(mocks.operations.commit).toHaveBeenCalledOnce();
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/space/operations',
          payload: {
            ...payload,
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    ...payload.commands[0]?.nodes[0],
                    restore: { incarnation: 'old', deletedVersion: 1 },
                  },
                ],
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('commits a content-owner plan before publishing its body-free notification', async () => {
    const instance = await app();
    const events: unknown[] = [];
    const unsubscribe = subscribeCanvasUpdates(
      operationChannel('workspace:test', 'space'),
      (event) => events.push(event),
    );
    disposers.push(async () => unsubscribe());
    mocks.operations.lookup.mockResolvedValue({ status: 'absent' });
    const body = { nodeId: 'a', type: 'note', label: 'A', content: 'before' };
    mocks.operations.readSnapshot.mockResolvedValue({
      record: {
        canvasId: 'space',
        version: 0,
        state: {
          nodes: [
            { id: 'a', type: 'note', position: { x: 0, y: 0 }, data: {} },
          ],
          edges: [],
        },
      },
      metadata: {
        modelVersion: 1,
        spaceEpoch: epoch,
        earliestReplayVersion: 0,
        reviewRevision: 0,
        nodes: {
          a: {
            incarnation: 'life-a',
            membershipVersion: 0,
            coordinateContext: 'root',
            fieldVersions: { position: 0, 'style.accent': 0 },
          },
        },
        siblingOrderVersions: [{ parentId: null, version: 0 }],
      },
      sidecars: { a: body },
    });
    mocks.operations.commit.mockImplementation(
      async (plan: SpaceOperationWrite) => {
        expect(events).toEqual([]);
        expect(plan.structure?.nodeMutations).toEqual([
          {
            kind: 'put',
            nodeId: 'a',
            record: { ...body, content: 'after' },
          },
        ]);
        return plan.receipt;
      },
    );
    const payload = {
      protocolVersion: 1,
      spaceEpoch: epoch,
      sessionId,
      operationId: randomUUID(),
      observedVersion: 0,
      incarnation: 'life-a',
      update: {
        nodeType: 'note',
        content: 'after',
        expectRev: nodeRevisionOf(body),
      },
    };
    const response = await instance.inject({
      method: 'POST',
      url: '/space/nodes/a/content/operations',
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('committed');
    expect(events).toEqual([{ type: 'commit', data: response.json().commit }]);
    expect(JSON.stringify(events)).not.toContain('"content"');
    mocks.operations.commit.mockRejectedValue(
      new Error('Unknown disk outcome'),
    );
    events.length = 0;
    const unknown = await instance.inject({
      method: 'POST',
      url: '/space/nodes/a/content/operations',
      payload: { ...payload, operationId: randomUUID() },
    });
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().code).toBe('operation-outcome-unknown');
    expect(events).toEqual([]);
  });

  it('validates content operations and returns the original terminal result without reapplying CAS', async () => {
    const instance = await app();
    const payload = {
      protocolVersion: 1,
      spaceEpoch: epoch,
      sessionId,
      operationId: randomUUID(),
      observedVersion: 0,
      incarnation: 'life-a',
      update: { nodeType: 'note', content: 'new body', expectRev: 'old-rev' },
    };
    for (const invalid of [
      { ...payload, principalId: 'spoof' },
      { ...payload, update: { ...payload.update, src: 'unprepared-source' } },
      { ...payload, update: { nodeType: 'note', content: 'no CAS' } },
    ]) {
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/space/nodes/a/content/operations',
            payload: invalid,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(mocks.operations.lookup).not.toHaveBeenCalled();
    const receipt = {
      status: 'noop',
      spaceEpoch: epoch,
      sessionId,
      operationId: payload.operationId,
      atVersion: 1,
      commit: null,
      results: [
        {
          commandIndex: 0,
          nodeId: 'a',
          applied: false,
          reason: 'no-change',
          contentRevision: 'saved-rev',
        },
      ],
    };
    mocks.operations.lookup.mockResolvedValue({ status: 'terminal', receipt });
    const response = await instance.inject({
      method: 'POST',
      url: '/space/nodes/a/content/operations',
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(receipt);
    expect(mocks.operations.readSnapshot).not.toHaveBeenCalled();
    expect(mocks.operations.commit).not.toHaveBeenCalled();
    expect(mocks.operations.lookup.mock.calls[0]?.[0]).toMatchObject({
      principalId: 'owner',
    });
  });

  it.each([
    [null, 401],
    [false, 403],
  ] as const)(
    'requires authenticated owner scope (%s)',
    async (owner, status) => {
      const instance = await app(owner);
      const response = await instance.inject({
        method: 'POST',
        url: '/space/sync/sessions',
        payload: { protocolVersion: 1 },
      });
      expect(response.statusCode).toBe(status);
      expect(mocks.operations.createSession).not.toHaveBeenCalled();
    },
  );

  it('validates sessions, query bounds and protocol negotiation before storage', async () => {
    const instance = await app();
    for (const request of [
      {
        method: 'POST' as const,
        url: '/space/sync/sessions',
        payload: { protocolVersion: 1, principalId: 'spoof' },
      },
      {
        method: 'GET' as const,
        url: `/space/sync/commits?spaceEpoch=${epoch}&afterVersion=-1`,
      },
      {
        method: 'GET' as const,
        url: `/space/sync/commits?spaceEpoch=${epoch}&afterVersion=0&limit=201`,
      },
      {
        method: 'GET' as const,
        url: `/space/sync/stream?protocolVersion=2&spaceEpoch=${epoch}&afterVersion=0`,
      },
    ])
      expect((await instance.inject(request)).statusCode).toBe(400);
    expect(mocks.operations.createSession).not.toHaveBeenCalled();
    expect(mocks.operations.readCommits).not.toHaveBeenCalled();
  });

  it('refuses every session while the global switch is off', async () => {
    setCanvasOperationsEnabled(false);
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/space/sync/sessions',
      payload: { protocolVersion: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'collaboration-disabled' });
    expect(mocks.operations.createSession).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('returns the original terminal receipt and the same canonical HTTP envelope', async () => {
    const canonical = commit();
    const receipt: CanvasOperationReceipt = {
      spaceEpoch: epoch,
      sessionId,
      operationId: canonical.operationId,
      status: 'committed',
      commitVersion: 1,
      commit: canonical,
      results: canonical.results,
    };
    mocks.operations.lookup.mockResolvedValue({ status: 'terminal', receipt });
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/space/operations',
      payload: {
        protocolVersion: 1,
        spaceEpoch: epoch,
        sessionId,
        operationId: canonical.operationId,
        observedVersion: 0,
        mode: 'atomic',
        commands: [{ type: 'REORDER_NODES', nodeIds: ['a'], to: 'top' }],
        preconditions: [],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(receipt);
    expect(mocks.operations.commit).not.toHaveBeenCalled();
    expect(mocks.operations.readSnapshot).not.toHaveBeenCalled();
    const lookup = await instance.inject(
      `/space/operations/${canonical.operationId}?spaceEpoch=${epoch}&sessionId=${sessionId}`,
    );
    expect(lookup.json()).toEqual({ status: 'terminal', receipt });
    expect(mocks.operations.lookup.mock.calls[1]?.[0]).toMatchObject({
      principalId: 'owner',
    });
  });

  it.each(CANVAS_NODE_TYPES)(
    'projects %s structure without sidecars, bodies or private fields',
    async (nodeType) => {
      const metadata = {
        modelVersion: 1,
        spaceEpoch: epoch,
        earliestReplayVersion: 0,
        reviewRevision: 0,
        nodes: {
          a: {
            incarnation: 'life-a',
            membershipVersion: 0,
            coordinateContext: `root:${epoch}`,
            fieldVersions: { position: 0, 'style.accent': 0 },
          },
        },
        siblingOrderVersions: [
          { parentId: null, version: 0 },
          ...(nodeType === 'frame' ? [{ parentId: 'a', version: 0 }] : []),
        ],
      };
      mocks.operations.readSnapshot.mockResolvedValue({
        record: {
          version: 3,
          state: {
            nodes: [
              {
                id: 'a',
                type: nodeType,
                position: { x: 1, y: 2 },
                data: {
                  content: 'private body',
                  src: 'private source',
                  style: { accent: 'white' },
                  internal: 'secret',
                },
              },
            ],
            edges: [],
          },
        },
        metadata,
        sidecars: { a: { content: 'private body' } },
      });
      const instance = await app();
      const response = await instance.inject('/space/sync/snapshot');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ version: 3, metadata });
      expect(response.json().state.nodes[0].type).toBe(nodeType);
      expect(response.json().state.nodes[0].data).toEqual({
        style: { accent: 'white' },
      });
      expect(response.body).not.toMatch(/private|secret|sidecars/);
      const snapshot = response.json();
      snapshot.state.nodes[0].type = 'unknown-node-kind';
      expect(canvasOperationSnapshotSchema.safeParse(snapshot).success).toBe(
        false,
      );
      snapshot.state.nodes[0].type = nodeType;
      snapshot.state.nodes[0].parentId = 'missing-parent';
      expect(canvasOperationSnapshotSchema.safeParse(snapshot).success).toBe(
        false,
      );
      delete snapshot.state.nodes[0].parentId;
      snapshot.metadata.siblingOrderVersions.push({
        parentId: null,
        version: 0,
      });
      expect(canvasOperationSnapshotSchema.safeParse(snapshot).success).toBe(
        false,
      );
    },
  );

  it.each([
    [new Error('connection lost'), 503, 'operation-outcome-unknown'],
    [
      new SpaceOperationError('operation-id-reused', 'Operation ID reused'),
      409,
      'operation-id-reused',
    ],
  ])(
    'does not turn storage uncertainty into a terminal rejection',
    async (failure, status, code) => {
      mocks.operations.lookup.mockRejectedValue(failure);
      const instance = await app();
      const response = await instance.inject(
        `/space/operations/${randomUUID()}?spaceEpoch=${epoch}&sessionId=${sessionId}`,
      );
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.json()).not.toHaveProperty('status');
    },
  );
});

describe('negotiated operation stream', () => {
  beforeEach(() => {
    mocks.operations.readSnapshot.mockResolvedValue({
      metadata: { spaceEpoch: epoch, reviewRevision: 0 },
    });
  });
  async function open() {
    const instance = await app();
    const address = await instance.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    disposers.push(async () => {
      controller.abort();
    });
    const response = await fetch(
      `${address}/space/sync/stream?protocolVersion=1&spaceEpoch=${epoch}&afterVersion=0`,
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing SSE body');
    let body = '';
    return {
      controller,
      async until(text: string) {
        while (!body.includes(text)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Stream ended before ${text}`);
          body += new TextDecoder().decode(chunk.value);
        }
        return body;
      },
    };
  }

  it('recovers Review revisions on reconnect, coalesces raced notifications and never regresses on duplicates', async () => {
    const channel = operationChannel('workspace:test', 'space');
    mocks.operations.readSnapshot.mockResolvedValue({
      metadata: { spaceEpoch: epoch, reviewRevision: 7 },
    });
    mocks.operations.readCommits.mockImplementation(async () => {
      publishCanvasUpdate(channel, {
        type: 'review',
        data: { spaceEpoch: epoch, reviewRevision: 8 },
      });
      publishCanvasUpdate(channel, {
        type: 'review',
        data: { spaceEpoch: epoch, reviewRevision: 6 },
      });
      return {
        status: 'commits',
        spaceEpoch: epoch,
        fromVersion: 0,
        throughVersion: 0,
        commits: [],
        nextAfterVersion: 0,
        hasMore: false,
      };
    });
    const stream = await open();
    const baseline = await stream.until('event: ready');
    expect(baseline).toContain('"reviewRevision":8');
    expect(baseline.match(/event: review/g)).toHaveLength(1);
    publishCanvasUpdate(channel, {
      type: 'review',
      data: { spaceEpoch: epoch, reviewRevision: 7 },
    });
    publishCanvasUpdate(channel, {
      type: 'review',
      data: { spaceEpoch: epoch, reviewRevision: 9 },
    });
    const live = await stream.until('"reviewRevision":9');
    expect(live.match(/event: review/g)).toHaveLength(2);
    publishCanvasUpdate(channel, {
      type: 'review',
      data: { spaceEpoch: randomUUID(), reviewRevision: 10 },
    });
    expect(await stream.until('event: recovery-required')).toContain(
      'snapshot-required',
    );
  });

  it('closes the replay/subscription race, deduplicates echoes, isolates Workspace and surfaces gaps', async () => {
    const first = commit();
    const second = commit(1);
    const channel = operationChannel('workspace:test', 'space');
    mocks.operations.readCommits.mockImplementation(async () => {
      publishCanvasUpdate(channel, { type: 'commit', data: first });
      publishCanvasUpdate(channel, { type: 'commit', data: second });
      return {
        status: 'commits',
        spaceEpoch: epoch,
        fromVersion: 0,
        throughVersion: 1,
        commits: [first],
        nextAfterVersion: 1,
        hasMore: false,
      };
    });
    const stream = await open();
    let body = await stream.until('event: ready');
    expect(body.match(/event: commit/g)).toHaveLength(2);
    expect(body).toContain(JSON.stringify(first));
    expect(body).toContain(JSON.stringify(second));
    expect(body).toContain(`"version":2`);
    publishCanvasUpdate(operationChannel('workspace:other', 'space'), {
      type: 'commit',
      data: commit(10),
    });
    publishCanvasUpdate(channel, { type: 'commit', data: second });
    publishCanvasUpdate(channel, { type: 'commit', data: commit(4) });
    body = await stream.until('event: recovery-required');
    expect(body.match(/event: commit/g)).toHaveLength(2);
    expect(body).toContain('stream-gap');
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
  });

  it('retains the first replay watermark on later pages', async () => {
    mocks.operations.readCommits
      .mockResolvedValueOnce({
        status: 'commits',
        spaceEpoch: epoch,
        fromVersion: 0,
        throughVersion: 2,
        commits: [commit()],
        nextAfterVersion: 1,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        status: 'commits',
        spaceEpoch: epoch,
        fromVersion: 1,
        throughVersion: 2,
        commits: [commit(1)],
        nextAfterVersion: 2,
        hasMore: false,
      });
    const stream = await open();
    await stream.until('event: ready');
    expect(mocks.operations.readCommits.mock.calls[1]?.[0]).toMatchObject({
      afterVersion: 1,
      throughVersion: 2,
    });
  });

  it.each(['floor', 'overflow', 'failure'] as const)(
    'ends with explicit recovery on %s',
    async (scenario) => {
      mocks.operations.readCommits.mockImplementation(async () => {
        if (scenario === 'failure') throw new Error('Storage unavailable');
        if (scenario === 'overflow')
          for (let index = 0; index < 201; index++)
            publishCanvasUpdate(operationChannel('workspace:test', 'space'), {
              type: 'commit',
              data: commit(index),
            });
        return {
          status: 'snapshot-required',
          spaceEpoch: epoch,
          earliestReplayVersion: 10,
          latestVersion: 11,
        };
      });
      const stream = await open();
      const body = await stream.until('event: recovery-required');
      expect(body).toContain(
        scenario === 'floor'
          ? 'snapshot-required'
          : scenario === 'overflow'
            ? 'buffer-overflow'
            : 'storage-unavailable',
      );
      expect(body).not.toContain('event: ready');
      await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledOnce());
    },
  );
});
