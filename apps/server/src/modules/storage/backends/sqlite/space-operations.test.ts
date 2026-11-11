// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CANVAS_NODE_TYPES,
  canvasOperationRequestSchema,
  canvasSiblingOrderEventSchema,
} from '@huabu/shared';
import {
  nodeRevisionOf,
  extractCanvasChanges,
} from '@huabu/shared/canvas-engine';

import { SqliteStoreContext } from './database.js';
import { createSqliteSpaceOperations } from './space-operations.js';
import { openEmptySqliteTestStore } from './test-support.js';
import { prepareOperationCandidate } from '../../../canvas/operations/candidate.js';
import { submitContentOperationAlreadyLocked } from '../../../canvas/operations/content.js';
import { submitOperationAlreadyLocked } from '../../../canvas/operations/service.js';
import { attachFieldReview } from '../../ports/operation-review.js';
import { operationDigest } from '../../ports/operation-rules.js';

import type { EmptySqliteTestStore } from './test-support.js';
import type {
  SpaceOperationSnapshot,
  SpaceOperationWrite,
} from '../../ports/operations.js';
import type {
  CanvasNodeType,
  CanvasOperationRequest,
  CanvasOperationSession,
  CanvasContentOperationRequest,
} from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fieldReviewFixture() {
  const f = await fixture();
  const source = move(f.snapshot, f.lease);
  const plan = attachFieldReview(
    f.snapshot,
    prepareOperationCandidate(
      f.snapshot,
      source,
      'owner',
      { kind: 'agent' },
      1000,
    ),
    'thread-a',
  );
  if (plan.receipt.status !== 'committed' || !plan.receipt.commit.reviewRecord)
    throw new Error('Missing reviewed source');
  return { ...f, source, plan };
}

describe('recoverable field Review', () => {
  it('refuses overlapping review sources before writing', async () => {
    const f = await fieldReviewFixture();
    await f.operations.commit(f.plan);
    const before = await f.operations.readSnapshot();
    if (!before) throw new Error('Missing snapshot');
    const next = move(before, f.lease);
    next.commands = [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'node-a', position: { x: 30, y: 40 } }],
      },
    ];
    expect(() =>
      attachFieldReview(
        before,
        prepareOperationCandidate(
          before,
          next,
          'owner',
          { kind: 'agent' },
          1001,
        ),
        'thread-a',
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-commit' }));
    expect(await f.operations.readSnapshot()).toEqual(before);
  });

  it.each(['review', 'receipt', 'committed-before-reply'])(
    'recovers the original Review source association at %s',
    async (stage) => {
      const f = await fieldReviewFixture();
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./space-operations.crash-fixture.ts', import.meta.url),
          ),
          f.filename,
          f.workspaceId,
          f.canvasId,
          JSON.stringify(f.plan),
          stage,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(child.signal, child.stderr).toBe('SIGKILL');
      const operations = await reopen(f, f.canvasId, true);
      const committed = stage === 'committed-before-reply';
      expect((await operations.readSnapshot())?.record.version).toBe(
        committed ? 1 : 0,
      );
      expect(await operations.lookup(f.plan.key)).toEqual(
        committed
          ? { status: 'terminal', receipt: f.plan.receipt }
          : { status: 'absent' },
      );
      expect(await operations.commit(f.plan)).toEqual(f.plan.receipt);
      expect((await operations.readSnapshot())?.reviews['thread-a']).toEqual(
        f.plan.review[0]?.records,
      );
    },
  );

  it('rejects forged record bindings', async () => {
    const f = await fieldReviewFixture();
    const forgedSource = structuredClone(f.plan);
    if (
      forgedSource.receipt.status !== 'committed' ||
      !forgedSource.receipt.commit.reviewRecord
    )
      throw new Error('Missing source');
    forgedSource.receipt.commit.reviewRecord.recordsDigest = '0'.repeat(64);
    await expect(f.operations.commit(forgedSource)).rejects.toMatchObject({
      code: 'invalid-commit',
    });
    expect((await f.operations.readSnapshot())?.record.version).toBe(0);
  });
});

async function fixture(nodeType: CanvasNodeType = 'note') {
  let now = 1000;
  const harness = await openEmptySqliteTestStore('huabu-operation-', () => now);
  cleanup.push(harness.cleanup);
  const canvasId = 'operations-test';
  const created = await harness.store
    .spaces()
    .create({ canvasId, title: 'Operations' });
  if (!created.ok) throw new Error('Fixture creation failed');
  const spaceEpoch = randomUUID();
  const record = {
    ...created.record,
    state: {
      nodes: ['node-a', 'node-b'].map(
        (id): CanvasNode => ({
          id,
          type: id === 'node-a' ? nodeType : 'note',
          position: { x: 0, y: 0 },
          data: {
            style: { accent: 'white', fontSize: 16 },
            ...(id === 'node-a' && nodeType === 'question'
              ? { bindingState: 'bound', threadId: 'thread-test' }
              : {}),
            ...(id === 'node-a' && nodeType === 'image'
              ? { src: 'artifacts/existing-image.png' }
              : {}),
          },
        }),
      ),
      edges: [],
    },
  };
  const body = {
    nodeId: 'node-a',
    type: nodeType,
    label: 'A',
    content: 'Original body',
    ...(nodeType === 'video' ? { src: 'movie.mp4' } : {}),
  };
  await harness.store
    .space(canvasId)
    .nodes.put({ nodeId: 'node-a', record: body });
  harness.context
    .database()
    .prepare('UPDATE spaces SET state_json = ? WHERE canvas_id = ?')
    .run(JSON.stringify(record.state), canvasId);
  const metadata: SpaceOperationSnapshot['metadata'] = {
    modelVersion: 1,
    spaceEpoch,
    earliestReplayVersion: 0,
    reviewRevision: 0,
    siblingOrderVersions: [
      { parentId: null, version: 0 },
      ...(nodeType === 'frame' ? [{ parentId: 'node-a', version: 0 }] : []),
    ],
    nodes: Object.fromEntries(
      record.state.nodes.map(({ id }) => [
        id,
        {
          incarnation: randomUUID(),
          membershipVersion: 0,
          coordinateContext: `root:${spaceEpoch}`,
          fieldVersions: { position: 0, 'style.accent': 0 },
        },
      ]),
    ),
  };
  harness.context
    .database()
    .prepare(
      'INSERT INTO operation_heads (workspace_id, canvas_id, metadata_json) VALUES (?, ?, ?)',
    )
    .run(harness.workspaceId, canvasId, JSON.stringify(metadata));
  harness.context.database().exec('PRAGMA synchronous=FULL');
  const operations = createSqliteSpaceOperations(
    harness.context,
    harness.workspaceId,
    canvasId,
  );
  const lease = await operations.createSession('owner');
  return {
    ...harness,
    canvasId,
    operations,
    lease,
    snapshot: { record, metadata, sidecars: { 'node-a': body }, reviews: {} },
    advanceTime: () => {
      now += 8 * 86400000;
    },
  };
}

