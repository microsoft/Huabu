// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { postCanvasExecuteBodySchema } from '../../types/api/canvas.js';
import {
  advanceNodeStamps,
  commandReadTargets,
  createReadVersionAdmission,
  executeCanvasEdits,
  type NodeStamp,
} from '../index.js';

import type { CanvasCommand } from '../../types/canvas/index.js';
import type { CanvasNode } from '../interfaces.js';

const N = 'node-n';
const M = 'node-m';
const F = 'node-f';
const G = 'node-g';

/** Two pages of one person and a page of another: all three are different. */
const A = 'page-a';
const B = 'page-b';

function note(id: string, x: number, y: number, parentId?: string): CanvasNode {
  return {
    id,
    type: 'note',
    position: { x, y },
    style: { width: 100, height: 60 },
    ...(parentId ? { parentId } : {}),
    data: { type: 'note', label: id, heightMode: 'fixed' },
  } as CanvasNode;
}

function frame(id: string, x: number): CanvasNode {
  return {
    id,
    type: 'frame',
    position: { x, y: 0 },
    style: { width: 300, height: 300 },
    data: { type: 'frame', label: id, sizing: 'manual' },
  } as CanvasNode;
}

const move = (id: string, x: number, y: number): CanvasCommand =>
  ({
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: id, position: { x, y } }],
  }) as unknown as CanvasCommand;
const resize = (id: string, width: number): CanvasCommand =>
  ({
    type: 'SET_NODE_GEOMETRY',
    items: [{ nodeId: id, size: { width } }],
  }) as unknown as CanvasCommand;
const reparent = (id: string, parentId: string | null): CanvasCommand =>
  ({
    type: 'SET_NODE_PARENT',
    nodeIds: [id],
    parentId,
  }) as unknown as CanvasCommand;
const recolour = (id: string): CanvasCommand =>
  ({
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId: id, patch: { style: { accent: 'blue' } } }],
  }) as unknown as CanvasCommand;
const remove = (id: string): CanvasCommand =>
  ({ type: 'DELETE_NODES', nodeIds: [id] }) as unknown as CanvasCommand;
const create = (id: string): CanvasCommand =>
  ({
    type: 'CREATE_NODES',
    nodes: [
      { id, nodeType: 'note', position: { x: 0, y: 0 }, data: { content: '' } },
    ],
  }) as unknown as CanvasCommand;
const dissolve = (id: string): CanvasCommand =>
  ({ type: 'DISSOLVE_FRAME', frameId: id }) as unknown as CanvasCommand;

/**
 * A Space as the server keeps it for this check: the nodes, the version and
 * the per-node stamps, advanced by every write with the shared rules.
 */
class Space {
  nodes: CanvasNode[];
  version = 10;
  stamps: Readonly<Record<string, NodeStamp>> = {};
  readonly floor = 10;

  /** N on the canvas, M inside F, G empty. */
  constructor(
    nodes: CanvasNode[] = [
      note(N, 500, 500),
      frame(F, 0),
      note(M, 20, 40, F),
      frame(G, 1000),
    ],
  ) {
    this.nodes = nodes;
  }

  /**
   * One request. `read` is a version for the whole batch — the legacy
   * `{ commands, basis }` form, one edit per command — or the edits
   * themselves; omitted, nothing is checked (one edit per command).
   */
  write(
    commands: CanvasCommand[],
    read?: number | TestEdit[],
    page?: string,
  ): string[] {
    const edits: TestEdit[] =
      typeof read === 'object'
        ? read
        : commands.map((command) => ({
            commands: [command],
            ...(read === undefined ? {} : { version: read }),
          }));
    const stamps = { floor: this.floor, nodes: this.stamps };
    const admission =
      read === undefined
        ? null
        : createReadVersionAdmission({
            edits,
            stamps,
            prestateNodes: this.nodes,
            ...(page ? { page } : {}),
          });
    const out = executeCanvasEdits(
      { source: 'ui', edits },
      { nodes: this.nodes, edges: [], canvasId: 'c1' },
      admission ? { admitEdit: admission.admitEdit } : {},
    );
    const next = out.writeResult.nodes;
    if (next !== this.nodes) {
      this.version += 1;
      const checked = edits.every((edit) => edit.version !== undefined);
      this.stamps = advanceNodeStamps(
        stamps,
        this.nodes,
        next,
        this.version,
        page && admission && checked
          ? { by: page, except: admission.unseenMoves(next) }
          : undefined,
      );
      this.nodes = next;
    }
    return out.commandResults.map((result) =>
      result.applied ? 'applied' : (result.reason ?? 'not-applied'),
    );
  }

