// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canvasCommitPageSchema,
  canvasOperationReceiptSchema,
  canvasOperationSessionSchema,
  canvasOperationSnapshotSchema,
} from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { DiskOperationRedo, readOperationFile } from './operation-redo.js';
import { createDiskOperationFixture } from './operation-test-support.js';
import { createDiskSpaceOperations } from './space-operations.js';
import { prepareOperationCandidate } from '../../../canvas/operations/candidate.js';
import { submitContentOperationAlreadyLocked } from '../../../canvas/operations/content.js';
import operationRoutes from '../../../canvas/operations/routes.js';
import { setCanvasOperationsEnabled } from '../../../canvas/operations/scope.js';
import { submitOperationAlreadyLocked } from '../../../canvas/operations/service.js';
import { setRequestIdentity } from '../../../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../../../identity/service.js';
import * as storage from '../../index.js';

import type { SpaceOperationWrite } from '../../ports/operations.js';
import type { CanvasOperationRequest, CanvasNodeType } from '@huabu/shared';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(nodeType: CanvasNodeType = 'note') {
  return createDiskOperationFixture(nodeType, cleanup);
}

describe('Disk recoverable operations', () => {
  it('creates portable sidecars without replacing unrelated files and retires a deleted lifetime', async () => {
    const f = await fixture();
    const external = path.join(
      path.dirname(path.join(f.root, f.sidecarPath)),
      'New.md',
    );
    writeFileSync(external, 'External file');
    const request: CanvasOperationRequest = {
      ...f.request,
      preconditions: [],
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'new-node',
              nodeType: 'text',
              position: { x: 1, y: 2 },
              data: { label: 'New', content: 'New body' },
            },
          ],
        },
      ],
    };
    const result = await submitOperationAlreadyLocked(
      f.operations,
      request,
      'owner',
      { kind: 'ui' },
      1000,
    );
    expect(result.status).toBe('committed');
    expect(
      await submitOperationAlreadyLocked(
        f.operations,
        request,
        'owner',
        { kind: 'ui' },
        1000,
      ),
    ).toEqual(result);
    const created = await f.operations.readSnapshot();
    expect(created?.sidecars['new-node']?.content).toBe('New body');
    expect(readFileSync(external, 'utf8')).toBe('External file');
    expect(
      readFileSync(path.join(path.dirname(external), 'New (2).md'), 'utf8'),
    ).toContain('New body');
    const meta = created?.metadata.nodes['new-node'];
    const body = created?.sidecars['new-node'];
    if (!meta || !body) throw new Error('Missing created node');
    const deletion: CanvasOperationRequest = {
      ...request,
      operationId: randomUUID(),
      observedVersion: 1,
      commands: [{ type: 'DELETE_NODES', nodeIds: ['new-node'] }],
      preconditions: [
        {
          kind: 'delete',
          commandIndex: 0,
          nodeId: 'new-node',
          ...meta,
          expectRev: nodeRevisionOf(body),
        },
      ],
    };
    expect(
      (
        await submitOperationAlreadyLocked(
          f.operations,
          deletion,
          'owner',
          { kind: 'ui' },
          1000,
        )
      ).status,
    ).toBe('committed');
    expect(
      (await f.operations.readSnapshot())?.metadata.retiredNodes?.['new-node'],
    ).toEqual({ incarnation: meta.incarnation, deletedVersion: 2 });
    expect(
      readOperationFile(
        f.root,
        path.relative(f.root, path.join(path.dirname(external), 'New (2).md')),
      ),
    ).toBeNull();
    expect(readFileSync(external, 'utf8')).toBe('External file');
  });

  it.each(['create', 'delete'] as const)(
    'recovers %s sidecar/topology/lifetime/receipt at every redo boundary',
    async (kind) => {
      for (const phase of [
        'prepared',
        'decided',
        'sidecar',
        'state',
        'journal',
        'head',
        'receipt',
        'complete',
      ]) {
        const f = await fixture();
        const request: CanvasOperationRequest = {
          ...f.request,
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
              : [{ type: 'DELETE_NODES', nodeIds: ['a'] }],
          preconditions:
            kind === 'create'
              ? []
              : [
                  {
                    kind: 'delete',
                    commandIndex: 0,
                    nodeId: 'a',
                    ...f.snapshot.metadata.nodes['a']!,
                    expectRev: nodeRevisionOf(f.snapshot.sidecars.a),
                  },
                ],
        };
        const plan = prepareOperationCandidate(
          f.snapshot,
          request,
          'owner',
          { kind: 'ui' },
          1000,
        );
        const nodeId = plan.receipt.results[0]?.nodeIds?.[0];
        if (!nodeId) throw new Error('Missing lifecycle result');
        const stages: Record<string, string> = {
          sidecar:
            kind === 'create'
              ? `${path.dirname(f.sidecarPath)}/New.md`
              : f.sidecarPath,
          state: f.statePath,
          journal: `${f.operationDir}/${request.spaceEpoch}/commits/1.json`,
          head: `${f.operationDir}/head.json`,
          receipt: `${f.operationDir}/${request.spaceEpoch}/${request.sessionId}/${request.operationId}.json`,
        };
        const stage = stages[phase] ? `installed:${stages[phase]}` : phase;
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('./space-operations.crash-fixture.ts', import.meta.url),
            ),
            f.root,
            f.canvasId,
            JSON.stringify(plan),
            stage,
          ],
          { encoding: 'utf8', timeout: 20000 },
        );
        expect(child.signal, child.stderr).toBe('SIGKILL');
        const operations = createDiskSpaceOperations(f.canvasId, () => 2000);
        const recovered = await operations.readSnapshot();
        const committed = phase !== 'prepared';
        expect(recovered?.record.version, phase).toBe(committed ? 1 : 0);
        expect(Boolean(recovered?.sidecars[nodeId])).toBe(
          kind === 'create' ? committed : !committed,
        );
        expect(Boolean(recovered?.metadata.retiredNodes?.[nodeId])).toBe(
          kind === 'delete' && committed,
        );
        expect(await operations.lookup(plan.key, plan.digest)).toEqual(
          committed
            ? { status: 'terminal', receipt: plan.receipt }
            : { status: 'absent' },
        );
        expect(await operations.commit(plan)).toEqual(plan.receipt);
        expect((await operations.readSnapshot())?.record.version).toBe(1);
      }
    },
    60000,
  );

  it('serves sessions, snapshot, submit, lookup and replay over HTTP only while the global switch is on', async () => {
    const f = await fixture('web');
    const actualSpace = storage.space;
    const commit = f.operations.commit.bind(f.operations);
    const commitSpy = vi.spyOn(f.operations, 'commit');
    vi.spyOn(storage, 'space').mockImplementation((canvasId) => ({
      ...actualSpace(canvasId),
      operations: f.operations,
    }));
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      setRequestIdentity(request, {
        principal: { principalId: 'owner', kind: 'user' },
        member: true,
        owner: true,
        access: UNRESTRICTED_ACCESS,
      });
    });
    await app.register(operationRoutes, { prefix: '/api/canvas' });
    cleanup.push(async () => {
      setCanvasOperationsEnabled(undefined);
      await app.close();
    });
    const base = `/api/canvas/${f.canvasId}`;
    const createSession = () =>
      app.inject({
        method: 'POST',
        url: `${base}/sync/sessions`,
        payload: { protocolVersion: 1 },
      });

    const disabled = await createSession();
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().code).toBe('collaboration-disabled');

    setCanvasOperationsEnabled(true);
    const sessionResponse = await createSession();
    expect(sessionResponse.statusCode).toBe(200);
    const session = canvasOperationSessionSchema.parse(sessionResponse.json());
    const snapshot = canvasOperationSnapshotSchema.parse(
      (await app.inject({ url: `${base}/sync/snapshot` })).json(),
    );
    expect(snapshot.metadata.spaceEpoch).toBe(session.spaceEpoch);
    const request = {
      ...f.request,
      sessionId: session.sessionId,
      operationId: randomUUID(),
    };
    commitSpy.mockImplementationOnce(async (plan) => {
      await commit(plan);
      throw new Error('Simulated lost commit reply');
    });
    const submit = (payload: object) =>
      app.inject({ method: 'POST', url: `${base}/operations`, payload });
    const lost = await submit(request);
    expect(lost.statusCode).toBe(503);
    expect(lost.json().code).toBe('operation-outcome-unknown');
    const lookup = await app.inject({
      url: `${base}/operations/${request.operationId}?spaceEpoch=${request.spaceEpoch}&sessionId=${request.sessionId}`,
    });
    expect(lookup.statusCode).toBe(200);
    const receipt = canvasOperationReceiptSchema.parse(lookup.json().receipt);
    expect(receipt).toMatchObject({ status: 'committed', commitVersion: 1 });
    expect((await submit(request)).json()).toEqual(receipt);
    expect(commitSpy).toHaveBeenCalledOnce();
    const reused = await submit({ ...request, observedVersion: 1 });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe('operation-id-reused');
    const replay = await app.inject({
      url: `${base}/sync/commits?spaceEpoch=${session.spaceEpoch}&afterVersion=0`,
    });
    expect(canvasCommitPageSchema.parse(replay.json())).toMatchObject({
      status: 'commits',
      commits: [receipt.commit],
      throughVersion: 1,
    });
    // Legacy reads are not fenced by the operation baseline.
    expect((await f.handle.read())?.version).toBe(1);
  });

  it('persists a content-owner operation and resolves its original result after reopening', async () => {
    const f = await fixture();
    const meta = f.snapshot.metadata.nodes['a'];
    if (!meta) throw new Error('Missing content lifetime');
    const request = {
      protocolVersion: 1,
      spaceEpoch: f.request.spaceEpoch,
      sessionId: f.request.sessionId,
      operationId: f.request.operationId,
      observedVersion: 0,
      incarnation: meta.incarnation,
      update: {
        nodeType: 'note',
        content: 'Accepted body',
        expectRev: nodeRevisionOf(f.snapshot.sidecars.a),
      },
    };
    const receipt = await submitContentOperationAlreadyLocked(
      f.operations,
      'a',
      request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(receipt.status).toBe('committed');
    const reopened = createDiskSpaceOperations(f.canvasId, () => 2000);
    expect((await reopened.readSnapshot())?.sidecars['a']).toEqual({
      ...f.snapshot.sidecars.a,
      content: 'Accepted body',
    });
    expect(
      await submitContentOperationAlreadyLocked(
        reopened,
        'a',
        request,
        'owner',
        { kind: 'ui' },
        3000,
      ),
    ).toEqual(receipt);
    expect((await reopened.readSnapshot())?.record.version).toBe(1);
    expect(readFileSync(path.join(f.root, f.sidecarPath), 'utf8')).toContain(
      'Accepted body',
    );
  });

  it('persists identical outcomes and rejects request reuse', async () => {
    const f = await fixture();
    const receipt = await submitOperationAlreadyLocked(
      f.operations,
      f.request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(receipt.status).toBe('committed');
    const reopened = createDiskSpaceOperations(f.canvasId, () => 2000);
    expect(
      await submitOperationAlreadyLocked(
        reopened,
        f.request,
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).toEqual(receipt);
    await expect(
      submitOperationAlreadyLocked(
        reopened,
        { ...f.request, observedVersion: 1 },
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).rejects.toMatchObject({ code: 'operation-id-reused' });
    const page = await reopened.readCommits({
      spaceEpoch: f.request.spaceEpoch,
      afterVersion: 0,
      limit: 200,
      maxBytes: 4194304,
    });
    expect(page).toMatchObject({
      status: 'commits',
      nextAfterVersion: 1,
      hasMore: false,
    });
  });

  it('retains terminal no-op/rejection receipts past lease expiry and refuses new requests', async () => {
    const f = await fixture();
    f.request.commands = [
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: 'a', position: { x: 0, y: 0 } }],
      },
    ];
    const receipt = await submitOperationAlreadyLocked(
      f.operations,
      f.request,
      'owner',
      { kind: 'ui' },
      2000,
    );
    expect(receipt.status).toBe('noop');
    const expired = createDiskSpaceOperations(f.canvasId, () => 20 * 86400000);
    expect(
      await submitOperationAlreadyLocked(
        expired,
        f.request,
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).toEqual(receipt);
    await expect(
      submitOperationAlreadyLocked(
        expired,
        { ...f.request, operationId: randomUUID() },
        'owner',
        { kind: 'ui' },
        2000,
      ),
    ).rejects.toMatchObject({ code: 'session-expired' });
    expect((await expired.readSnapshot())?.record.version).toBe(0);
  });

  it('fences external edits and corrupt decisions without overwriting unrelated files', async () => {
    const f = await fixture();
    writeFileSync(path.join(f.root, 'unrelated.txt'), 'Keep me');
    writeFileSync(path.join(f.root, f.statePath), 'external edit');
    await expect(f.operations.readSnapshot()).rejects.toMatchObject({
      code: 'replay-corrupt',
    });
    expect(readFileSync(path.join(f.root, f.statePath), 'utf8')).toBe(
      'external edit',
    );
    writeFileSync(path.join(f.root, f.operationDir, 'decision'), 'corrupt');
    await expect(f.operations.readSnapshot()).rejects.toMatchObject({
      code: 'replay-corrupt',
    });
    expect(readFileSync(path.join(f.root, 'unrelated.txt'), 'utf8')).toBe(
      'Keep me',
    );
  });

  it('rejects path escape and symlink projection targets before making a decision', async () => {
    const f = await fixture();
    symlinkSync(path.join(f.root, f.statePath), path.join(f.root, 'alias'));
    const redo = new DiskOperationRedo(f.root, f.operationDir);
    for (const target of ['../escape', 'alias']) {
      expect(() =>
        redo.commit([{ path: target, before: null, after: 'unsafe' }]),
      ).toThrow();
      expect(
        readOperationFile(f.root, `${f.operationDir}/decision`),
      ).toBeNull();
    }
  });
});

