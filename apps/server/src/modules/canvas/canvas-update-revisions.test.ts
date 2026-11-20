// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A committed batch tells its readers the stored content revision of every
 * node whose saved content it created or changed: on the `update` event, in
 * the executor's output (the `POST /execute` response) and in the stored
 * result a repeated request is answered from. The revision is the one a
 * load returns for the node, not a hash of the node in the deltas.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editsPerCommand } from '@huabu/shared';
import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import {
  applyDeltasOnServer,
  executeOnServer,
  type ExecuteOnServerInput,
  type ExecuteOnServerOutput,
} from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import { expectReplayOf } from './execute-replay.test-support.js';
import {
  closeStorage,
  createSpace,
  initStorage,
  space,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasFile, NodeContent } from './persistence-types.js';
import type {
  CanvasCommand,
  CanvasSyncEvent,
  GetCanvasResponse,
  PostCanvasExecuteResponse,
} from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';

const CANVAS = 'c1';
const PRINCIPAL = 'user:alice';
const PDF_TEXT = 'Extracted PDF text.\n\nSecond page of the extraction.\n';
const OFFICE_BODY = '---\ntitle: Deck\n---\n\n# Slide 1\r\nBody with a CR.\n';

const RECORDS: NodeContent[] = [
  { nodeId: 'note', type: 'note', label: 'Note', content: 'note body' },
  { nodeId: 'other', type: 'note', label: 'Other', content: 'other body' },
  {
    nodeId: 'pdf',
    type: 'pdf',
    label: 'Paper',
    content: PDF_TEXT,
    src: 'artifacts/paper.pdf',
    properties: { Venue: 'CHI 25' },
  },
  {
    nodeId: 'office',
    type: 'office',
    label: 'Deck',
    content: OFFICE_BODY,
    src: 'artifacts/deck.pptx',
  },
];

let tmp: string;
let previousDataDir: string | undefined;
let events: CanvasSyncEvent[];
let unsubscribe: () => void;