  /** A page's edit: all the commands, one read version. */
  edit(page: string, version: number, commands: CanvasCommand[]): string[] {
    return this.write(commands, [{ commands, version }], page);
  }

  node(id: string): CanvasNode | undefined {
    return this.nodes.find((node) => node.id === id);
  }
}

interface TestEdit {
  commands: CanvasCommand[];
  version?: number;
  after?: number[];
  blocked?: boolean;
}

describe('commandReadTargets — the one list for agents and pages', () => {
  it('checks the parent only of geometry items that carry a position', () => {
    expect(
      commandReadTargets({
        type: 'SET_NODE_GEOMETRY',
        items: [
          { nodeId: N, position: { x: 1, y: 2 } },
          // A size means the same in any container.
          { nodeId: M, size: { width: 10 } },
        ],
      } as unknown as CanvasCommand),
    ).toEqual({ existence: [N, M], membership: [N] });
  });

  it('checks the parent of the nodes a Frame layout places, not of the Frame', () => {
    expect(
      commandReadTargets({
        type: 'SET_FRAME_LAYOUT',
        frameId: F,
        mode: 'grid',
        cells: [{ nodeId: M, column: 1, row: 0 }],
      } as unknown as CanvasCommand),
    ).toEqual({ existence: [F, M], membership: [M] });
    expect(
      commandReadTargets({
        type: 'SET_FRAME_LAYOUT',
        frameId: F,
        mode: 'column',
        placements: [{ nodeId: M, after: N }],
      } as unknown as CanvasCommand),
    ).toEqual({ existence: [F, M, N], membership: [M, N] });
  });

  it('keeps the other commands as they were', () => {
    expect(commandReadTargets(reparent(N, F))).toEqual({
      existence: [N, F],
      membership: [N],
    });
    expect(
      commandReadTargets({
        type: 'REORDER_NODES',
        nodeIds: [N],
        to: { after: M },
      } as unknown as CanvasCommand),
    ).toEqual({ existence: [N, M], membership: [N, M] });
    expect(
      commandReadTargets({
        type: 'ALIGN_NODES',
        nodeIds: [N, M],
        direction: 'left',
      } as unknown as CanvasCommand),
    ).toEqual({ existence: [N, M], membership: [N, M] });
    expect(commandReadTargets(recolour(N))).toEqual({
      existence: [N],
      membership: [],
    });
    expect(commandReadTargets(remove(N))).toEqual({
      existence: [N],
      membership: [],
    });
    expect(commandReadTargets(create(N))).toEqual({
      existence: [],
      membership: [],
    });
  });
});

describe('advanceNodeStamps', () => {
  const prev = {
    floor: 3,
    nodes: { [M]: { created: 4, membership: 6, membershipBy: A } },
  };

  it('names the author on what a write creates and re-parents', () => {
    const next = advanceNodeStamps(
      prev,
      [note(N, 0, 0), note(M, 0, 0, F), frame(F, 0)],
      [note(N, 0, 0, F), note(M, 0, 0, F), frame(F, 0), note('node-new', 0, 0)],
      7,
      { by: B },
    );
    expect(next).toEqual({
      [M]: { created: 4, membership: 6, membershipBy: A },
      [N]: { created: 3, membership: 7, membershipBy: B },
      'node-new': { created: 7, membership: 7, createdBy: B, membershipBy: B },
    });
  });

  it('names nobody without an author, and forgets who moved the node before', () => {
    const next = advanceNodeStamps(
      prev,
      [note(M, 0, 0, F), frame(F, 0)],
      [note(M, 0, 0), frame(F, 0)],
      7,
    );
    expect(next[M]).toEqual({ created: 4, membership: 7 });
  });

  it('does not name the author for a node it is told the author had not seen', () => {
    const next = advanceNodeStamps(
      prev,
      [note(M, 0, 0, F), frame(F, 0)],
      [note(M, 0, 0), frame(F, 0)],
      7,
      { by: B, except: new Set([M]) },
    );
    expect(next[M]).toEqual({ created: 4, membership: 7 });
  });

  it('returns the very map it was given when nothing about existence or membership changed', () => {
    const nodes = [note(M, 0, 0, F), frame(F, 0)];
    expect(
      advanceNodeStamps(prev, nodes, [note(M, 9, 9, F), frame(F, 0)], 7, {
        by: B,
      }),
    ).toBe(prev.nodes);
  });

  it('drops the stamp of a removed node, so the id is new when it comes back', () => {
    const gone = advanceNodeStamps(prev, [note(M, 0, 0, F)], [], 7, { by: B });
    expect(gone).toEqual({});
    const back = advanceNodeStamps(
      { floor: 3, nodes: gone },
      [],
      [note(M, 0, 0)],
      8,
    );
    expect(back[M]).toEqual({ created: 8, membership: 8 });
  });
});

