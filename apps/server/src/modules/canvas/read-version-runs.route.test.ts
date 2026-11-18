// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Read versions of a browser page on `POST /api/canvas/:canvasId/execute`.
 *
 * A page loads the Space (`basis` of `GET /api/canvas/:canvasId`), and sends
 * every edit with the version the edit was made on (its `basis`). The
 * server refuses an edit whose node was deleted (`stale-target`) or moved
 * into or out of a container (`stale-parent`) by someone else after that
 * version, as a whole — and does not hold a page's own committed changes
 * against it. "The same page" is the authenticated principal together with
 * the page id.
 *
 * Exercised through Fastify `inject()` on the Disk backend, so the body
 * schema, the route's checks, the executor and the stored stamps are covered
 * together.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { editsPerCommand, encodeBasis, parseBasis } from '@huabu/shared';

import canvasRoutes from './canvas.route.js';
import { setRequestIdentity } from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { getCanvasStore, space } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

const CANVAS = 'c1';
const N = 'node-n';
const INSIDE = 'node-inside';
const F = 'node-f';
const G = 'node-g';

const ALICE = 'user:alice';
const BOB = 'user:bob';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

/** The principal is the transport's: here, whoever the test header names. */
async function buildApp() {
  const instance = fastify();
  instance.addHook('onRequest', async (request) => {
    const principalId = request.headers['x-test-principal'];
    if (typeof principalId !== 'string') return;
    setRequestIdentity(request, {
      principal: { principalId, kind: 'user', displayName: principalId },
      member: true,
      owner: true,
      access: UNRESTRICTED_ACCESS,
    });
  });
  await instance.register(canvasRoutes, { prefix: '/canvas' });
  await instance.ready();
  return instance;
}

const note = (id: string, x: number, y: number, parentId?: string) => ({
  id,
  type: 'note',
  position: { x, y },
  style: { width: 100, height: 60 },
  ...(parentId ? { parentId } : {}),
  data: { label: id, heightMode: 'fixed' },
});
const frame = (id: string, x: number) => ({
  id,
  type: 'frame',
  position: { x, y: 0 },
  style: { width: 220, height: 225 },
  data: { label: id, sizing: 'hug' },
});