describe('Disk process termination recovery (not power-loss or filesystem certification)', () => {
  it.each([
    'prepared',
    'decided',
    'sidecar',
    'state',
    'review',
    'journal',
    'head',
    'receipt',
    'complete',
  ])(
    'recovers the original state/event/receipt/Review decision at %s',
    async (phase) => {
      const f = await fixture();
      const base = prepareOperationCandidate(
        f.snapshot,
        f.request,
        'owner',
        { kind: 'ui' },
        2000,
      );
      if (!base.structure || base.receipt.status !== 'committed')
        throw new Error('Missing commit fixture');
      const afterBody = { ...f.snapshot.sidecars.a, content: 'Accepted body' };
      const plan: SpaceOperationWrite = {
        ...base,
        metadata: { ...base.metadata, reviewRevision: 1 },
        review: [{ threadId: 'thread-a', records: [] }],
        structure: {
          ...base.structure,
          nodeMutations: [{ kind: 'put', nodeId: 'a', record: afterBody }],
        },
      };
      base.receipt.commit.reviewRevision = 1;
      base.receipt.commit.events.push({
        type: 'NODE_CONTENT_REVISION',
        nodeId: 'a',
        incarnation: f.snapshot.metadata.nodes['a']!.incarnation,
        beforeRevision: nodeRevisionOf(f.snapshot.sidecars.a),
        afterRevision: nodeRevisionOf(afterBody),
      });
      const review = `${path.dirname(f.statePath)}/.history/chat/thread-a.changes.json`;
      const stages: Record<string, string> = {
        sidecar: f.sidecarPath,
        state: f.statePath,
        review,
        journal: `${f.operationDir}/${f.request.spaceEpoch}/commits/1.json`,
        head: `${f.operationDir}/head.json`,
        receipt: `${f.operationDir}/${f.request.spaceEpoch}/${f.request.sessionId}/${f.request.operationId}.json`,
      };
      const target = stages[phase];
      const stage = target ? `installed:${target}` : phase;
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./space-operations.crash-fixture.ts', import.meta.url),
          ),
          f.root,
          f.canvasId,
          JSON.stringify(plan),
          stage,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      expect(child.signal, child.stderr).toBe('SIGKILL');
      const operations = createDiskSpaceOperations(f.canvasId, () => 2000);
      const recovered = await operations.readSnapshot();
      const committed = phase !== 'prepared';
      expect(recovered?.record.version).toBe(committed ? 1 : 0);
      expect(recovered?.sidecars['a']?.content).toBe(
        committed ? 'Accepted body' : 'Original body',
      );
      expect(recovered?.metadata.reviewRevision).toBe(committed ? 1 : 0);
      expect(readOperationFile(f.root, review)).toBe(committed ? '[]' : null);
      const found = await operations.lookup(plan.key, plan.digest);
      expect(found).toEqual(
        committed
          ? { status: 'terminal', receipt: plan.receipt }
          : { status: 'absent' },
      );
      const replay = {
        spaceEpoch: f.request.spaceEpoch,
        afterVersion: 0,
        limit: 200,
        maxBytes: 4194304,
      };
      expect(await operations.readCommits(replay)).toMatchObject({
        status: 'commits',
        commits: committed ? [plan.receipt.commit] : [],
        nextAfterVersion: committed ? 1 : 0,
        hasMore: false,
      });
      expect(await operations.commit(plan)).toEqual(plan.receipt);
      expect((await operations.readSnapshot())?.record.version).toBe(1);
      expect(await operations.readCommits(replay)).toMatchObject({
        commits: [plan.receipt.commit],
        nextAfterVersion: 1,
        hasMore: false,
      });
      expect(
        readOperationFile(f.root, `${f.operationDir}/decision`),
      ).toBeNull();
      expect(
        readOperationFile(f.root, `${f.operationDir}/pending.json`),
      ).toBeNull();
    },
  );
});