describe('one read version for the whole batch (an agent)', () => {
  it('refuses, per command, a target deleted or re-parented after the version', () => {
    const space = new Space();
    space.write([reparent(N, F)]); // version 11, by nobody
    space.write([remove(M)]); // version 12
    expect(
      space.write([move(N, 5, 5), recolour(M), recolour(F), move(F, 9, 9)], 10),
    ).toEqual(['stale-parent', 'stale-target', 'applied', 'applied']);
  });

  it('refuses a target created after the version', () => {
    const space = new Space();
    space.write([create('node-late')]); // version 11
    expect(space.write([recolour('node-late')], 10)).toEqual(['stale-target']);
    expect(space.write([recolour('node-late')], 11)).toEqual(['applied']);
  });

  it('takes a size for a node that was re-parented after the version', () => {
    const space = new Space();
    space.write([reparent(N, F)]);
    expect(space.write([resize(N, 140)], 10)).toEqual(['applied']);
  });

  it('never holds what the batch itself did against a later command of it', () => {
    const space = new Space();
    expect(
      space.write(
        [create('node-new'), reparent('node-new', F), move(N, 1, 1)],
        10,
      ),
    ).toEqual(['applied', 'applied', 'applied']);
  });

  it('exempts nothing without a page', () => {
    const space = new Space();
    space.edit(A, 10, [reparent(N, F)]);
    expect(space.write([move(N, 5, 5)], 10)).toEqual(['stale-parent']);
  });
});

describe('one read version per edit (a page)', () => {
  it('refuses the whole edit when one of its nodes was re-parented since', () => {
    const space = new Space();
    space.write([reparent(N, F)]);
    const before = space.node(M);
    expect(
      space.edit(B, 10, [reparent(M, G), move(N, 700, 700), recolour(M)]),
    ).toEqual(['stale-parent', 'stale-parent', 'stale-parent']);
    // No parent change without its position, no recolour of half a gesture.
    expect(space.node(M)).toBe(before);
    expect(space.node(N)?.parentId).toBe(F);
  });

  it('refuses the whole edit with stale-target when one of its nodes is gone', () => {
    const space = new Space();
    space.write([remove(N)]);
    expect(space.edit(B, 10, [move(N, 1, 1), move(M, 50, 60)])).toEqual([
      'stale-target',
      'stale-target',
    ]);
    expect(space.node(M)?.position).toEqual({ x: 20, y: 40 });
  });

  it('takes the edit when what changed since is another node', () => {
    const space = new Space();
    space.write([reparent(N, F)]);
    space.write([recolour(M)]);
    expect(space.edit(B, 10, [move(M, 50, 60)])).toEqual(['applied']);
  });

  it('judges each edit on its own and leaves an edit without a read version alone', () => {
    const space = new Space();
    space.write([reparent(N, F)]);
    expect(
      space.write(
        [],
        [
          { commands: [move(N, 700, 700)], version: 10 },
          { commands: [recolour(N)] },
          { commands: [move(M, 50, 60)], version: 10 },
        ],
        B,
      ),
    ).toEqual(['stale-parent', 'applied', 'applied']);
  });

  it('lets an edit use a node an earlier command of it creates', () => {
    const space = new Space();
    expect(
      space.edit(B, 10, [create('node-new'), reparent('node-new', F)]),
    ).toEqual(['applied', 'applied']);
  });

  describe('an edit made on top of an earlier one', () => {
    const onTop = (space: Space, version = 10) =>
      space.write(
        [],
        [
          { commands: [reparent(N, G)], version },
          { commands: [move(M, 5, 5)], version },
          { commands: [move(N, 7, 7)], version, after: [0] },
        ],
        B,
      );

    it('is taken when that one was', () => {
      const space = new Space();
      expect(onTop(space)).toEqual(['applied', 'applied', 'applied']);
      expect(space.node(N)?.parentId).toBe(G);
      expect(space.node(N)?.position).toEqual({ x: 7, y: 7 });
    });

    it('is refused when that one was refused by the check, and the unrelated one is still taken', () => {
      const space = new Space();
      // G was deleted: the drag into it is refused, and N stays where it is.
      space.write([remove(G)]);
      expect(onTop(space)).toEqual(['stale-target', 'applied', 'stale-parent']);
      // Not G-local coordinates on the canvas.
      expect(space.node(N)?.position).toEqual({ x: 500, y: 500 });
    });

    it('is refused when that one was refused by its handler', () => {
      const space = new Space();
      expect(
        space.write(
          [],
          [
            // A Frame cannot go into itself.
            { commands: [reparent(F, F)], version: 10 },
            { commands: [move(F, 7, 7)], version: 10, after: [0] },
          ],
          B,
        ),
      ).toEqual([
        expect.not.stringMatching(/^(applied|no-op)$/),
        'stale-parent',
      ]);
    });

    it('is refused when it was made on an edit of an earlier request that did not take effect', () => {
      const space = new Space();
      expect(
        space.write(
          [],
          [
            { commands: [move(N, 7, 7)], version: 10, blocked: true },
            { commands: [recolour(M)], version: 10 },
          ],
          B,
        ),
      ).toEqual(['stale-parent', 'applied']);
    });
  });
});

