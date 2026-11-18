// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What a write puts on the wire and into storage is proportional to what it
 * changed. Moving a PDF whose extracted text is a megabyte carries a
 * position: the response, the `update` event, the delta log row and the
 * result record all stay small. A body edit carries the old and the new
 * body once, in the deltas, and nothing of any other node.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyDeltas, nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  applyDeltasOnServer,
  executeOnServer,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import { setRequestIdentity } from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { createSpace, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasFile, NodeContent } from './persistence-types.js';
import type {
  CanvasCommand,
  CanvasSyncEvent,
  PostCanvasExecuteResponse,
} from '@huabu/shared';
import type { CanvasNode, Delta } from '@huabu/shared/canvas-engine';

const CANVAS = 'c1';
const PRINCIPAL = 'user:alice';
const THREAD = 'thread-review';
/** A megabyte of extracted text. */
const PDF_TEXT = 'Extracted page text. '.repeat(50_000);
const NOTE_BODY = 'Human paragraph. '.repeat(6_000);
/** Generous for ids, versions and one position; far below any body. */
const SMALL = 2_048;

const RECORDS: NodeContent[] = [
  {
    nodeId: 'pdf',
    type: 'pdf',
    label: 'Paper',
    content: PDF_TEXT,
    src: 'artifacts/paper.pdf',
  },
  { nodeId: 'note', type: 'note', label: 'Note', content: NOTE_BODY },
];

let tmp: string;
let previousDataDir: string | undefined;
let events: CanvasSyncEvent[];
let unsubscribe: () => void;

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

async function seed(): Promise<void> {
  const created = await createSpace(CANVAS, 'Sizes');
  if (!created.ok) throw new Error('Could not create the test Space');
  const next: CanvasFile = {
    ...created.record,
    version: 1,
    state: {
      nodes: RECORDS.map((record, index) => ({
        id: record.nodeId,
        type: record.type,
        position: { x: index * 400, y: 0 },
        style: { width: 300, height: 200 },
        data: {},
      })),
      edges: [],
    },
  };
  const written = await space(CANVAS).write({
    expectedVersion: 0,
    nextRecord: next,
    nodeMutations: RECORDS.map((record) => ({
      kind: 'put' as const,
      nodeId: record.nodeId,
      record,
    })),
  });
  if (!written.ok) throw new Error('Could not seed the test Space');
}