async function seed(): Promise<void> {
  const created = await createSpace(CANVAS, 'Revisions');
  if (!created.ok) throw new Error('Could not create the test Space');
  const next: CanvasFile = {
    ...created.record,
    version: 1,
    state: {
      nodes: RECORDS.map((record, index) => ({
        id: record.nodeId,
        type: record.type,
        position: { x: index * 300, y: 0 },
        style: { width: 200, height: 100 },
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

function run(
  commands: unknown[],
  extra: Partial<ExecuteOnServerInput> = {},
): Promise<ExecuteOnServerOutput> {
  return executeOnServer({
    canvasId: CANVAS,
    commands: commands as CanvasCommand[],
    originator: { source: 'ui' },
    ...extra,
  });
}

/** The revision a load of the Space reports for `nodeId`. */
async function storedRevision(nodeId: string): Promise<string> {
  const snapshot = await space(CANVAS).nodes.read(nodeId);
  return nodeRevisionOf(snapshot?.record ?? {});
}

function updates(): Array<Extract<CanvasSyncEvent, { type: 'update' }>> {
  return events.filter(
    (event): event is Extract<CanvasSyncEvent, { type: 'update' }> =>
      event.type === 'update',
  );
}

const mergeProperties = (nodeId: string, properties: object) => ({
  type: 'MERGE_NODE_DATA',
  patches: [{ nodeId, patch: { properties } }],
});

const mergeContent = (nodeId: string, content: string) => ({
  type: 'MERGE_NODE_DATA',
  patches: [{ nodeId, patch: { content } }],
});

const move = (nodeId: string, x: number) => ({
  type: 'SET_NODE_GEOMETRY',
  items: [{ nodeId, position: { x, y: 40 } }],
});

describe.each([['disk'], ['sqlite']] as const)(
  'content revisions of a committed batch (%s)',
  (backend) => {
    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'huabu-update-rev-'));
      previousDataDir = process.env.HUABU_DATA_DIR;
      if (backend === 'sqlite') {
        process.env.HUABU_DATA_DIR = join(tmp, 'data');
        await initStorage({
          structured: { kind: 'sqlite' },
          blobs: { kind: 'disk' },
        });
      } else {
        process.env.HUABU_DATA_DIR = tmp;
        setWorkspacePath(tmp);
      }
      await seed();
      events = [];
      unsubscribe = subscribeCanvasUpdates(CANVAS, (event) =>
        events.push(event),
      );
    });

    afterEach(async () => {
      unsubscribe();
      if (backend === 'sqlite') await closeStorage();
      if (previousDataDir === undefined) delete process.env.HUABU_DATA_DIR;
      else process.env.HUABU_DATA_DIR = previousDataDir;
      rmSync(tmp, { recursive: true, force: true });
    });

    it('names the stored revision of a note, a PDF and an Office node, and no node whose content it left alone', async () => {
      const output = await run([
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'note', patch: { content: 'rewritten' } }],
        },
        mergeProperties('pdf', { Venue: 'CHI 25', Status: 'Reading' }),
        mergeProperties('office', { Owner: 'Ada' }),
        move('other', 900),
      ]);
      expect(output.results.map((result) => result.applied)).toEqual([
        true,
        true,
        true,
        true,
      ]);

      const expected = {
        note: await storedRevision('note'),
        pdf: await storedRevision('pdf'),
        office: await storedRevision('office'),
      };
      expect(expected.note).toBe(
        nodeRevisionOf({ type: 'note', content: 'rewritten' }),
      );
      // The extracted text and the Office body are part of what is stored.
      expect(expected.pdf).toBe(
        nodeRevisionOf({
          type: 'pdf',
          content: PDF_TEXT,
          src: 'artifacts/paper.pdf',
        }),
      );
      expect(expected.office).toBe(
        nodeRevisionOf({
          type: 'office',
          content: OFFICE_BODY,
          src: 'artifacts/deck.pptx',
        }),
      );
      // `other` moved: it is in the deltas but not among the revisions.
      expect(
        output.deltas.some(
          (delta) => delta.type === 'REPLACE_NODE' && delta.next.id === 'other',
        ),
      ).toBe(true);
      expect(output.nodeContentRevisions).toEqual(expected);

      const [update] = updates();
      expect(update?.data.nodeContentRevisions).toEqual(expected);
    });

    it('carries no revisions for a batch that changes structure only', async () => {
      const output = await run([move('pdf', 500), move('note', 700)]);
      expect(output.toVersion).toBe(output.fromVersion + 1);
      expect(output).not.toHaveProperty('nodeContentRevisions');
      expect(updates()[0]?.data).not.toHaveProperty('nodeContentRevisions');
    });

    it('names a created node with the revision of the sidecar written for it', async () => {
      const output = await run([
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'fresh',
              nodeType: 'note',
              position: { x: 0, y: 600 },
              size: { width: 200, height: 100 },
              data: { label: 'Fresh', content: 'born with a body' },
            },
          ],
        },
      ]);
      expect(output.results[0]?.applied).toBe(true);
      expect(output.nodeContentRevisions).toEqual({
        fresh: await storedRevision('fresh'),
      });
      expect(output.nodeContentRevisions?.fresh).toBe(
        nodeRevisionOf({ type: 'note', content: 'born with a body' }),
      );
      expect(updates()[0]?.data.nodeContentRevisions).toEqual(
        output.nodeContentRevisions,
      );
    });

    it('answers a repeated request with the same revisions, also after the node was saved again', async () => {
      const request = { operationId: randomUUID(), principalId: PRINCIPAL };
      const pdfBefore = await storedRevision('pdf');
      const commands = [
        mergeProperties('pdf', { Venue: 'CHI 25', Status: 'Read' }),
        mergeContent('note', 'first text'),
      ];
      const first = await run(commands, { request });
      expect(first.nodeContentRevisions).toEqual({
        pdf: await storedRevision('pdf'),
        note: await storedRevision('note'),
      });
      // The PDF is named because its saved content changed, with the
      // revision it had: properties are not part of it.
      expect(first.nodeContentRevisions?.pdf).toBe(pdfBefore);

      // Another writer changes both nodes after the request was committed:
      // a property of the PDF (no new revision) and the note's body (one).
      await run([
        mergeProperties('pdf', { Venue: 'UIST 26' }),
        mergeContent('note', 'second text'),
      ]);
      expect(await storedRevision('pdf')).toBe(pdfBefore);
      expect(await storedRevision('note')).not.toBe(
        first.nodeContentRevisions?.note,
      );

      const replay = await run(commands, { request });
      expectReplayOf(first, replay);
      expect(replay.nodeContentRevisions).toEqual(first.nodeContentRevisions);
      // Only the two commits were published.
      expect(updates()).toHaveLength(2);
    });

    it('names the stored revision of what a delta replay (a Review revert) wrote', async () => {
      const forward = await run([
        mergeProperties('pdf', { Venue: 'CHI 25', Status: 'Reading' }),
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'note', patch: { content: 'agent text' } }],
        },
      ]);
      const before = { ...forward.nodeContentRevisions };
      const reverted = await applyDeltasOnServer({
        canvasId: CANVAS,
        deltas: forward.deltas
          .filter(
            (delta): delta is Extract<Delta, { type: 'REPLACE_NODE' }> =>
              delta.type === 'REPLACE_NODE',
          )
          .map((delta) => ({ ...delta, prev: delta.next, next: delta.prev })),
        originator: { source: 'ui' },
      });
      expect(reverted.toVersion).toBe(forward.toVersion + 1);
      const expected = {
        pdf: await storedRevision('pdf'),
        note: await storedRevision('note'),
      };
      expect(reverted.nodeContentRevisions).toEqual(expected);
      // Taking the properties back leaves the PDF's revision where it was;
      // taking the text back moves the note's.
      expect(expected.pdf).toBe(before.pdf);
      expect(expected.note).not.toBe(before.note);
      expect(expected.note).toBe(
        nodeRevisionOf({ type: 'note', content: 'note body' }),
      );
    });
  },
);