describe("a page's own change is not one it has not read", () => {
  it('own: the next edit made before the first was confirmed is taken', () => {
    const space = new Space();
    expect(space.edit(A, 10, [reparent(N, F)])).toEqual(['applied']);
    expect(space.stamps[N]).toMatchObject({ membership: 11, membershipBy: A });
    expect(space.edit(A, 10, [move(N, 5, 5)])).toEqual(['applied']);
    expect(space.node(N)?.position).toEqual({ x: 5, y: 5 });
  });

  it('own creation: an edit of a node this page created after its version is taken', () => {
    const space = new Space();
    expect(space.edit(A, 10, [create('node-new')])).toEqual(['applied']);
    expect(space.edit(A, 10, [move('node-new', 5, 5)])).toEqual(['applied']);
    // Another page that has not read it is refused.
    expect(space.edit(B, 10, [move('node-new', 6, 6)])).toEqual([
      'stale-target',
    ]);
  });

  it('foreign then own: the page that had not read the foreign change is refused', () => {
    const space = new Space();
    space.edit(B, 10, [reparent(N, F)]);
    expect(space.edit(A, 10, [move(N, 5, 5)])).toEqual(['stale-parent']);
    // Once it has read it, it is taken.
    expect(space.edit(A, 11, [move(N, 5, 5)])).toEqual(['applied']);
  });

  it('own then foreign: the foreign change after the own one is what counts', () => {
    const space = new Space();
    space.edit(A, 10, [reparent(N, F)]); // 11, own
    space.edit(B, 11, [reparent(N, G)]); // 12, foreign
    expect(space.stamps[N]).toMatchObject({ membership: 12, membershipBy: B });
    expect(space.edit(A, 10, [move(N, 5, 5)])).toEqual(['stale-parent']);
    expect(space.edit(A, 11, [move(N, 5, 5)])).toEqual(['stale-parent']);
  });

  it('own, foreign, own: the second own change can only exist when the foreign one had been read', () => {
    const space = new Space();
    space.edit(A, 10, [reparent(N, F)]); // 11, own
    space.edit(B, 11, [reparent(N, G)]); // 12, foreign
    // A's second change is refused while A has not read version 12 …
    expect(space.edit(A, 11, [reparent(N, null)])).toEqual(['stale-parent']);
    expect(space.stamps[N]).toMatchObject({ membership: 12, membershipBy: B });
    // … so when it is admitted, nothing foreign hides before it,
    expect(space.edit(A, 12, [reparent(N, null)])).toEqual(['applied']);
    expect(space.stamps[N]).toMatchObject({ membership: 13, membershipBy: A });
    // and a later edit of A made before that was confirmed is taken.
    expect(space.edit(A, 12, [move(N, 5, 5)])).toEqual(['applied']);
  });

  it('there and back by another page is a change all the same', () => {
    const space = new Space();
    space.edit(B, 10, [reparent(M, null)]);
    space.edit(B, 11, [reparent(M, F)]);
    // M is in F again, but not as A read it.
    expect(space.node(M)?.parentId).toBe(F);
    expect(space.edit(A, 10, [move(M, 50, 60)])).toEqual(['stale-parent']);
  });

  it('another page of the same person is another page', () => {
    const space = new Space();
    space.edit('alice/page-1', 10, [reparent(N, F)]);
    expect(space.edit('alice/page-2', 10, [move(N, 5, 5)])).toEqual([
      'stale-parent',
    ]);
    expect(space.edit('alice/page-1', 10, [move(N, 5, 5)])).toEqual([
      'applied',
    ]);
  });

  it('a write that states no read version is nobody’s, also for the page that sent it', () => {
    const space = new Space();
    space.write([reparent(N, F)], undefined, A);
    expect(space.stamps[N]).toEqual({ created: 10, membership: 11 });
    expect(space.edit(A, 10, [move(N, 5, 5)])).toEqual(['stale-parent']);
  });

  it('does not credit a page with a move it caused in a node it had not seen moved', () => {
    const space = new Space();
    // B puts N into F; A, which has not read that, dissolves F. N leaves F
    // with it, but A never saw N in there.
    space.edit(B, 10, [reparent(N, F)]); // 11
    expect(space.edit(A, 10, [dissolve(F)])).toEqual(['applied']); // 12
    expect(space.node(N)?.parentId).toBeUndefined();
    expect(space.stamps[N]).toEqual({ created: 10, membership: 12 });
    // M, which A had seen in F, is A's move.
    expect(space.stamps[M]).toMatchObject({ membership: 12, membershipBy: A });
    expect(space.edit(A, 10, [move(N, 5, 5)])).toEqual(['stale-parent']);
    expect(space.edit(A, 10, [move(M, 5, 5)])).toEqual(['applied']);
  });
});