/** N on the canvas, INSIDE within the hug Frame F, G empty. */
function seed(): void {
  getCanvasStore(CANVAS).write({
    canvasId: CANVAS,
    title: null,
    version: 1,
    state: {
      nodes: [
        note(N, 600, 600),
        frame(F, 0),
        note(INSIDE, 20, 60, F),
        frame(G, 1200),
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

const move = (id: string, x: number, y: number) => ({
  type: 'SET_NODE_GEOMETRY',
  items: [{ nodeId: id, position: { x, y } }],
});
const resize = (id: string, width: number) => ({
  type: 'SET_NODE_GEOMETRY',
  items: [{ nodeId: id, size: { width } }],
});
const reparent = (id: string, parentId: string | null) => ({
  type: 'SET_NODE_PARENT',
  nodeIds: [id],
  parentId,
});
const remove = (id: string) => ({ type: 'DELETE_NODES', nodeIds: [id] });
const create = (id: string) => ({
  type: 'CREATE_NODES',
  nodes: [
    {
      id,
      nodeType: 'note',
      position: { x: 50, y: 900 },
      data: { content: 'new' },
    },
  ],
});

interface EditSpec {
  basis?: string;
  after?: Array<{ operationId?: string; edit: number }>;
  commands: unknown[];
}

interface EditAnswer {
  applied: boolean;
  reason?: string;
  failedAt?: number;
  results: Array<{ applied: boolean; reason?: string }>;
}

/**
 * One browser page: it has a principal and a page id, has applied the Space
 * up to `version`, and sends every edit with a request id and the read
 * version it was made on.
 */
class Page {
  lineage = '';
  version = 0;

  constructor(
    readonly principalId: string,
    readonly pageId: string,
  ) {}

  /** `GET /api/canvas/:id`: the page now shows the Space as it is. */
  async load(): Promise<this> {
    const response = await app.inject({
      method: 'GET',
      url: `/canvas/${CANVAS}`,
      headers: { 'x-test-principal': this.principalId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const basis = parseBasis(body.basis);
    if (!basis) throw new Error('The load carried no read version');
    this.lineage = basis.lineage;
    this.version = body.version;
    return this;
  }

  /** The read version of what this page has applied. */
  get basis(): string {
    return encodeBasis(this.lineage, this.version);
  }

  /** Send `edits` as one request. */
  sendEdits(edits: EditSpec[], options: { operationId?: string } = {}) {
    return app.inject({
      method: 'POST',
      url: `/canvas/${CANVAS}/execute`,
      headers: { 'x-test-principal': this.principalId },
      payload: {
        originator: { tabId: this.pageId },
        operationId: options.operationId ?? randomUUID(),
        edits,
      },
    });
  }

  /** Send `commands` as one edit made on what the page shows. */
  send(commands: unknown[], options: { operationId?: string } = {}) {
    return this.sendEdits([{ basis: this.basis, commands }], options);
  }

  /**
   * {@link sendEdits}, answered: per command, in request order, the reason,
   * or `applied` for a taken command.
   */
  async edits(
    edits: EditSpec[],
    options: { operationId?: string } = {},
  ): Promise<string[]> {
    const response = await this.sendEdits(edits, options);
    expect(response.statusCode).toBe(200);
    const answers = response.json().edits as EditAnswer[];
    // Each edit of the request is answered, each of its commands in it.
    expect(answers.map((answer) => answer.results.length)).toEqual(
      edits.map((edit) => edit.commands.length),
    );
    return answers.flatMap((answer) =>
      answer.results.map((result) =>
        result.applied ? 'applied' : (result.reason ?? 'refused'),
      ),
    );
  }

  /** {@link send}, answered like {@link edits}. */
  edit(
    commands: unknown[],
    options: { operationId?: string } = {},
  ): Promise<string[]> {
    return this.edits([{ basis: this.basis, commands }], options);
  }

  /** The page has applied every update up to the head. */
  catchUp(): this {
    this.version = version();
    return this;
  }
}

interface StoredNode {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
  style?: { width?: number; height?: number };
}
const storedNodes = (): StoredNode[] =>
  (getCanvasStore(CANVAS).read()?.state.nodes ?? []) as StoredNode[];
const stored = (id: string): StoredNode => {
  const node = storedNodes().find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Missing node ${id}`);
  return node;
};
const version = (): number => getCanvasStore(CANVAS).read()?.version ?? -1;
const stamp = async (id: string) =>
  (await space(CANVAS).save.stamps())?.nodes[id];

let a: Page;
let b: Page;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-read-version-runs-'));
  setWorkspacePath(tmp);
  seed();
  app = await buildApp();
  // Two devices of two people; both have loaded the Space at version 1.
  a = await new Page(ALICE, 'page-a').load();
  b = await new Page(BOB, 'page-b').load();
});

afterEach(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the read version a page gets and sends', () => {
  it('the load carries the basis of the version it returns, and creates the baseline', async () => {
    expect(a.version).toBe(1);
    expect(a.lineage).toBe(b.lineage);
    await expect(space(CANVAS).save.stamps()).resolves.toMatchObject({
      lineage: a.lineage,
      floor: 1,
      version: 1,
      nodes: {},
    });
  });

  it('answers a request that states a read version with the read version it left', async () => {
    const response = await a.send([move(N, 700, 650)]);
    expect(response.json()).toMatchObject({
      toVersion: 2,
      basis: encodeBasis(a.lineage, 2),
    });
  });

  it('refuses the whole request, applying nothing, for a basis of another lineage', async () => {
    const response = await a.sendEdits([
      { basis: encodeBasis(randomUUID(), 1), commands: [move(N, 700, 650)] },
    ]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'basis-unknown' });
    expect(stored(N).position).toEqual({ x: 600, y: 600 });
    expect(version()).toBe(1);
    // The load is how the page gets a basis the server knows.
    await a.load();
    expect(await a.edit([move(N, 700, 650)])).toEqual(['applied']);
  });

  it('refuses a basis newer than the head', async () => {
    a.version = 5;
    expect((await a.send([move(N, 1, 1)])).statusCode).toBe(409);
  });

  it('rejects a request that is not a list of well-formed edits', async () => {
    const raw = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/canvas/${CANVAS}/execute`,
        headers: { 'x-test-principal': ALICE },
        payload,
      });
    // The former shape — top-level commands, with or without runs — is not
    // a request any more.
    const formerRuns = await raw({
      commands: [move(N, 1, 1)],
      runs: [{ start: 0, count: 1, basis: a.basis }],
    });
    expect(formerRuns.statusCode).toBe(400);
    const formerCommands = await raw({
      commands: [move(N, 1, 1)],
      basis: a.basis,
    });
    expect(formerCommands.statusCode).toBe(400);
    // A request holds an edit, and an edit holds a command.
    expect((await raw({ edits: [] })).statusCode).toBe(400);
    const empty = await a.sendEdits([{ basis: a.basis, commands: [] }]);
    expect(empty.statusCode).toBe(400);
    // A run is no part of an edit.
    const strayRun = await raw({
      edits: [
        { start: 0, count: 1, basis: a.basis, commands: [move(N, 1, 1)] },
      ],
    });
    expect(strayRun.statusCode).toBe(400);
    // An edit can only be made on top of an earlier edit of the request.
    const forward = await a.sendEdits([
      { basis: a.basis, after: [{ edit: 1 }], commands: [move(N, 1, 1)] },
      { basis: a.basis, commands: [move(N, 2, 2)] },
    ]);
    expect(forward.statusCode).toBe(400);
    expect(forward.json().message).toMatch(/earlier edit/);
    const onItself = await a.sendEdits([
      { basis: a.basis, after: [{ edit: 0 }], commands: [move(N, 1, 1)] },
    ]);
    expect(onItself.statusCode).toBe(400);
    expect(onItself.json().message).toMatch(/earlier edit/);
    const malformed = await raw({
      edits: [{ basis: 1, commands: [move(N, 1, 1)] }],
    });
    expect(malformed.statusCode).toBe(400);
    const malformedAfter = await raw({
      edits: [
        { basis: a.basis, commands: [move(N, 1, 1)] },
        { basis: a.basis, after: [{}], commands: [move(N, 2, 2)] },
      ],
    });
    expect(malformedAfter.statusCode).toBe(400);
    expect(stored(N).position).toEqual({ x: 600, y: 600 });
    expect(version()).toBe(1);
  });

  it('executes edits without a read version unchecked, and as nobody’s change', async () => {
    const plain = (commands: unknown[]) =>
      app.inject({
        method: 'POST',
        url: `/canvas/${CANVAS}/execute`,
        headers: { 'x-test-principal': ALICE },
        payload: {
          edits: editsPerCommand(commands),
          originator: { tabId: 'page-a' },
        },
      });
    await plain([reparent(N, F)]);
    const response = await plain([move(N, 30, 150)]);
    expect(response.json().edits).toMatchObject([
      { applied: true, results: [{ applied: true }] },
    ]);
    // Read as Frame-local: the behaviour callers without the field keep.
    expect(stored(N).parentId).toBe(F);
    expect(await stamp(N)).toEqual({ created: 1, membership: 2 });
  });
});

describe('an edit against what another page committed first', () => {
  it('refuses a canvas move committed after another page dragged the node into a Frame', async () => {
    expect(await a.edit([reparent(N, F)])).toEqual(['applied']);
    const afterA = {
      n: structuredClone(stored(N)),
      frame: structuredClone(stored(F)),
      version: version(),
    };
    expect(afterA.n.parentId).toBe(F);

    // Page B had not heard of it: a plain move, in canvas coordinates.
    const second = await b.send([move(N, 620, 820)]);
    expect(second.statusCode).toBe(200);
    const body = second.json();
    // The edit is refused for its read version: no command of it failed.
    expect(body.edits).toEqual([
      {
        applied: false,
        reason: 'stale-parent',
        results: [{ applied: false, reason: 'stale-parent' }],
      },
    ]);
    expect(body.toVersion).toBe(body.fromVersion);
    expect(body.deltas).toEqual([]);
    // A's edit stands: not B's coordinates read as Frame-local, and the hug
    // Frame did not grow.
    expect(stored(N)).toEqual(afterA.n);
    expect(stored(F)).toEqual(afterA.frame);
    expect(version()).toBe(afterA.version);
    // Having read it, B's edit is taken.
    expect(await b.catchUp().edit([move(N, 30, 150)])).toEqual(['applied']);
  });

  it('refuses a move inside a Frame committed after another page dragged the node out (the mirror case)', async () => {
    expect(await a.edit([reparent(INSIDE, null)])).toEqual(['applied']);
    const afterA = structuredClone(stored(INSIDE));
    expect(afterA.parentId).toBeUndefined();
    expect(await b.edit([move(INSIDE, 40, 120)])).toEqual(['stale-parent']);
    expect(stored(INSIDE)).toEqual(afterA);
  });

  it('refuses the later of two drags of one node into different Frames, with its position', async () => {
    expect(await a.edit([reparent(N, F), move(N, 20, 150)])).toEqual([
      'applied',
      'applied',
    ]);
    const afterA = structuredClone(stored(N));
    // Without the read version the second batch would move N from F into G.
    expect(await b.edit([reparent(N, G), move(N, 30, 70)])).toEqual([
      'stale-parent',
      'stale-parent',
    ]);
    expect(stored(N)).toEqual(afterA);
    expect(stored(N).parentId).toBe(F);
  });

  it('refuses a move of a node another page moved out of its Frame and back in: it is where it was, but not as this page read it', async () => {
    await a.edit([reparent(INSIDE, null)]);
    await a.catchUp().edit([reparent(INSIDE, F)]);
    expect(stored(INSIDE).parentId).toBe(F);
    const afterA = structuredClone(stored(INSIDE));
    expect(await b.edit([move(INSIDE, 40, 120)])).toEqual(['stale-parent']);
    expect(stored(INSIDE)).toEqual(afterA);
  });

  it('refuses an edit whose node another page deleted, with stale-target', async () => {
    expect(await a.edit([remove(N)])).toEqual(['applied']);
    expect(await b.edit([move(N, 1, 1)])).toEqual(['stale-target']);
    expect(await b.edit([reparent(N, F), move(N, 1, 1)])).toEqual([
      'stale-target',
      'stale-target',
    ]);
    expect(storedNodes().some((node) => node.id === N)).toBe(false);
  });

  it('refuses an edit of a node another page created after the version', async () => {
    await a.edit([create('node-new')]);
    // B names an id it cannot have seen at version 1.
    expect(await b.edit([move('node-new', 1, 1)])).toEqual(['stale-target']);
    expect(await b.catchUp().edit([move('node-new', 1, 1)])).toEqual([
      'applied',
    ]);
  });

  it('refuses one edit and applies the other edits of the same request', async () => {
    await a.edit([reparent(N, F)]);
    expect(
      await b.edits([
        { basis: b.basis, commands: [move(N, 620, 820)] },
        { basis: b.basis, commands: [move(INSIDE, 25, 65)] },
      ]),
    ).toEqual(['stale-parent', 'applied']);
    expect(stored(N).parentId).toBe(F);
  });

  it('refuses a whole edit, also the commands whose own nodes are current', async () => {
    await a.edit([reparent(N, F)]);
    const inside = structuredClone(stored(INSIDE));
    expect(
      await b.edit([
        reparent(INSIDE, G),
        move(N, 700, 700),
        { type: 'MERGE_NODE_DATA', patches: [{ nodeId: INSIDE, patch: {} }] },
      ]),
    ).toEqual(['stale-parent', 'stale-parent', 'stale-parent']);
    expect(stored(INSIDE)).toEqual(inside);
  });

  it('takes edits of other nodes, of other properties, and a size', async () => {
    await a.edit([reparent(N, F)]);
    // Another node; a data key of the same node; its size alone.
    expect(await b.edit([move(INSIDE, 25, 65)])).toEqual(['applied']);
    expect(
      await b.edit([
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: N, patch: { style: { accent: 'blue' } } }],
        },
      ]),
    ).toEqual(['applied']);
    expect(await b.edit([resize(N, 140)])).toEqual(['applied']);
    expect(stored(N).parentId).toBe(F);
    expect(stored(N).style?.width).toBe(140);
  });
});

