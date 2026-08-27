// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { updateNode } from './write-coordinator.js';

import type {
  NodeContent,
  NodePutInput,
  NodePutResult,
  SpaceNodes,
  NodeSnapshot,
} from '../storage/index.js';

function storageRevisionOf(record: NodeContent | null): string | null {
  return record === null ? null : JSON.stringify(record);
}

function fakeRepository(canvasId = 'c1') {
  let record: NodeContent | null = null;
  let suppressed = false;
  let putImpl: ((input: NodePutInput) => NodePutResult | undefined) | null =
    null;

  const nodes: SpaceNodes = {
    canvasId,
    async read(): Promise<NodeSnapshot | null> {
      if (record === null) return null;
      const revision = storageRevisionOf(record);
      if (revision === null) throw new Error('test storage token is missing');
      return { record, revision };
    },
    // This fake holds one node, so the collection reads are the same record
    // under its own id. `updateNode` never calls them; they exist because the
    // port has them.
    async readMany(nodeIds): Promise<Map<string, NodeSnapshot>> {
      const snapshot = await nodes.read('');
      return snapshot !== null && nodeIds.includes(snapshot.record.nodeId)
        ? new Map([[snapshot.record.nodeId, snapshot]])
        : new Map();
    },
    async list(): Promise<Map<string, NodeSnapshot>> {
      const snapshot = await nodes.read('');
      return snapshot === null
        ? new Map()
        : new Map([[snapshot.record.nodeId, snapshot]]);
    },
    async stream(onNode): Promise<Map<string, NodeSnapshot>> {
      const all = await nodes.list();
      for (const snapshot of all.values()) onNode(snapshot);
      return all;
    },
    async put(input) {
      if (suppressed) return { ok: false, reason: 'write-suppressed' };
      const currentRevision = storageRevisionOf(record);
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        return {
          ok: false,
          reason: 'revision-conflict',
          currentRevision,
        };
      }
      const custom = putImpl?.(input);
      if (custom !== undefined) return custom;
      record = input.record;
      const revision = storageRevisionOf(record);
      if (revision === null) throw new Error('test storage token is missing');
      return { ok: true, record, revision };
    },
    async delete() {
      const result = record === null ? 'absent' : 'deleted';
      record = null;
      return result;
    },
  };

  return {
    nodes,
    get: () => record,
    seed: (next: NodeContent | null) => {
      record = next;
    },
    setSuppressed: (value: boolean) => {
      suppressed = value;
    },
    onPut: (
      implementation: (input: NodePutInput) => NodePutResult | undefined,
    ) => {
      putImpl = implementation;
    },
  };
}

function note(content: string, label: string | null = 'Note'): NodeContent {
  return { nodeId: 'n1', type: 'note', label, content };
}

describe('updateNode', () => {
  it('writes and returns the persisted revision and label', async () => {
    const fixture = fakeRepository();
    const result = await updateNode(fixture.nodes, 'n1', {
      apply: () => note('hello'),
    });

    expect(result).toEqual({
      status: 'ok',
      rev: nodeRevisionOf({ content: 'hello' }),
      label: 'Note',
    });
    expect(fixture.get()?.content).toBe('hello');
  });

  it('refuses a stale revision without invoking the mutation', async () => {
    const fixture = fakeRepository();
    fixture.seed(note('disk-newer'));
    let applied = false;

    const result = await updateNode(fixture.nodes, 'n1', {
      expectRev: nodeRevisionOf({ content: 'stale' }),
      apply: () => {
        applied = true;
        return note('would-clobber');
      },
    });

    expect(result).toEqual({
      status: 'rev-conflict',
      currentRev: nodeRevisionOf({ content: 'disk-newer' }),
    });
    expect(applied).toBe(false);
    expect(fixture.get()?.content).toBe('disk-newer');
  });

  it('writes when the expected revision matches', async () => {
    const fixture = fakeRepository();
    fixture.seed(note('v1'));

    const result = await updateNode(fixture.nodes, 'n1', {
      expectRev: nodeRevisionOf({ content: 'v1' }),
      apply: (current) => note(`${current?.content ?? ''}+v2`),
    });

    expect(result.status).toBe('ok');
    expect(fixture.get()?.content).toBe('v1+v2');
  });

  it('reports a full-record CAS conflict once, in public content revisions', async () => {
    const fixture = fakeRepository();
    fixture.seed(note('same body', 'Original label'));
    let calls = 0;
    fixture.onPut(() => {
      calls += 1;
      fixture.seed({
        ...note('concurrent body', 'Concurrent label'),
        summary: 'concurrent metadata',
      });
      return {
        ok: false,
        reason: 'revision-conflict',
        currentRevision: storageRevisionOf(fixture.get()),
      };
    });

    const result = await updateNode(fixture.nodes, 'n1', {
      expectRev: nodeRevisionOf({ content: 'same body' }),
      apply: (current) => ({
        ...(current ?? note('same body')),
        content: 'next body',
      }),
    });

    // One pass, no retry: the mutex plus a synchronous adapter mean nothing
    // can move the record mid-operation, so re-running `apply` would be a
    // merge policy invented for a backend that does not exist.
    expect(calls).toBe(1);
    // The conflict is reported as a public content revision, never as the
    // opaque storage token the repository refused on.
    expect(result).toEqual({
      status: 'rev-conflict',
      currentRev: nodeRevisionOf({ content: 'concurrent body' }),
    });
    expect(fixture.get()).toMatchObject({ content: 'concurrent body' });
  });

  it('does not call put when apply returns null', async () => {
    const fixture = fakeRepository();
    fixture.seed(note('unchanged'));
    let putCalled = false;
    fixture.onPut(() => {
      putCalled = true;
      return { ok: false, reason: 'not-found' };
    });

    await expect(
      updateNode(fixture.nodes, 'n1', { apply: () => null }),
    ).resolves.toEqual({ status: 'noop' });
    expect(putCalled).toBe(false);
  });

  it('surfaces a portable label rejection', async () => {
    const fixture = fakeRepository();
    fixture.onPut(() => ({
      ok: false,
      reason: 'label-conflict',
      conflictingNodeId: 'other',
      conflictingLabel: 'Taken',
    }));

    const result = await updateNode(fixture.nodes, 'n1', {
      apply: () => note('body', 'Taken'),
    });

    expect(result).toMatchObject({
      status: 'rejected',
      result: { reason: 'label-conflict' },
    });
  });

  it('does not persist a write suppressed after deletion', async () => {
    const fixture = fakeRepository();
    fixture.seed(note('on-disk'));
    fixture.setSuppressed(true);

    const result = await updateNode(fixture.nodes, 'n1', {
      apply: () => note('late-resurrection'),
    });

    expect(result).toEqual({ status: 'skipped-deleted' });
    expect(fixture.get()?.content).toBe('on-disk');
  });

  it('serializes concurrent updates so the second observes the first', async () => {
    const fixture = fakeRepository();

    const first = updateNode(fixture.nodes, 'n1', {
      apply: () => note('A'),
    });
    const second = updateNode(fixture.nodes, 'n1', {
      apply: (current) => note(`${current?.content ?? ''}B`),
    });
    await Promise.all([first, second]);

    expect(fixture.get()?.content).toBe('AB');
  });
});