describe('edits on the wire', () => {
  const body = (edits: unknown) => ({ edits });
  const OPERATION = '6f1c1e0e-52a5-4f2c-9d0b-7c1d1c9a8a11';

  it('takes edits with and without a read version, naming earlier edits', () => {
    expect(
      postCanvasExecuteBodySchema.safeParse(
        body([{ commands: [move(N, 1, 2)] }]),
      ).success,
    ).toBe(true);
    expect(
      postCanvasExecuteBodySchema.safeParse({
        operationId: OPERATION,
        originator: { tabId: 'page-1' },
        edits: [
          { basis: 'b1.x', commands: [move(N, 1, 2)] },
          {
            basis: 'b1.x',
            commands: [move(N, 3, 4)],
            after: [{ edit: 0 }, { operationId: OPERATION, edit: 2 }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('has no other way to state commands or a read version', () => {
    // The flat form: no `edits`.
    expect(
      postCanvasExecuteBodySchema.safeParse({
        commands: [move(N, 1, 2)],
        originator: { source: 'ui' },
      }).success,
    ).toBe(false);
    // An edit holds its commands itself; index arithmetic is gone.
    expect(
      postCanvasExecuteBodySchema.safeParse(
        body([{ start: 0, count: 1, basis: 'b', commands: [move(N, 1, 2)] }]),
      ).success,
    ).toBe(false);
  });

  it('rejects a malformed edit', () => {
    const commands = [move(N, 1, 2)];
    for (const edit of [
      { commands: [] },
      { basis: 'b' },
      { basis: '', commands },
      { basis: 'b', commands, extra: true },
      { basis: 'b', commands, after: [{}] },
      { basis: 'b', commands, after: [{ edit: -1 }] },
      { basis: 'b', commands, after: [{ operationId: 'nope', edit: 0 }] },
    ]) {
      expect(postCanvasExecuteBodySchema.safeParse(body([edit])).success).toBe(
        false,
      );
    }
    expect(postCanvasExecuteBodySchema.safeParse(body([])).success).toBe(false);
  });

  it('lets an edit of the request come only after an earlier one', () => {
    const commands = [move(N, 1, 2)];
    expect(
      postCanvasExecuteBodySchema.safeParse(
        body([{ commands }, { commands, after: [{ edit: 0 }] }]),
      ).success,
    ).toBe(true);
    for (const edits of [
      [{ commands, after: [{ edit: 0 }] }],
      [{ commands, after: [{ edit: 1 }] }, { commands }],
    ]) {
      const parsed = postCanvasExecuteBodySchema.safeParse(body(edits));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/earlier edit/);
    }
    // An edit of an earlier request is looked up, not addressed.
    expect(
      postCanvasExecuteBodySchema.safeParse(
        body([{ commands, after: [{ operationId: OPERATION, edit: 7 }] }]),
      ).success,
    ).toBe(true);
  });
});