describe("a page's own committed change is not held against it", () => {
  it('own: consecutive drags sent before the first is confirmed are all taken', async () => {
    expect(await a.edit([reparent(N, F)])).toEqual(['applied']);
    expect(await stamp(N)).toMatchObject({ membership: 2 });
    expect((await stamp(N))?.membershipBy).toBeTruthy();
    // Still quoting version 1: the page has not applied its own update yet.
    expect(a.version).toBe(1);
    expect(await a.edit([move(N, 30, 150)])).toEqual(['applied']);
    expect(await a.edit([reparent(N, G), move(N, 10, 70)])).toEqual([
      'applied',
      'applied',
    ]);
    expect(stored(N).parentId).toBe(G);
  });

  it('own creation: a node this page created after its version is its to edit', async () => {
    expect(await a.edit([create('node-new')])).toEqual(['applied']);
    expect(await a.edit([move('node-new', 5, 5)])).toEqual(['applied']);
    expect(await a.edit([reparent('node-new', F)])).toEqual(['applied']);
  });

  it('foreign then own: refused until the page has read the foreign change', async () => {
    await b.edit([reparent(N, F)]);
    expect(await a.edit([move(N, 700, 700)])).toEqual(['stale-parent']);
    expect(await a.catchUp().edit([move(N, 30, 150)])).toEqual(['applied']);
  });

  it('own then foreign: the foreign change after its own is what refuses it', async () => {
    await a.edit([reparent(N, F)]); // version 2, A's
    await b.catchUp().edit([reparent(N, G)]); // version 3, B's
    expect(await a.edit([move(N, 30, 150)])).toEqual(['stale-parent']);
    // Having applied its own update (2) is not having read B's (3).
    a.version = 2;
    expect(await a.edit([move(N, 30, 150)])).toEqual(['stale-parent']);
    expect(stored(N).parentId).toBe(G);
  });

  it('own, foreign, own: its second change exists only if it had read the foreign one, so nothing hides before it', async () => {
    await a.edit([reparent(N, F)]); // 2, A's
    await b.catchUp().edit([reparent(N, G)]); // 3, B's
    a.version = 2;
    expect(await a.edit([reparent(N, null)])).toEqual(['stale-parent']);
    // Read, then changed again: version 4 is A's.
    expect(await a.catchUp().edit([reparent(N, null)])).toEqual(['applied']);
    // Sent before that is confirmed, still quoting 3.
    expect(await a.edit([move(N, 640, 640)])).toEqual(['applied']);
    expect(stored(N).position).toEqual({ x: 640, y: 640 });
  });

  it("another page of the same person is another page: its change is foreign to this one, and this one's to it", async () => {
    const phone = await new Page(ALICE, 'page-phone').load();
    await a.edit([reparent(N, F)]);
    expect(await phone.edit([move(N, 700, 700)])).toEqual(['stale-parent']);
    expect(await a.edit([move(N, 30, 150)])).toEqual(['applied']);
  });

  it('another person using the same page id is another page', async () => {
    const mallory = await new Page(BOB, 'page-a').load();
    await a.edit([reparent(N, F)]);
    expect(await mallory.edit([move(N, 700, 700)])).toEqual(['stale-parent']);
  });

  it('a reloaded page has a new page id: what the old page sent is not held to be its own, and is not held against it', async () => {
    // The old page's last request commits around the reload.
    await a.edit([reparent(N, F)]); // version 2, by page-a
    // Reloaded before that commit was read (a load that raced it): refused,
    // because the new page shows N on the canvas.
    const early = new Page(ALICE, 'page-a-reloaded');
    early.lineage = a.lineage;
    early.version = 1;
    expect(await early.edit([move(N, 700, 700)])).toEqual(['stale-parent']);
    // Reloaded after it: the load returned it, so it is simply read.
    const late = await new Page(ALICE, 'page-a-reloaded-2').load();
    expect(late.version).toBe(2);
    expect(await late.edit([move(N, 30, 150)])).toEqual(['applied']);
  });

  it('does not credit a page with a move it only caused: a child it had not seen in the Frame it dissolves', async () => {
    await b.edit([reparent(N, F)]); // 2: N in F, unseen by A
    expect(await a.edit([{ type: 'DISSOLVE_FRAME', frameId: F }])).toEqual([
      'applied',
    ]); // 3
    expect(stored(N).parentId).toBeUndefined();
    // INSIDE, which A had seen in F, left it by A's hand; N did not.
    expect((await stamp(INSIDE))?.membershipBy).toBeTruthy();
    expect(await stamp(N)).toEqual({ created: 1, membership: 3 });
    expect(await a.edit([move(N, 5, 5)])).toEqual(['stale-parent']);
    expect(await a.edit([move(INSIDE, 5, 5)])).toEqual(['applied']);
  });
});