describe('recoverable root node lifecycles', () => {
  it('removes an empty Frame order group and rejects stale body deletion without consuming another node', async () => {
    const f = await fixture('frame');
    const meta = f.snapshot.metadata.nodes['node-a']!;
    const request = canvasOperationRequestSchema.parse({
      ...move(f.snapshot, f.lease),
      commands: [{ type: 'DELETE_NODES', nodeIds: ['node-a'] }],
      preconditions: [
        {
          kind: 'delete',
          commandIndex: 0,
          nodeId: 'node-a',
          ...meta,
          expectRev: 'outdated-body-revision',
        },
      ],
    });
    const rejected = await submitOperationAlreadyLocked(
      f.operations,
      request,
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(rejected.results[0]?.reason).toBe('stale-delete');
    const accepted = await submitOperationAlreadyLocked(
      f.operations,
      {
        ...request,
        operationId: randomUUID(),
        preconditions: [
          {
            ...request.preconditions[0],
            expectRev: nodeRevisionOf(f.snapshot.sidecars['node-a']!),
          },
        ],
      },
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(accepted.status).toBe('committed');
    const after = await f.operations.readSnapshot();
    expect(after?.metadata.siblingOrderVersions).toEqual([
      { parentId: null, version: 1 },
    ]);
    expect(after?.record.state.nodes).toEqual([
      f.snapshot.record.state.nodes[1],
    ]);
    expect(
      await submitOperationAlreadyLocked(
        f.operations,
        request,
        'owner',
        { kind: 'ui' },
        1000,
      ),
    ).toEqual(rejected);
  });

  it('refuses dependent owners, incident edges, children and stale deletion guards without partial mutations', async () => {
    const f = await fixture();
    const create = { ...move(f.snapshot, f.lease), preconditions: [] };
    for (const nodeType of ['question', 'image', 'pdf', 'web']) {
      const request = canvasOperationRequestSchema.parse({
        ...create,
        operationId: randomUUID(),
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [{ nodeType, position: { x: 0, y: 0 } }],
          },
        ],
      });
      expect(
        (
          await submitOperationAlreadyLocked(
            f.operations,
            request,
            'owner',
            { kind: 'ui' },
            1000,
          )
        ).results[0]?.reason,
      ).toBe('unsupported-command');
    }
    const meta = f.snapshot.metadata.nodes['node-a']!;
    const deletion = canvasOperationRequestSchema.parse({
      ...move(f.snapshot, f.lease),
      commands: [{ type: 'DELETE_NODES', nodeIds: ['node-a'] }],
      preconditions: [
        {
          kind: 'delete',
          commandIndex: 0,
          nodeId: 'node-a',
          ...meta,
          expectRev: nodeRevisionOf(f.snapshot.sidecars['node-a']!),
        },
      ],
    });
    for (const snapshot of [
      {
        ...f.snapshot,
        record: {
          ...f.snapshot.record,
          state: {
            ...f.snapshot.record.state,
            edges: [{ id: 'edge-a-b', source: 'node-a', target: 'node-b' }],
          },
        },
      },
      {
        ...f.snapshot,
        record: {
          ...f.snapshot.record,
          state: {
            ...f.snapshot.record.state,
            nodes: f.snapshot.record.state.nodes.map((node) =>
              node.id === 'node-a'
                ? { ...node, type: 'frame' }
                : { ...node, parentId: 'node-a' },
            ),
          },
        },
      },
    ]) {
      expect(
        prepareOperationCandidate(
          snapshot,
          deletion,
          'owner',
          { kind: 'ui' },
          1000,
        ).receipt.results[0]?.reason,
      ).toBe('unsupported-command');
    }
    await submitOperationAlreadyLocked(
      f.operations,
      move(f.snapshot, f.lease),
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(
      (
        await submitOperationAlreadyLocked(
          f.operations,
          deletion,
          'owner',
          { kind: 'ui' },
          1000,
        )
      ).results[0]?.reason,
    ).toBe('stale-delete');
    expect(
      (await f.operations.readSnapshot())?.sidecars['node-a']?.content,
    ).toBe('Original body');
  });

  it.each(['create', 'delete'] as const)(
    'rejects forged %s sidecar/order/lifetime plans before persistence',
    async (kind) => {
      const f = await fixture();
      const request = canvasOperationRequestSchema.parse({
        ...move(f.snapshot, f.lease),
        commands:
          kind === 'create'
            ? [
                {
                  type: 'CREATE_NODES',
                  nodes: [{ nodeType: 'text', position: { x: 0, y: 0 } }],
                },
              ]
            : [{ type: 'DELETE_NODES', nodeIds: ['node-a'] }],
        preconditions:
          kind === 'create'
            ? []
            : [
                {
                  kind: 'delete',
                  commandIndex: 0,
                  nodeId: 'node-a',
                  ...f.snapshot.metadata.nodes['node-a'],
                  expectRev: nodeRevisionOf(f.snapshot.sidecars['node-a']!),
                },
              ],
      });
      const prepared = prepareOperationCandidate(
        f.snapshot,
        request,
        'owner',
        { kind: 'ui' },
        1000,
      );
      for (const mutate of [
        (plan: SpaceOperationWrite): SpaceOperationWrite => ({
          ...plan,
          structure: plan.structure
            ? { ...plan.structure, nodeMutations: [] }
            : undefined,
        }),
        (plan: SpaceOperationWrite): SpaceOperationWrite => {
          if (plan.receipt.status === 'committed')
            plan.receipt.commit.events = plan.receipt.commit.events.filter(
              ({ type }) => type !== 'SET_SIBLING_ORDER',
            );
          return plan;
        },
        (plan: SpaceOperationWrite): SpaceOperationWrite => ({
          ...plan,
          metadata: f.snapshot.metadata,
        }),
      ]) {
        const bad = mutate(structuredClone(prepared));
        await expect(f.operations.commit(bad)).rejects.toMatchObject({
          code: 'invalid-commit',
        });
      }
      expect((await f.operations.readSnapshot())?.record.version).toBe(0);
      expect(await f.operations.lookup(prepared.key, prepared.digest)).toEqual({
        status: 'absent',
      });
    },
  );

  it.each(['create', 'delete'] as const)(
    'recovers %s state and its original receipt at every SQL persistence boundary',
    async (kind) => {
      for (const stage of [
        kind === 'create' ? 'sidecar-insert' : 'sidecar-delete',
        'state',
        'journal',
        'receipt',
        'committed-before-reply',
      ]) {
        const f = await fixture();
        const request = canvasOperationRequestSchema.parse({
          ...move(f.snapshot, f.lease),
          commands:
            kind === 'create'
              ? [
                  {
                    type: 'CREATE_NODES',
                    nodes: [
                      {
                        nodeType: 'note',
                        data: { label: 'New', content: 'New body' },
                        position: { x: 0, y: 0 },
                      },
                    ],
                  },
                ]
              : [{ type: 'DELETE_NODES', nodeIds: ['node-a'] }],
          preconditions:
            kind === 'create'
              ? []
              : [
                  {
                    kind: 'delete',
                    commandIndex: 0,
                    nodeId: 'node-a',
                    ...f.snapshot.metadata.nodes['node-a'],
                    expectRev: nodeRevisionOf(f.snapshot.sidecars['node-a']!),
                  },
                ],
        });
        const plan = prepareOperationCandidate(
          f.snapshot,
          request,
          'owner',
          { kind: 'ui' },
          1000,
        );
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('./space-operations.crash-fixture.ts', import.meta.url),
            ),
            f.filename,
            f.workspaceId,
            f.canvasId,
            JSON.stringify(plan),
            stage,
          ],
          { encoding: 'utf8', timeout: 20000 },
        );
        expect(child.signal, child.stderr).toBe('SIGKILL');
        const recovered = await f.operations.readSnapshot();
        const committed = stage === 'committed-before-reply';
        expect(recovered?.record.version, stage).toBe(committed ? 1 : 0);
        expect(await f.operations.lookup(plan.key, plan.digest)).toEqual(
          committed
            ? { status: 'terminal', receipt: plan.receipt }
            : { status: 'absent' },
        );
        const nodeId = plan.receipt.results[0]?.nodeIds?.[0];
        if (!nodeId) throw new Error('Missing lifecycle result');
        expect(Boolean(recovered?.sidecars[nodeId])).toBe(
          kind === 'create' ? committed : !committed,
        );
        expect(await f.operations.commit(plan)).toEqual(plan.receipt);
        expect((await f.operations.readSnapshot())?.record.version).toBe(1);
      }
    },
    60000,
  );

  it('persists generated IDs, initial bodies and complete order, then returns the original receipt after loss of the reply', async () => {
    const f = await fixture();
    const request = canvasOperationRequestSchema.parse({
      ...move(f.snapshot, f.lease),
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: ['note', 'text', 'frame'].map((nodeType) => ({
            nodeType,
            position: { x: 25, y: 30 },
            data: {
              label: 'a',
              ...(nodeType === 'frame' ? {} : { content: 'Initial body' }),
            },
          })),
        },
      ],
      preconditions: [],
    });
    const result = await submitOperationAlreadyLocked(
      f.operations,
      request,
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(result.status).toBe('committed');
    const snapshot = await f.operations.readSnapshot();
    expect(snapshot?.record.version).toBe(1);
    const ids = result.results[0]?.nodeIds;
    expect(ids).toHaveLength(3);
    for (const id of ids ?? []) {
      expect(snapshot?.sidecars[id]?.nodeId).toBe(id);
      expect(snapshot?.metadata.nodes[id]?.membershipVersion).toBe(1);
    }
    expect(
      new Set(
        Object.values(snapshot?.sidecars ?? {}).map(({ label }) =>
          label?.toLowerCase(),
        ),
      ).size,
    ).toBe(4);
    expect(
      await submitOperationAlreadyLocked(
        f.operations,
        request,
        'owner',
        { kind: 'ui' },
        1000,
      ),
    ).toEqual(result);
    expect((await f.operations.readSnapshot())?.record.version).toBe(1);
    expect(
      result.status === 'committed' &&
        result.commit.events.some(
          (event) =>
            event.type === 'SET_SIBLING_ORDER' && event.after.length === 5,
        ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Initial body');
  });

  it('retires deleted lifetimes, blocks ID reuse and rejects late structural/body writes', async () => {
    const f = await fixture();
    const original = f.snapshot.metadata.nodes['node-a']!;
    const deletion = canvasOperationRequestSchema.parse({
      ...move(f.snapshot, f.lease),
      commands: [{ type: 'DELETE_NODES', nodeIds: ['node-a'] }],
      preconditions: [
        {
          kind: 'delete',
          commandIndex: 0,
          nodeId: 'node-a',
          ...original,
          expectRev: nodeRevisionOf(f.snapshot.sidecars['node-a']!),
        },
      ],
    });
    const result = await submitOperationAlreadyLocked(
      f.operations,
      deletion,
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(result.status).toBe('committed');
    const deleted = await f.operations.readSnapshot();
    expect(deleted?.sidecars['node-a']).toBeUndefined();
    expect(deleted?.metadata.nodes['node-a']).toBeUndefined();
    const retired = deleted?.metadata.retiredNodes?.['node-a'];
    expect(retired).toEqual({
      incarnation: original.incarnation,
      deletedVersion: 1,
    });
    expect(
      await submitOperationAlreadyLocked(
        f.operations,
        deletion,
        'owner',
        { kind: 'ui' },
        1000,
      ),
    ).toEqual(result);
    const creation = canvasOperationRequestSchema.parse({
      ...move(f.snapshot, f.lease),
      observedVersion: 1,
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-a',
              nodeType: 'note',
              position: { x: 0, y: 0 },
              data: { content: 'Restored body' },
            },
          ],
        },
      ],
      preconditions: [],
    });
    expect(
      (
        await submitOperationAlreadyLocked(
          f.operations,
          creation,
          'owner',
          { kind: 'ui' },
          1000,
        )
      ).results[0]?.reason,
    ).toBe('id-conflict');
    expect(
      (
        await submitOperationAlreadyLocked(
          f.operations,
          move(f.snapshot, f.lease),
          'owner',
          { kind: 'ui' },
          1000,
        )
      ).results[0]?.reason,
    ).toBe('stale-target');
    const staleBody = await submitContentOperationAlreadyLocked(
      f.operations,
      'node-a',
      {
        protocolVersion: 1,
        spaceEpoch: f.lease.spaceEpoch,
        sessionId: f.lease.sessionId,
        operationId: randomUUID(),
        observedVersion: 0,
        incarnation: original.incarnation,
        update: {
          nodeType: 'note',
          content: 'Late old body',
          expectRev: nodeRevisionOf(f.snapshot.sidecars['node-a']!),
        },
      },
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(staleBody.results[0]?.reason).toBe('stale-target');
  });
});