describe('content revisions over HTTP', () => {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'huabu-update-rev-http-'));
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

  async function buildApp() {
    const app = fastify();
    await app.register(canvasRoutes, { prefix: '/canvas' });
    await app.ready();
    return app;
  }

  it('returns them from POST /execute, equal to what a load reports, and a save quoting one is accepted', async () => {
    const app = await buildApp();
    try {
      const executed = await app.inject({
        method: 'POST',
        url: `/canvas/${CANVAS}/execute`,
        payload: {
          edits: editsPerCommand([
            mergeProperties('pdf', { Venue: 'CHI 25', Status: 'Reading' }),
            move('note', 640),
          ]),
        },
      });
      expect(executed.statusCode).toBe(200);
      const response = executed.json<PostCanvasExecuteResponse>();
      expect(Object.keys(response.nodeContentRevisions ?? {})).toEqual(['pdf']);

      const loaded = (
        await app.inject({ method: 'GET', url: `/canvas/${CANVAS}` })
      ).json<GetCanvasResponse>();
      expect(response.nodeContentRevisions?.pdf).toBe(
        loaded.nodeContentRevisions?.pdf,
      );
      expect(updates()[0]?.data.nodeContentRevisions).toEqual(
        response.nodeContentRevisions,
      );
      // A page shows the PDF as a load delivers it, without the extracted
      // text; a revision hashed from that node is not the stored one.
      const shown = (
        loaded.state as {
          nodes: Array<{ id: string; data: Record<string, unknown> }>;
        }
      ).nodes.find((node) => node.id === 'pdf');
      expect(shown?.data).not.toHaveProperty('content');
      expect(nodeRevisionOf({ ...shown?.data, type: 'pdf' })).not.toBe(
        response.nodeContentRevisions?.pdf,
      );

      // A save that quotes the revision the update brought is accepted (a
      // PDF's extracted text is last-writer-wins and its properties are
      // unversioned, so no revision could refuse it).
      const saved = await app.inject({
        method: 'PUT',
        url: `/canvas/${CANVAS}/nodes/pdf/content`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          nodeType: 'pdf',
          content: PDF_TEXT,
          properties: { Status: 'Read' },
          expectRev: response.nodeContentRevisions?.pdf,
        }),
      });
      expect(saved.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