describe('an edit made on top of an earlier, unconfirmed one', () => {
  const groupThenMove = (page: Page) =>
    page.edits([
      { basis: page.basis, commands: [reparent(N, G)] },
      { basis: page.basis, commands: [move(INSIDE, 25, 65)] },
      { basis: page.basis, after: [{ edit: 0 }], commands: [move(N, 10, 70)] },
    ]);

  it('is taken when the one it was made on was', async () => {
    expect(await groupThenMove(a)).toEqual(['applied', 'applied', 'applied']);
    expect(stored(N).parentId).toBe(G);
  });

  it('is refused when the one it was made on was refused, although nobody touched its node; the unrelated edit is taken', async () => {
    // G is gone, so the drag into it is refused — and N never moved.
    await b.edit([remove(G)]);
    const before = structuredClone(stored(N));
    expect(await groupThenMove(a)).toEqual([
      'stale-target',
      'applied',
      'stale-parent',
    ]);
    // Not G-local coordinates on the canvas.
    expect(stored(N)).toEqual(before);
  });

  it('looks an edit of an earlier request up in that request’s stored answer', async () => {
    await b.edit([remove(G)]);
    const first = randomUUID();
    expect(await a.edit([reparent(N, G)], { operationId: first })).toEqual([
      'stale-target',
    ]);
    const before = structuredClone(stored(N));
    /** `command`, made on top of the first edit of request `operationId`. */
    const onTop = (operationId: string, command: unknown): EditSpec[] => [
      {
        basis: a.basis,
        after: [{ operationId, edit: 0 }],
        commands: [command],
      },
    ];
    // Made on the refused drag: refused too.
    expect(await a.edits(onTop(first, move(N, 10, 70)))).toEqual([
      'stale-parent',
    ]);
    expect(stored(N)).toEqual(before);
    // Made on a request the server has no answer for: refused as well.
    expect(await a.edits(onTop(randomUUID(), move(N, 10, 70)))).toEqual([
      'stale-parent',
    ]);
    // Another caller's request id is not this caller's request.
    const theirs = randomUUID();
    await b.catchUp().edit([move(INSIDE, 25, 65)], { operationId: theirs });
    expect(await a.edits(onTop(theirs, move(N, 10, 70)))).toEqual([
      'stale-parent',
    ]);
    // Made on one that was taken: taken.
    const taken = randomUUID();
    expect(await a.edit([reparent(N, F)], { operationId: taken })).toEqual([
      'applied',
    ]);
    expect(await a.edits(onTop(taken, move(N, 30, 150)))).toEqual(['applied']);
  });

  it('answers a repeated request from the stored refusal, and treats another read version as another request', async () => {
    await b.edit([reparent(N, F)]);
    const operationId = randomUUID();
    const first = await a.send([move(N, 620, 820)], { operationId });
    expect(first.json().edits).toMatchObject([
      {
        applied: false,
        reason: 'stale-parent',
        results: [{ applied: false, reason: 'stale-parent' }],
      },
    ]);
    const again = await a.send([move(N, 620, 820)], { operationId });
    expect(again.json()).toMatchObject({
      replayed: true,
      edits: [
        {
          applied: false,
          reason: 'stale-parent',
          results: [{ applied: false, reason: 'stale-parent' }],
        },
      ],
    });
    const other = await a.catchUp().send([move(N, 620, 820)], { operationId });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'operation-id-reused' });
  });
});

describe('an edit takes effect as a whole', () => {
  it('undoes the commands of an edit when one of them fails, and applies the other edits', async () => {
    const response = await a.sendEdits([
      // The move is fine on its own; a node cannot be its own parent.
      { basis: a.basis, commands: [move(N, 700, 700), reparent(N, N)] },
      { basis: a.basis, commands: [move(INSIDE, 25, 65)] },
    ]);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.edits).toEqual([
      {
        applied: false,
        reason: 'invalid-parent',
        failedAt: 1,
        results: [
          { applied: false },
          { applied: false, reason: 'invalid-parent' },
        ],
      },
      { applied: true, results: [{ applied: true }] },
    ]);
    // Not the move alone, as a command list would have left it.
    expect(stored(N).position).toEqual({ x: 600, y: 600 });
    expect(stored(N).parentId).toBeUndefined();
    const changed = (body.deltas as Array<{ next?: { id?: string } }>).map(
      (delta) => delta.next?.id,
    );
    expect(changed).not.toContain(N);
    // The second edit is what the request committed (F hugs INSIDE).
    expect(changed).toContain(INSIDE);
    expect(body.toVersion).toBe(2);
    expect(version()).toBe(2);
  });
});