function move(
  snapshot: SpaceOperationSnapshot,
  lease: CanvasOperationSession,
  nodeId = 'node-a',
  x = 10,
): CanvasOperationRequest {
  const meta = snapshot.metadata.nodes[nodeId]!;
  return {
    protocolVersion: 1,
    spaceEpoch: lease.spaceEpoch,
    sessionId: lease.sessionId,
    operationId: randomUUID(),
    observedVersion: snapshot.record.version,
    mode: 'atomic',
    commands: [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId, position: { x, y: 20 } }],
      },
    ],
    preconditions: [
      {
        kind: 'coordinates',
        commandIndex: 0,
        nodeId,
        incarnation: meta.incarnation,
        parentId: null,
        membershipVersion: meta.membershipVersion,
        coordinateContext: meta.coordinateContext,
      },
    ],
  };
}

function candidate(
  snapshot: SpaceOperationSnapshot,
  request: CanvasOperationRequest,
) {
  return prepareOperationCandidate(
    snapshot,
    request,
    'owner',
    { kind: 'ui' },
    2000,
  );
}

function contentRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  content = 'Accepted body',
): CanvasContentOperationRequest {
  const body = f.snapshot.sidecars['node-a'];
  const meta = f.snapshot.metadata.nodes['node-a'];
  if (!meta) throw new Error('Missing content fixture lifetime');
  return {
    protocolVersion: 1,
    spaceEpoch: f.lease.spaceEpoch,
    sessionId: f.lease.sessionId,
    operationId: randomUUID(),
    observedVersion: 0,
    incarnation: meta.incarnation,
    update: { nodeType: body.type, content, expectRev: nodeRevisionOf(body) },
  };
}

