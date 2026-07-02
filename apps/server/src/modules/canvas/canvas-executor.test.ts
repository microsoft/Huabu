/**
 * Compare-and-swap (optimistic concurrency) tests for the headless
 * executor's `MERGE_NODE_DATA` content path.
 *
 * Covers the Phase 2 write guard: agent-originated content rewrites must
 * carry an `expectRev` matching the node's current authored-content
 * revision; ui / system writes are unconditional; non-content patches
 * (label only) are never guarded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeRevisionOf } from '@sediment/shared/canvas-engine';

import { executeOnServer } from './canvas-executor.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand, ExecuteOriginator } from '@sediment/shared';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-cas-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a canvas with one note (canvas.json entry + `.md` body). */
function seedNote(canvasId: string, id: string, content: string): void {
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        { id, type: 'note', position: { x: 0, y: 0 }, data: { label: 'A' } },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode(id, { nodeId: id, type: 'note', label: 'A', content });
}

/** Current authored-content rev, computed exactly as the executor does. */
function currentRev(canvasId: string, id: string): string {
  const nc = getCanvasStore(canvasId).readNode(id);
  return nodeRevisionOf({
    content: nc?.content,
    src: typeof nc?.src === 'string' ? nc.src : undefined,
  });
}

function bodyOf(canvasId: string, id: string): string | undefined {
  return getCanvasStore(canvasId).readNode(id)?.content ?? undefined;
}

function mergeContent(
  nodeId: string,
  content: string,
  expectRev?: string,
): CanvasCommand {
  return {
    type: 'MERGE_NODE_DATA',
    patches: [
      { nodeId, patch: { content }, ...(expectRev ? { expectRev } : {}) },
    ],
  } as unknown as CanvasCommand;
}

const AGENT: ExecuteOriginator = { source: 'agent' };
const UI: ExecuteOriginator = { source: 'ui' };

describe('executeOnServer — MERGE_NODE_DATA CAS', () => {
  it('applies an agent write whose expectRev matches the current rev', async () => {
    seedNote('c1', 'n1', 'hello');
    const rev = currentRev('c1', 'n1');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world', rev)],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(out.toVersion).toBe(out.fromVersion + 1);
    expect(bodyOf('c1', 'n1')).toBe('world');
  });

  it('rejects an agent write with a stale expectRev — nothing mutates', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world', 'staleRev')],
      originator: AGENT,
    });

    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts?.[0]).toMatchObject({
      nodeId: 'n1',
      expectedRev: 'staleRev',
      currentContent: 'hello',
    });
    expect(out.toVersion).toBe(out.fromVersion); // no version bump
    expect(bodyOf('c1', 'n1')).toBe('hello'); // body untouched
    expect(out.results.every((r) => !r.applied)).toBe(true);
  });

  it('rejects an agent content write with NO expectRev (never read)', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world')],
      originator: AGENT,
    });

    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts?.[0]?.expectedRev).toBeUndefined();
    expect(bodyOf('c1', 'n1')).toBe('hello');
  });

  it('allows a ui write with no expectRev (trusted, unconditional)', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [mergeContent('n1', 'world')],
      originator: UI,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(bodyOf('c1', 'n1')).toBe('world');
  });

  it('does not guard a label-only agent patch (outside the rev key set)', async () => {
    seedNote('c1', 'n1', 'hello');

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'n1', patch: { label: 'Renamed' } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(bodyOf('c1', 'n1')).toBe('hello');
  });
});
