// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { createCanvasCommitGate } from './canvasCommitSync';

import type { CanvasCommitEvent, MutationAck } from '@huabu/shared';

const cleanCursor = (
  version: number,
  structureRevision = `structure-${version}`,
) => ({
  version,
  structureRevision,
  structureDirtyGeneration: 4,
  structureSyncedGeneration: 4,
});

function ack(
  commitId: string,
  fromVersion: number,
  structureRevision = `structure-${fromVersion + 1}`,
): MutationAck {
  return {
    commitId,
    fromVersion,
    toVersion: fromVersion + 1,
    structureRevision,
    recordChanged: true,
  };
}

function event(
  commitId: string,
  fromVersion: number,
  overrides: Partial<CanvasCommitEvent> = {},
): CanvasCommitEvent {
  return {
    ...ack(commitId, fromVersion),
    originator: { source: 'ui', tabId: 'tab-local' },
    optimistic: true,
    structureDeltas: [{ type: 'REPLACE_NODE' }],
    nodeChanges: [],
    ...overrides,
  };
}

describe('canvas commit version gate', () => {
  it('accepts an optimistic SSE echo before its HTTP response exactly once', () => {
    const gate = createCanvasCommitGate();
    const inFlightCursor = {
      ...cleanCursor(4),
      structureDirtyGeneration: 5,
      structureSyncedGeneration: 4,
    };
    const first = gate.consume(
      { kind: 'event', commit: event('commit-1', 4), localTabId: 'tab-local' },
      inFlightCursor,
    );

    expect(first).toMatchObject({
      kind: 'accepted',
      apply: 'none',
      ownOptimisticEcho: true,
      cursor: { version: 5, structureRevision: 'structure-5' },
    });
    if (first.kind !== 'accepted') throw new Error('expected acceptance');

    expect(
      gate.consume({ kind: 'ack', ack: ack('commit-1', 4) }, first.cursor),
    ).toMatchObject({ kind: 'duplicate', cursor: { version: 5 } });
  });

  it('accepts the HTTP response before SSE without replaying the echo', () => {
    const gate = createCanvasCommitGate();
    const first = gate.consume(
      { kind: 'ack', ack: ack('commit-2', 8) },
      cleanCursor(8),
    );
    expect(first).toMatchObject({
      kind: 'accepted',
      apply: 'none',
      cursor: { version: 9 },
    });
    if (first.kind !== 'accepted') throw new Error('expected acceptance');

    expect(
      gate.consume(
        {
          kind: 'event',
          commit: event('commit-2', 8),
          localTabId: 'tab-local',
        },
        first.cursor,
      ),
    ).toMatchObject({ kind: 'duplicate', cursor: { version: 9 } });
  });

  it('does not regress for a late older HTTP response', () => {
    const gate = createCanvasCommitGate();
    expect(
      gate.consume(
        { kind: 'ack', ack: ack('commit-old', 3, 'structure-old') },
        cleanCursor(6, 'structure-current'),
      ),
    ).toEqual({
      kind: 'stale',
      cursor: cleanCursor(6, 'structure-current'),
    });
  });

  it('reports a version gap without advancing either cursor', () => {
    const gate = createCanvasCommitGate();
    const cursor = cleanCursor(2);
    const input = {
      kind: 'event' as const,
      commit: event('commit-gap', 4, {
        originator: { source: 'agent' },
        optimistic: false,
      }),
      localTabId: 'tab-local',
    };
    expect(gate.consume(input, cursor)).toEqual({
      kind: 'gap',
      cursor,
      localStructureDirty: false,
    });
    // Gap entries stay retryable: the same SSE/HTTP commit can be consumed
    // after its missing predecessor has advanced the cursor.
    expect(gate.consume(input, cleanCursor(4))).toMatchObject({
      kind: 'accepted',
      cursor: { version: 5 },
    });
  });

  it('buffers an SSE/HTTP gap and drains it once the predecessor arrives', () => {
    const gate = createCanvasCommitGate();
    const preprocess = event('commit-preprocess', 2, {
      originator: { source: 'ui', tabId: 'tab-local' },
      optimistic: false,
      structureDeltas: [],
      nodeChanges: [
        {
          kind: 'invalidate',
          nodeId: 'node-1',
          recordRevision: 'record-3',
        },
      ],
    });
    const preprocessInput = {
      kind: 'event' as const,
      commit: preprocess,
      localTabId: 'tab-local',
    };

    expect(gate.consume(preprocessInput, cleanCursor(1))).toMatchObject({
      kind: 'gap',
      cursor: { version: 1 },
    });
    // The HTTP copy of the same full commit must not create a second buffered
    // application while its predecessor is still delayed.
    expect(gate.consume(preprocessInput, cleanCursor(1))).toMatchObject({
      kind: 'gap',
      cursor: { version: 1 },
    });

    const predecessor = gate.consume(
      {
        kind: 'event',
        commit: event('commit-remote', 1, {
          originator: { source: 'agent' },
          optimistic: false,
        }),
        localTabId: 'tab-local',
      },
      cleanCursor(1),
    );

    expect(predecessor).toMatchObject({
      kind: 'accepted',
      cursor: { version: 3 },
      accepted: [
        { input: { commit: { commitId: 'commit-remote' } } },
        {
          input: { commit: { commitId: 'commit-preprocess' } },
          apply: 'nodes',
          cursor: { version: 3 },
        },
      ],
    });
    expect(gate.consume(preprocessInput, cleanCursor(3))).toMatchObject({
      kind: 'duplicate',
    });
  });

  it('does not attach a newer in-flight structure generation to a buffered echo', () => {
    type Context = { acknowledgedStructureGeneration?: number };
    const gate = createCanvasCommitGate<Context>();
    const ownStructure = {
      kind: 'event' as const,
      commit: event('commit-own-g1', 2),
      localTabId: 'tab-local',
    };

    // The SSE echo gaps first and carries no trustworthy request generation.
    expect(gate.consume(ownStructure, cleanCursor(1))).toMatchObject({
      kind: 'gap',
    });
    // Its HTTP copy explicitly acknowledges g1 at the call site. The gate
    // keeps the richer/earlier event buffered, so that explicit generation
    // must not be inferred again when the event is eventually drained.
    expect(
      gate.consume(
        {
          ...ownStructure,
          context: { acknowledgedStructureGeneration: 1 },
        },
        cleanCursor(1),
      ),
    ).toMatchObject({ kind: 'gap' });

    // While predecessor A is delayed, a newer g2 save can start. Draining B
    // must retain its original generation-less context; the store therefore
    // cannot falsely mark g2 synced if that newer request fails.
    const drained = gate.consume(
      {
        kind: 'event',
        commit: event('commit-predecessor', 1, {
          originator: { source: 'agent' },
          optimistic: false,
        }),
        localTabId: 'tab-local',
      },
      {
        ...cleanCursor(1),
        structureDirtyGeneration: 2,
        structureSyncedGeneration: 1,
      },
    );

    expect(drained).toMatchObject({
      kind: 'accepted',
      cursor: { version: 3 },
      accepted: [
        { input: { commit: { commitId: 'commit-predecessor' } } },
        {
          input: { commit: { commitId: 'commit-own-g1' } },
        },
      ],
    });
    if (drained.kind !== 'accepted') throw new Error('expected acceptance');
    expect(drained.accepted[1]?.input.context).toBeUndefined();
  });

  it('requires an authoritative reload when the ordered gap buffer overflows', () => {
    const gate = createCanvasCommitGate(2);
    const gap = (commitId: string, fromVersion: number) => ({
      kind: 'event' as const,
      commit: event(commitId, fromVersion, {
        originator: { source: 'agent' },
        optimistic: false,
      }),
      localTabId: 'tab-local',
    });

    const first = gate.consume(gap('future-1', 5), cleanCursor(1));
    expect(first).toMatchObject({ kind: 'gap' });
    if (first.kind !== 'gap') throw new Error('expected gap');
    expect(first.requiresReload).toBeUndefined();
    const second = gate.consume(gap('future-2', 6), cleanCursor(1));
    expect(second).toMatchObject({ kind: 'gap' });
    if (second.kind !== 'gap') throw new Error('expected gap');
    expect(second.requiresReload).toBeUndefined();
    expect(gate.consume(gap('future-3', 7), cleanCursor(1))).toMatchObject({
      kind: 'gap',
      requiresReload: true,
      cursor: { version: 1 },
    });
  });

  it('applies node-only commits without changing structure revision', () => {
    const gate = createCanvasCommitGate();
    const cursor = {
      ...cleanCursor(10, 'structure-stable'),
      structureDirtyGeneration: 5,
      structureSyncedGeneration: 4,
    };
    const result = gate.consume(
      {
        kind: 'event',
        commit: event('commit-node', 10, {
          structureRevision: 'structure-stable',
          originator: { source: 'agent' },
          optimistic: false,
          structureDeltas: [],
          nodeChanges: [
            {
              kind: 'invalidate',
              nodeId: 'node-1',
              recordRevision: 'record-2',
            },
          ],
        }),
        localTabId: 'tab-local',
      },
      cursor,
    );

    expect(result).toMatchObject({
      kind: 'accepted',
      apply: 'nodes',
      cursor: { version: 11, structureRevision: 'structure-stable' },
    });
  });

  it('preserves an unsaved local structure when a remote structure wins', () => {
    const gate = createCanvasCommitGate();
    const cursor = {
      ...cleanCursor(12, 'structure-local-base'),
      structureDirtyGeneration: 7,
      structureSyncedGeneration: 6,
    };
    expect(
      gate.consume(
        {
          kind: 'event',
          commit: event('commit-remote', 12, {
            structureRevision: 'structure-remote',
            originator: { source: 'agent' },
            optimistic: false,
          }),
          localTabId: 'tab-local',
        },
        cursor,
      ),
    ).toMatchObject({
      kind: 'accepted',
      apply: 'none',
      preservedLocalStructure: true,
      cursor: { version: 13, structureRevision: 'structure-local-base' },
    });
  });
});