describe('recoverable content-owner admission', () => {
  it('rejects forged content receipts before persistence', async () => {
    const f = await fixture();
    const request = contentRequest(f);
    await expect(
      submitContentOperationAlreadyLocked(
        {
          ...f.operations,
          async commit(plan) {
            for (const result of plan.receipt.results)
              result.contentRevision = 'not-the-saved-revision';
            return f.operations.commit(plan);
          },
        },
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).rejects.toMatchObject({ code: 'invalid-commit' });
    expect((await f.operations.readSnapshot())?.record.version).toBe(0);
    expect((await f.operations.readSnapshot())?.sidecars).toEqual(
      f.snapshot.sidecars,
    );
  });

  it.each(['note', 'text', 'question'] as const)(
    'commits %s content and its receipt/event together without changing structure or metadata',
    async (type) => {
      const f = await fixture(type);
      const request = contentRequest(f);
      const receipt = await submitContentOperationAlreadyLocked(
        f.operations,
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        2000,
      );
      expect(receipt.status).toBe('committed');
      if (receipt.status !== 'committed') throw new Error('Expected commit');
      const snapshot = await f.operations.readSnapshot();
      expect(snapshot?.record.state).toEqual(f.snapshot.record.state);
      expect(snapshot?.metadata).toEqual(f.snapshot.metadata);
      expect(snapshot?.sidecars['node-a']).toEqual({
        ...f.snapshot.sidecars['node-a'],
        content: 'Accepted body',
      });
      expect(receipt.commit.events).toEqual([
        {
          type: 'NODE_CONTENT_REVISION',
          nodeId: 'node-a',
          incarnation: request.incarnation,
          beforeRevision: request.update.expectRev,
          afterRevision: nodeRevisionOf({ content: 'Accepted body' }),
        },
      ]);
      expect(JSON.stringify(receipt)).not.toContain('Accepted body');
      expect(JSON.stringify(receipt)).not.toContain('Original body');
      expect(
        await submitContentOperationAlreadyLocked(
          f.operations,
          'node-a',
          request,
          'owner',
          { kind: 'ui' },
          3000,
        ),
      ).toEqual(receipt);
      expect((await f.operations.readSnapshot())?.record.version).toBe(1);
      expect(
        await f.operations.readCommits({
          spaceEpoch: request.spaceEpoch,
          afterVersion: 0,
          limit: 200,
          maxBytes: 4194304,
        }),
      ).toMatchObject({ commits: [receipt.commit] });
      await expect(
        submitContentOperationAlreadyLocked(
          f.operations,
          'node-b',
          request,
          'owner',
          { kind: 'ui' },
          3000,
        ),
      ).rejects.toMatchObject({ code: 'operation-id-reused' });
    },
  );

  it.each(['note', 'text', 'question'] as const)(
    'preserves the existing %s empty-body policy with a durable outcome',
    async (type) => {
      const f = await fixture(type);
      const request = contentRequest(f, '');
      const receipt = await submitContentOperationAlreadyLocked(
        f.operations,
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        2000,
      );
      expect(receipt.status).toBe(type === 'question' ? 'committed' : 'noop');
      expect(
        (await f.operations.readSnapshot())?.sidecars['node-a']?.content,
      ).toBe(type === 'question' ? '' : 'Original body');
      expect(
        await submitContentOperationAlreadyLocked(
          f.operations,
          'node-a',
          request,
          'owner',
          { kind: 'ui' },
          3000,
        ),
      ).toEqual(receipt);
    },
  );

  it('persists content conflict and rejects stale lifetimes and non-authored bodies', async () => {
    const f = await fixture();
    const request = contentRequest(f);
    request.update.expectRev = 'stale-revision';
    const rejected = await submitContentOperationAlreadyLocked(
      f.operations,
      'node-a',
      request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(rejected).toMatchObject({
      status: 'rejected',
      results: [
        {
          reason: 'content-conflict',
          contentRevision: nodeRevisionOf(f.snapshot.sidecars['node-a']),
        },
      ],
    });
    await submitContentOperationAlreadyLocked(
      f.operations,
      'node-a',
      contentRequest(f),
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(
      await submitContentOperationAlreadyLocked(
        f.operations,
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).toEqual(rejected);
    request.operationId = randomUUID();
    request.incarnation = 'deleted-life';
    expect(
      await submitContentOperationAlreadyLocked(
        f.operations,
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).toMatchObject({
      status: 'rejected',
      results: [{ reason: 'stale-target' }],
    });
    const image = await fixture('image');
    expect(
      await submitContentOperationAlreadyLocked(
        image.operations,
        'node-a',
        contentRequest(image),
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).toMatchObject({
      status: 'rejected',
      results: [{ reason: 'unsupported-command' }],
    });
  });

  it('resolves an unknown committed body write through the original receipt', async () => {
    const f = await fixture();
    const request = contentRequest(f);
    const failure = new Error('Lost commit acknowledgement');
    const uncertain = {
      ...f.operations,
      async commit(plan: SpaceOperationWrite) {
        await f.operations.commit(plan);
        throw failure;
      },
    };
    await expect(
      submitContentOperationAlreadyLocked(
        uncertain,
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).rejects.toBe(failure);
    expect(
      await submitContentOperationAlreadyLocked(
        uncertain,
        'node-a',
        request,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).toMatchObject({ status: 'committed', commitVersion: 1 });
    expect((await f.operations.readSnapshot())?.record.version).toBe(1);
  });
});

describe('operation storage and candidate admission', () => {
  it.each(CANVAS_NODE_TYPES)(
    'uses the same guarded move/accent/order commit and retry path for %s',
    async (nodeType) => {
      const f = await fixture(nodeType);
      const request = move(f.snapshot, f.lease);
      request.commands.push(
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'node-a', patch: { style: { accent: 'teal' } } }],
        },
        { type: 'REORDER_NODES', nodeIds: ['node-a'], to: { after: 'node-b' } },
      );
      request.preconditions.push(
        {
          kind: 'node',
          commandIndex: 1,
          nodeId: 'node-a',
          incarnation: f.snapshot.metadata.nodes['node-a']!.incarnation,
        },
        ...['node-a', 'node-b'].map((nodeId) => ({
          kind: 'membership' as const,
          commandIndex: 2,
          nodeId,
          incarnation: f.snapshot.metadata.nodes[nodeId]!.incarnation,
          parentId: null,
          membershipVersion: 0,
        })),
      );
      const receipt = await submitOperationAlreadyLocked(
        f.operations,
        request,
        'owner',
        { kind: 'ui' },
        2000,
      );
      expect(receipt.status).toBe('committed');
      if (receipt.status !== 'committed') throw new Error('Expected commit');
      expect(receipt.commit.events).toEqual([
        {
          type: 'PATCH_NODE',
          nodeId: 'node-a',
          incarnation: f.snapshot.metadata.nodes['node-a']!.incarnation,
          context: {
            parentId: null,
            membershipVersion: 0,
            coordinateContext:
              f.snapshot.metadata.nodes['node-a']!.coordinateContext,
          },
          changes: [
            {
              field: 'position',
              before: { present: true, value: { x: 0, y: 0 } },
              after: { present: true, value: { x: 10, y: 20 } },
            },
            {
              field: 'style.accent',
              before: { present: true, value: 'white' },
              after: { present: true, value: 'teal' },
            },
          ],
        },
        {
          type: 'SET_SIBLING_ORDER',
          parentId: null,
          before: ['node-a', 'node-b'],
          after: ['node-b', 'node-a'],
          orderVersion: 1,
        },
      ]);
      const stored = await f.operations.readSnapshot();
      expect(stored?.record.state.nodes[1]).toMatchObject({
        id: 'node-a',
        type: nodeType,
        position: { x: 10, y: 20 },
        data: { style: { accent: 'teal', fontSize: 16 } },
      });
      expect(stored?.record.state.nodes[1]).toEqual({
        ...f.snapshot.record.state.nodes[0],
        position: { x: 10, y: 20 },
        data: {
          ...f.snapshot.record.state.nodes[0]?.data,
          style: { accent: 'teal', fontSize: 16 },
        },
      });
      expect(stored?.sidecars).toEqual(f.snapshot.sidecars);
      expect(
        await submitOperationAlreadyLocked(
          f.operations,
          request,
          'owner',
          { kind: 'ui' },
          3000,
        ),
      ).toEqual(receipt);
      expect(
        await f.operations.readCommits({
          spaceEpoch: request.spaceEpoch,
          afterVersion: 0,
          limit: 200,
          maxBytes: 4194304,
        }),
      ).toMatchObject({ status: 'commits', commits: [receipt.commit] });
      expect((await f.operations.readSnapshot())?.record.version).toBe(1);
    },
  );

  it.each(['locked', 'stale-target', 'unsupported-command'] as const)(
    'retains %s admission for non-Note nodes',
    async (reason) => {
      const f = await fixture('image');
      const request = move(f.snapshot, f.lease);
      if (reason === 'locked') {
        f.snapshot.record.state.nodes[0]!.data = {
          ...f.snapshot.record.state.nodes[0]!.data,
          locked: true,
        };
      } else if (reason === 'stale-target') {
        request.preconditions[0]!.incarnation = 'old-life';
      } else {
        request.commands = [
          {
            type: 'MERGE_NODE_DATA',
            patches: [{ nodeId: 'node-a', patch: { src: 'must-not-replace' } }],
          },
        ];
      }
      const plan = candidate(f.snapshot, request);
      expect(plan.receipt).toMatchObject({
        status: 'rejected',
        results: [{ applied: false, reason }],
      });
      expect(plan.structure).toBeUndefined();
    },
  );

  it.each(['structured', 'descendants', 'nested'] as const)(
    'does not admit unimplemented %s coordinate effects',
    async (context) => {
      const f = await fixture('frame');
      const nodes = f.snapshot.record.state.nodes;
      if (context === 'structured') {
        nodes[0]!.data = { ...nodes[0]!.data, layoutMode: 'column' };
      } else {
        f.snapshot.record.state.nodes = nodes.map((node) =>
          node.id === 'node-b' ? { ...node, parentId: 'node-a' } : node,
        );
      }
      const request = move(
        f.snapshot,
        f.lease,
        context === 'nested' ? 'node-b' : 'node-a',
      );
      if (
        context === 'nested' &&
        request.preconditions[0]?.kind === 'coordinates'
      )
        request.preconditions[0].parentId = 'node-a';
      expect(candidate(f.snapshot, request).receipt).toMatchObject({
        status: 'rejected',
        results: [{ applied: false, reason: 'unsupported-command' }],
      });
    },
  );

  it('persists B sibling-order events and resolves reorder retries without another commit', async () => {
    const f = await fixture();
    const request = move(f.snapshot, f.lease);
    request.commands = [
      { type: 'REORDER_NODES', nodeIds: ['node-a'], to: { after: 'node-b' } },
    ];
    request.preconditions = ['node-a', 'node-b'].map((nodeId) => ({
      kind: 'membership',
      commandIndex: 0,
      nodeId,
      incarnation: f.snapshot.metadata.nodes[nodeId]!.incarnation,
      parentId: null,
      membershipVersion: 0,
    }));
    const receipt = await submitOperationAlreadyLocked(
      f.operations,
      request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(receipt.status).toBe('committed');
    if (receipt.status !== 'committed')
      throw new Error('Expected order commit');
    expect(receipt.commit.events).toEqual([
      {
        type: 'SET_SIBLING_ORDER',
        parentId: null,
        before: ['node-a', 'node-b'],
        after: ['node-b', 'node-a'],
        orderVersion: 1,
      },
    ]);
    const next = await f.operations.readSnapshot();
    expect(
      next?.record.state.nodes.map((node) => (node as { id: string }).id),
    ).toEqual(['node-b', 'node-a']);
    expect(next?.metadata.siblingOrderVersions).toEqual([
      { parentId: null, version: 1 },
    ]);
    expect(
      await submitOperationAlreadyLocked(
        f.operations,
        request,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).toEqual(receipt);
    expect((await f.operations.readSnapshot())?.record.version).toBe(1);
    request.operationId = randomUUID();
    expect(
      (
        await submitOperationAlreadyLocked(
          f.operations,
          request,
          'owner',
          { kind: 'ui' },
          4000,
        )
      ).status,
    ).toBe('noop');
  });

  it('rejects reorder anchor ABA and rolls back an atomic move with that reorder', async () => {
    const f = await fixture();
    const request = move(f.snapshot, f.lease);
    request.commands.push({
      type: 'REORDER_NODES',
      nodeIds: ['node-a'],
      to: { after: 'node-b' },
    });
    request.preconditions.push(
      ...['node-a', 'node-b'].map((nodeId) => ({
        kind: 'membership' as const,
        commandIndex: 1,
        nodeId,
        incarnation: f.snapshot.metadata.nodes[nodeId]!.incarnation,
        parentId: null,
        membershipVersion: nodeId === 'node-b' ? 99 : 0,
      })),
    );
    const receipt = await submitOperationAlreadyLocked(
      f.operations,
      request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(receipt).toMatchObject({
      status: 'rejected',
      results: [
        { reason: 'atomic-rejected' },
        { reason: 'stale-parent', nodeId: 'node-b' },
      ],
    });
    expect((await f.operations.readSnapshot())?.record).toEqual(
      f.snapshot.record,
    );
  });

  it('resolves a lost acknowledgement before re-executing or checking changed guards', async () => {
    const f = await fixture();
    const request = move(f.snapshot, f.lease);
    const receipt = await submitOperationAlreadyLocked(
      f.operations,
      request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    const later = (await f.operations.readSnapshot())!;
    later.metadata.nodes['node-a']!.incarnation = randomUUID();
    f.context
      .database()
      .prepare(
        'UPDATE operation_heads SET metadata_json = ? WHERE canvas_id = ?',
      )
      .run(JSON.stringify(later.metadata), f.canvasId);
    expect(
      await submitOperationAlreadyLocked(
        f.operations,
        request,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).toEqual(receipt);
    const changed = { ...request, observedVersion: 1 };
    await expect(
      submitOperationAlreadyLocked(
        f.operations,
        changed,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).rejects.toMatchObject({ code: 'operation-id-reused' });
  });

  it('keeps receipts after history trimming and Space removal', async () => {
    const f = await fixture();
    const request = move(f.snapshot, f.lease);
    const plan = candidate(f.snapshot, request);
    await f.operations.commit(plan);
    const state = (await f.operations.readSnapshot())!;
    state.metadata.earliestReplayVersion = 1;
    f.context
      .database()
      .prepare(
        'UPDATE operation_heads SET metadata_json = ? WHERE canvas_id = ?',
      )
      .run(JSON.stringify(state.metadata), f.canvasId);
    f.context
      .database()
      .prepare('DELETE FROM operation_commits WHERE canvas_id = ?')
      .run(f.canvasId);
    expect(
      await f.operations.readCommits({
        spaceEpoch: plan.key.spaceEpoch,
        afterVersion: 0,
        limit: 200,
        maxBytes: 4194304,
      }),
    ).toMatchObject({ status: 'snapshot-required', earliestReplayVersion: 1 });
    f.context
      .database()
      .prepare('DELETE FROM spaces WHERE canvas_id = ?')
      .run(f.canvasId);
    expect(await f.operations.lookup(plan.key)).toEqual({
      status: 'terminal',
      receipt: plan.receipt,
    });
    expect(await f.operations.commit(plan)).toEqual(plan.receipt);
  });
  it('persists a stable receipt, rejects changed payloads and returns it after expiry', async () => {
    const f = await fixture();
    const request = move(f.snapshot, f.lease);
    const plan = candidate(f.snapshot, request);
    const first = await f.operations.commit(plan);
    expect(first.status).toBe('committed');
    expect(await f.operations.commit(plan)).toEqual(first);
    await expect(
      f.operations.commit({
        ...plan,
        digest: operationDigest({ different: true }),
      }),
    ).rejects.toMatchObject({ code: 'operation-id-reused' });
    f.advanceTime();
    expect(await f.operations.lookup(plan.key)).toEqual({
      status: 'terminal',
      receipt: first,
    });
    expect(await f.operations.commit(plan)).toEqual(first);
    const another = candidate((await f.operations.readSnapshot())!, {
      ...request,
      operationId: randomUUID(),
    });
    await expect(f.operations.commit(another)).rejects.toMatchObject({
      code: 'session-expired',
    });
    expect((await f.operations.readSnapshot())?.record.version).toBe(1);
  });

  it('preserves independent fields and accepts a stale observed version in the same context', async () => {
    const f = await fixture();
    const first = move(f.snapshot, f.lease);
    await f.operations.commit(candidate(f.snapshot, first));
    const current = (await f.operations.readSnapshot())!;
    const style: CanvasOperationRequest = {
      ...first,
      operationId: randomUUID(),
      observedVersion: 0,
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'node-a', patch: { style: { accent: 'blue' } } }],
        },
      ],
      preconditions: [
        {
          kind: 'node',
          commandIndex: 0,
          nodeId: 'node-a',
          incarnation: f.snapshot.metadata.nodes['node-a']!.incarnation,
        },
      ],
    };
    await f.operations.commit(candidate(current, style));
    const end = (await f.operations.readSnapshot())!;
    expect(end.record.state.nodes[0]).toMatchObject({
      position: { x: 10, y: 20 },
      data: { style: { accent: 'blue', fontSize: 16 } },
    });
    expect(end.metadata.nodes['node-a']?.fieldVersions).toEqual({
      position: 1,
      'style.accent': 2,
    });
    const page = await f.operations.readCommits({
      spaceEpoch: f.lease.spaceEpoch,
      afterVersion: 0,
      limit: 200,
      maxBytes: 4194304,
    });
    expect(page).toMatchObject({
      status: 'commits',
      nextAfterVersion: 2,
      hasMore: false,
    });
    if (page.status === 'commits')
      expect(JSON.stringify(page.commits)).not.toContain('content');
  });

  it.each(['incarnation', 'membershipVersion', 'coordinateContext'] as const)(
    'rejects stale %s without side effects and retains the rejection',
    async (field) => {
      const f = await fixture();
      const request = move(f.snapshot, f.lease);
      const guard = request.preconditions[0]!;
      if (guard.kind !== 'coordinates') throw new Error('Wrong fixture guard');
      if (field === 'membershipVersion') guard.membershipVersion++;
      else guard[field] += ':stale';
      const plan = candidate(f.snapshot, request);
      expect(plan.receipt.status).toBe('rejected');
      const receipt = await f.operations.commit(plan);
      expect(await f.operations.commit(plan)).toEqual(receipt);
      expect((await f.operations.readSnapshot())?.record).toEqual(
        f.snapshot.record,
      );
    },
  );

  it('retains no-op outcomes without incrementing the head', async () => {
    const f = await fixture();
    const request = move(f.snapshot, f.lease, 'node-a', 0);
    request.commands = [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'node-a', position: { x: 0, y: 0 } }],
      },
    ];
    const plan = candidate(f.snapshot, request);
    expect(plan.receipt.status).toBe('noop');
    await f.operations.commit(plan);
    const later = candidate(f.snapshot, move(f.snapshot, f.lease));
    await f.operations.commit(later);
    expect(await f.operations.commit(plan)).toEqual(plan.receipt);
    expect((await f.operations.readSnapshot())?.record.version).toBe(1);
  });

  it.each(['atomic', 'partial'] as const)(
    'keeps %s semantics without executing rejected effects',
    async (mode) => {
      const f = await fixture();
      const request = move(f.snapshot, f.lease);
      request.mode = mode;
      request.commands.push({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-b', patch: { content: 'must not write' } }],
      });
      const plan = candidate(f.snapshot, request);
      expect(plan.receipt.status).toBe(
        mode === 'atomic' ? 'rejected' : 'committed',
      );
      expect(plan.receipt.results[1]).toMatchObject({
        applied: false,
        reason: 'unsupported-command',
      });
      await f.operations.commit(plan);
      expect((await f.operations.readSnapshot())?.record.version).toBe(
        mode === 'atomic' ? 0 : 1,
      );
      expect(await f.store.space(f.canvasId).nodes.read('node-b')).toBeNull();
      expect(f.snapshot.record.state.nodes[0]).toMatchObject({
        position: { x: 0, y: 0 },
      });
    },
  );

  it('binds sessions to scope and refuses uninitialized and NORMAL storage', async () => {
    const f = await fixture();
    const plan = candidate(f.snapshot, move(f.snapshot, f.lease));
    await expect(
      f.operations.lookup({ ...plan.key, principalId: 'another-owner' }),
    ).rejects.toMatchObject({ code: 'session-forbidden' });
    f.context.database().exec('PRAGMA synchronous=NORMAL');
    await expect(f.operations.commit(plan)).rejects.toMatchObject({
      code: 'collaboration-disabled',
    });
    f.context.database().exec('PRAGMA synchronous=FULL');
    await expect(
      createSqliteSpaceOperations(
        f.context,
        f.workspaceId,
        'absent',
      ).createSession('owner'),
    ).rejects.toMatchObject({ code: 'collaboration-disabled' });
  });

  it('rejects state/event disagreement before any persistence', async () => {
    const f = await fixture();
    const plan = candidate(f.snapshot, move(f.snapshot, f.lease));
    if (!plan.structure) throw new Error('Missing fixture write');
    plan.structure.nextRecord.state.edges.push({ id: 'unreported-edge' });
    await expect(f.operations.commit(plan)).rejects.toMatchObject({
      code: 'invalid-commit',
    });
    expect(await f.operations.lookup(plan.key)).toEqual({ status: 'absent' });
  });

  it('rolls back a terminal-receipt write failure and permits an exact retry', async () => {
    const f = await fixture();
    const plan = candidate(f.snapshot, move(f.snapshot, f.lease));
    f.context.database()
      .exec(`CREATE TEMP TRIGGER abort_receipt BEFORE INSERT ON operation_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;`);
    await expect(f.operations.commit(plan)).rejects.toThrow(
      'receipt write failed',
    );
    expect(await f.operations.lookup(plan.key)).toEqual({ status: 'absent' });
    expect((await f.operations.readSnapshot())?.record).toEqual(
      f.snapshot.record,
    );
    f.context.database().exec('DROP TRIGGER abort_receipt');
    expect(await f.operations.commit(plan)).toEqual(plan.receipt);
  });

  it('refuses an oversized canonical commit without creating state or a receipt', async () => {
    const f = await fixture();
    const plan = candidate(f.snapshot, move(f.snapshot, f.lease));
    if (plan.receipt.status !== 'committed')
      throw new Error('Missing fixture commit');
    const event = plan.receipt.commit.events[0]!;
    plan.receipt.commit.events = Array.from({ length: 10000 }, () => event);
    expect(
      Buffer.byteLength(JSON.stringify(plan.receipt.commit)),
    ).toBeGreaterThan(1048576);
    await expect(f.operations.commit(plan)).rejects.toMatchObject({
      code: 'commit-too-large',
    });
    expect(await f.operations.lookup(plan.key)).toEqual({ status: 'absent' });
    expect((await f.operations.readSnapshot())?.record.version).toBe(0);
  });

  it('bounds pages by bytes/count, fixes the watermark, and refuses gaps and old epochs', async () => {
    const f = await fixture();
    for (let x = 1; x <= 3; x++) {
      const state = (await f.operations.readSnapshot())!;
      await f.operations.commit(
        candidate(state, move(state, f.lease, 'node-a', x)),
      );
    }
    const query = {
      spaceEpoch: f.lease.spaceEpoch,
      afterVersion: 0,
      throughVersion: 2,
      limit: 1,
      maxBytes: 4194304,
    };
    expect(await f.operations.readCommits(query)).toMatchObject({
      throughVersion: 2,
      nextAfterVersion: 1,
      hasMore: true,
    });
    expect(
      await f.operations.readCommits({ ...query, afterVersion: 1 }),
    ).toMatchObject({ nextAfterVersion: 2, hasMore: false });
    await expect(
      f.operations.readCommits({ ...query, maxBytes: 50 }),
    ).rejects.toMatchObject({ code: 'replay-page-too-small' });
    expect(
      await f.operations.readCommits({ ...query, spaceEpoch: randomUUID() }),
    ).toMatchObject({ status: 'snapshot-required' });
    f.context
      .database()
      .prepare(
        'DELETE FROM operation_commits WHERE canvas_id = ? AND version = 2',
      )
      .run(f.canvasId);
    await expect(
      f.operations.readCommits({ ...query, limit: 200 }),
    ).rejects.toMatchObject({ code: 'replay-corrupt' });
  });

  it('canonicalizes property order but preserves request semantics and rejects malformed order events', () => {
    expect(
      operationDigest({ commands: [{ x: 1, y: 2 }], mode: 'atomic' }),
    ).toBe(operationDigest({ mode: 'atomic', commands: [{ y: 2, x: 1 }] }));
    expect(operationDigest({ mode: 'atomic' })).not.toBe(
      operationDigest({ mode: 'partial' }),
    );
    expect(
      canvasSiblingOrderEventSchema.safeParse({
        type: 'SET_SIBLING_ORDER',
        parentId: null,
        before: ['a'],
        after: ['a', 'a'],
        orderVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      canvasOperationRequestSchema.safeParse({
        protocolVersion: 1,
        origin: { kind: 'system' },
      }).success,
    ).toBe(false);
  });
});

async function reopen(
  harness: EmptySqliteTestStore,
  canvasId: string,
  durable = false,
) {
  harness.context.close();
  const context = new SqliteStoreContext(harness.filename, () => 2000);
  context.init();
  context.useWorkspace(harness.workspaceId);
  if (durable) context.database().exec('PRAGMA synchronous=FULL');
  cleanup.push(() => context.close());
  return createSqliteSpaceOperations(context, harness.workspaceId, canvasId);
}

async function reviewFixture() {
  const f = await fixture();
  const records = extractCanvasChanges(
    f.snapshot.record.state.nodes.map((node) => ({
      type: 'INSERT_NODE',
      node,
    })),
  );
  f.context
    .database()
    .prepare(
      'INSERT INTO changes (canvas_id, thread_id, snapshot_json) VALUES (?, ?, ?)',
    )
    .run(f.canvasId, 'thread-a', JSON.stringify(records));
  return { ...f, records };
}

describe('Review revision integrity', () => {
  it('refuses a structural commit that advertises a Review revision without changing the list', async () => {
    const f = await reviewFixture();
    const plan = candidate(f.snapshot, move(f.snapshot, f.lease));
    if (plan.receipt.status !== 'committed')
      throw new Error('Missing fixture commit');
    plan.receipt.commit.reviewRevision = 42;
    await expect(f.operations.commit(plan)).rejects.toMatchObject({
      code: 'invalid-commit',
    });
    expect((await f.operations.readSnapshot())?.record.version).toBe(0);
    expect((await f.operations.readSnapshot())?.metadata.reviewRevision).toBe(
      0,
    );
  });
});

describe('SQLite process termination recovery (not power-loss certification)', () => {
  it.each([
    'sidecar',
    'state',
    'review',
    'journal',
    'receipt',
    'committed-before-reply',
  ])(
    'recovers state/event/receipt/Review after termination at %s',
    async (stage) => {
      const f = await fixture();
      const plan = candidate(f.snapshot, move(f.snapshot, f.lease));
      const withReview: SpaceOperationWrite = {
        ...plan,
        metadata: { ...plan.metadata, reviewRevision: 1 },
        review: [{ threadId: 'thread-a', records: [] }],
      };
      if (!plan.structure || withReview.receipt.status !== 'committed')
        throw new Error('Missing committed fixture');
      withReview.receipt.commit.reviewRevision = 1;
      const beforeBody = f.snapshot.sidecars['node-a'];
      const afterBody = { ...beforeBody, content: 'Accepted body' };
      withReview.receipt.commit.events.push({
        type: 'NODE_CONTENT_REVISION',
        nodeId: 'node-a',
        incarnation: f.snapshot.metadata.nodes['node-a']!.incarnation,
        beforeRevision: nodeRevisionOf(beforeBody),
        afterRevision: nodeRevisionOf(afterBody),
      });
      const completePlan: SpaceOperationWrite = {
        ...withReview,
        structure: {
          ...plan.structure,
          nodeMutations: [{ kind: 'put', nodeId: 'node-a', record: afterBody }],
        },
      };
      f.context.close();
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./space-operations.crash-fixture.ts', import.meta.url),
          ),
          f.filename,
          f.workspaceId,
          f.canvasId,
          JSON.stringify(completePlan),
          stage,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(child.signal, child.stderr).toBe('SIGKILL');
      const operations = await reopen(f, f.canvasId);
      const state = (await operations.readSnapshot())!;
      const committed = stage === 'committed-before-reply';
      expect(state.record.version).toBe(committed ? 1 : 0);
      expect(state.metadata.reviewRevision).toBe(committed ? 1 : 0);
      expect(state.sidecars['node-a']?.content).toBe(
        committed ? 'Accepted body' : 'Original body',
      );
      const reader = new SqliteStoreContext(f.filename, () => 2000);
      reader.init();
      cleanup.push(() => reader.close());
      expect(
        reader
          .database()
          .prepare(
            'SELECT snapshot_json FROM changes WHERE canvas_id = ? AND thread_id = ?',
          )
          .get(f.canvasId, 'thread-a'),
      ).toEqual(committed ? { snapshot_json: '[]' } : undefined);
      expect(await operations.lookup(plan.key)).toEqual(
        committed
          ? { status: 'terminal', receipt: plan.receipt }
          : { status: 'absent' },
      );
      const page = await operations.readCommits({
        spaceEpoch: plan.key.spaceEpoch,
        afterVersion: 0,
        limit: 200,
        maxBytes: 4194304,
      });
      if (page.status !== 'commits') throw new Error('Unexpected recovery');
      expect(page.commits).toHaveLength(committed ? 1 : 0);
    },
  );
});
