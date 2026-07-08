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

function imageStyleOf(
  canvasId: string,
  nodeId: string,
): { width?: unknown; height?: unknown } {
  const canvas = getCanvasStore(canvasId).read();
  const nodes = (canvas?.state.nodes ?? []) as Array<{
    id?: unknown;
    style?: unknown;
  }>;
  const node = nodes.find((n) => n.id === nodeId);
  return ((node as { style?: unknown } | undefined)?.style ?? {}) as Record<
    string,
    unknown
  >;
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
      reason: 'stale',
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
    expect(out.conflicts?.[0]?.reason).toBe('not-read');
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

  it('does not guard a src-only agent write (media pointer, never read)', async () => {
    // A media node's `src` is a short pointer reached via the artifact it
    // points at, never via a `nodes/<label>.md` read — so the read-set never
    // holds its rev. Guarding it would reject every legit `src` rewrite as
    // `not-read`; `src` writes are therefore unconditional, like ui writes.
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'm1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Pic', src: 'artifacts/old.png' },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('m1', {
      nodeId: 'm1',
      type: 'image',
      label: 'Pic',
      src: 'artifacts/old.png',
      content: '',
    });

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'm1', patch: { src: 'artifacts/new.png' } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(out.toVersion).toBe(out.fromVersion + 1);
    expect(getCanvasStore('c1').readNode('m1')?.src).toBe('artifacts/new.png');
  });

  it('auto-updates image height when MERGE_NODE_DATA rewrites src', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'm1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Pic', src: 'old.svg' },
            style: { width: 300, height: 300 },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('m1', {
      nodeId: 'm1',
      type: 'image',
      label: 'Pic',
      src: 'old.svg',
      content: '',
    });
    await store.writeArtifactBuffer(
      { id: 'new', ext: '.svg', mimeType: 'image/svg+xml' },
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>',
      ),
    );

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'm1', patch: { src: 'new.svg' } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    expect(getCanvasStore('c1').readNode('m1')?.src).toBe('new.svg');
    const style = imageStyleOf('c1', 'm1');
    expect(style.width).toBe(300);
    expect(style.height).toBe(150);
    expect(out.results[0]?.nodes).toEqual([
      { nodeId: 'm1', width: 300, height: 150, src: 'new.svg' },
    ]);
  });

  it('recomputes image height when SET_NODE_GEOMETRY pins a mismatched size', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'g1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Pic', src: 'pic.svg' },
            style: { width: 400, height: 300 },
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('g1', {
      nodeId: 'g1',
      type: 'image',
      label: 'Pic',
      src: 'pic.svg',
      content: '',
    });
    await store.writeArtifactBuffer(
      { id: 'pic', ext: '.svg', mimeType: 'image/svg+xml' },
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>',
      ),
    );

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'SET_NODE_GEOMETRY',
          items: [{ nodeId: 'g1', size: { width: 500, height: 500 } }],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.conflicts ?? []).toHaveLength(0);
    const style = imageStyleOf('c1', 'g1');
    expect(style.width).toBe(500);
    expect(style.height).toBe(250);
  });
});

describe('executeOnServer — CREATE_NODES id echo', () => {
  it('echoes the server-assigned id and label of every created node', async () => {
    const store = getCanvasStore('c1');
    store.write({
      canvasId: 'c1',
      title: null,
      version: 1,
      state: { nodes: [], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const out = await executeOnServer({
      canvasId: 'c1',
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              nodeType: 'note',
              position: { x: 0, y: 0 },
              data: { label: 'Finding A', content: 'a' },
            },
            {
              nodeType: 'note',
              position: { x: 200, y: 0 },
              data: { label: 'Finding B', content: 'b' },
            },
          ],
        } as unknown as CanvasCommand,
      ],
      originator: AGENT,
    });

    expect(out.results[0]?.applied).toBe(true);
    const echoed = out.results[0]?.nodes ?? [];
    expect(echoed).toHaveLength(2);
    // Ids are server-assigned (agent omitted them) and unique.
    expect(echoed[0]?.nodeId).toMatch(/^node-/);
    expect(echoed[1]?.nodeId).toMatch(/^node-/);
    expect(echoed[0]?.nodeId).not.toBe(echoed[1]?.nodeId);
    // Labels are echoed so the agent can correlate ids to intent.
    expect(echoed.map((n) => n.label)).toEqual(['Finding A', 'Finding B']);
  });
});