async function buildApp() {
  const app = fastify();
  app.addHook('onRequest', async (request) => {
    setRequestIdentity(request, {
      principal: { principalId: PRINCIPAL, kind: 'bot' },
      member: true,
      owner: true,
      access: UNRESTRICTED_ACCESS,
    });
  });
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

function lastLogRow(): string {
  // The Space directory is named after the title; find the log under it.
  const [log] = readdirSync(tmp, { recursive: true, encoding: 'utf8' }).filter(
    (entry) => entry.endsWith(join('.history', 'delta-log.jsonl')),
  );
  if (!log) throw new Error('No delta log was written');
  const lines = readFileSync(join(tmp, log), 'utf8')
    .split('\n')
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function lastUpdate(): Extract<CanvasSyncEvent, { type: 'update' }> {
  const update = [...events]
    .reverse()
    .find(
      (event): event is Extract<CanvasSyncEvent, { type: 'update' }> =>
        event.type === 'update',
    );
  if (!update) throw new Error('No update was published');
  return update;
}

async function storedNodes(): Promise<CanvasNode[]> {
  const record = await space(CANVAS).read();
  const contents = await space(CANVAS).nodes.list();
  return (record?.state.nodes as CanvasNode[]).map((node) => ({
    ...node,
    data: {
      ...node.data,
      content: contents.get(node.id)?.record?.content,
    },
  }));
}

const agent = (
  commands: unknown[],
  extra: Partial<Parameters<typeof executeOnServer>[0]> = {},
): Promise<ExecuteOnServerOutput> =>
  executeOnServer({
    canvasId: CANVAS,
    commands: commands as CanvasCommand[],
    originator: { source: 'agent', threadId: THREAD },
    computeChanges: true,
    ...extra,
  });

describe('payload sizes', () => {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'huabu-payload-'));
    previousDataDir = process.env.HUABU_DATA_DIR;
    process.env.HUABU_DATA_DIR = tmp;
    setWorkspacePath(tmp);
    await seed();
    events = [];
    unsubscribe = subscribeCanvasUpdates(CANVAS, (event) => events.push(event));
  });

  afterEach(() => {
    unsubscribe();
    if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
    else process.env.HUABU_DATA_DIR = previousDataDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('moving a PDF with a megabyte of extracted text: response, event, log row and result record stay small', async () => {
    const app = await buildApp();
    try {
      const operationId = randomUUID();
      const payload = {
        operationId,
        originator: { tabId: 'page-1' },
        edits: [
          {
            commands: [
              {
                type: 'SET_NODE_GEOMETRY',
                items: [{ nodeId: 'pdf', position: { x: 640, y: 80 } }],
              },
            ],
          },
        ],
      };
      const first = await app.inject({
        method: 'POST',
        url: `/canvas/${CANVAS}/execute`,
        payload,
      });
      expect(first.statusCode).toBe(200);
      const body = first.json<PostCanvasExecuteResponse>();
      expect(body.toVersion).toBe(2);
      expect(body.edits).toEqual([
        { applied: true, results: [{ applied: true }] },
      ]);
      expect(body.deltas).toEqual([
        {
          type: 'REPLACE_NODE',
          nodeType: 'pdf',
          prev: { id: 'pdf', position: { x: 0, y: 0 } },
          next: { id: 'pdf', position: { x: 640, y: 80 } },
        },
      ]);

      const record = await space(CANVAS).save.lookup({
        principalId: PRINCIPAL,
        operationId,
      });
      const sizes = {
        response: Buffer.byteLength(first.body, 'utf8'),
        event: bytes(lastUpdate()),
        logRow: Buffer.byteLength(lastLogRow(), 'utf8'),
        resultRecord: bytes(record?.response),
      };
      for (const [what, size] of Object.entries(sizes)) {
        expect(size, what).toBeGreaterThan(0);
        expect(size, what).toBeLessThan(SMALL);
      }
      // None of them holds any of the extracted text.
      for (const text of [
        first.body,
        JSON.stringify(lastUpdate()),
        lastLogRow(),
        JSON.stringify(record?.response),
      ]) {
        expect(text).not.toContain('Extracted page text');
      }

      // A repeat is answered from that record: same answer, no deltas.
      const again = await app.inject({
        method: 'POST',
        url: `/canvas/${CANVAS}/execute`,
        payload,
      });
      const { deltas: _deltas, ...answer } = body;
      expect(again.json()).toEqual({ ...answer, replayed: true });
      expect((await space(CANVAS).read())?.version).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('an agent body edit carries the old and the new body once, and can be reverted from its Review record', async () => {
    const edited = 'Agent paragraph. '.repeat(6_000);
    const request = { operationId: randomUUID(), principalId: PRINCIPAL };
    const out = await agent(
      [
        {
          type: 'MERGE_NODE_DATA',
          patches: [
            {
              nodeId: 'note',
              patch: { content: edited },
              expectRev: nodeRevisionOf({ type: 'note', content: NOTE_BODY }),
            },
          ],
        },
      ],
      { request },
    );
    expect(out.results[0]).toMatchObject({ applied: true });
    const update = lastUpdate();
    const [row] = update.data.deltas as Delta[];
    expect(row).toMatchObject({
      type: 'REPLACE_NODE',
      prev: { id: 'note', data: { content: NOTE_BODY } },
      next: { id: 'note', data: { content: edited } },
    });

    // What changed: the body (old and new value) and the block provenance
    // the server derives for an agent's text, which is about as long as it.
    const provenance = bytes(
      (row as Extract<Delta, { type: 'REPLACE_NODE' }>).next.data?.provenance,
    );
    const changed = NOTE_BODY.length + edited.length + provenance;
    const record = await space(CANVAS).save.lookup(request);
    const sizes = {
      deltas: bytes(update.data.deltas),
      event: bytes(update),
      logRow: Buffer.byteLength(lastLogRow(), 'utf8'),
      resultRecord: bytes(record?.response),
    };
    // The deltas hold the changed values once and little else.
    expect(sizes.deltas).toBeLessThan(changed + SMALL);
    // The event adds the Review record, whose revert row holds them again.
    expect(sizes.event).toBeLessThan(2 * changed + 2 * SMALL);
    expect(sizes.logRow).toBeLessThan(changed + SMALL);
    // The record never depends on a body.
    expect(sizes.resultRecord).toBeLessThan(SMALL);
    expect(JSON.stringify(update)).not.toContain('Extracted page text');

    // Reverting through the stored Review record restores the body.
    const [change] = await space(CANVAS).changes.read(THREAD);
    expect(change?.kind).toBe('update');
    await applyDeltasOnServer({
      canvasId: CANVAS,
      deltas: change!.revertDeltas,
      change: change!,
      originator: { source: 'ui' },
    });
    expect((await space(CANVAS).nodes.read('note'))?.record?.content).toBe(
      NOTE_BODY,
    );
  });

  it('an agent delete travels as an id; the Review record holds the node and brings it back', async () => {
    const before = await storedNodes();
    const out = await agent([{ type: 'DELETE_NODES', nodeIds: ['pdf'] }]);
    expect(out.results[0]).toMatchObject({ applied: true });

    const update = lastUpdate();
    expect(update.data.deltas).toEqual([
      { type: 'DELETE_NODE', node: { id: 'pdf', type: 'pdf' } },
    ]);
    expect(bytes(update.data.deltas)).toBeLessThan(200);
    expect(Buffer.byteLength(lastLogRow(), 'utf8')).toBeLessThan(SMALL);
    expect(lastLogRow()).not.toContain('Extracted page text');
    expect((await space(CANVAS).nodes.read('pdf'))?.record ?? null).toBeNull();

    // The only copy of the deleted content is the Review record's revert
    // row, where a revert is possible at all.
    const [change] = await space(CANVAS).changes.read(THREAD);
    expect(change).toMatchObject({ kind: 'delete', nodeId: 'pdf' });
    const [revert] = change!.revertDeltas;
    expect(revert?.type).toBe('INSERT_NODE');
    await applyDeltasOnServer({
      canvasId: CANVAS,
      deltas: change!.revertDeltas,
      change: change!,
      originator: { source: 'ui' },
    });
    expect((await space(CANVAS).nodes.read('pdf'))?.record?.content).toBe(
      PDF_TEXT,
    );
    const after = await storedNodes();
    expect(after.find((node) => node.id === 'pdf')).toMatchObject({
      type: 'pdf',
      position: before.find((node) => node.id === 'pdf')?.position,
    });
    // A page that receives the revert applies it from the row it gets.
    const reinserted = applyDeltas({ nodes: [], edges: [] }, [revert as Delta]);
    expect(reinserted.nodes[0]?.data.content).toBe(PDF_TEXT);
  });
});
