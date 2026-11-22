// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { selectNodesToPreprocess } from './commit-trigger.js';

import { diffCanvasState, type CanvasNode } from '@huabu/shared/canvas-engine';

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  parentId?: string,
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data,
  } as CanvasNode;
}
const withData = (n: CanvasNode, data: Record<string, unknown>): CanvasNode =>
  ({ ...n, data: { ...n.data, ...data } }) as CanvasNode;

function select(
  prestateNodes: CanvasNode[],
  finalNodes: CanvasNode[],
  contentEditedNodeIds: string[] = [],
) {
  return selectNodesToPreprocess({
    ...commit(prestateNodes, finalNodes),
    contentEditedNodeIds,
  }).map((candidate) => candidate.node.id);
}

/** A batch as the executor hands it over: both states and their rows. */
function commit(prestateNodes: CanvasNode[], finalNodes: CanvasNode[]) {
  return {
    prestateNodes,
    finalNodes,
    deltas: diffCanvasState(
      { nodes: prestateNodes, edges: [] },
      { nodes: finalNodes, edges: [] },
    ),
  };
}

const pdf = node('pdf', 'pdf', { label: 'Paper', src: 'a.pdf' });
const frame = node('frame', 'frame', { label: 'Group', labelSource: 'user' });
const child = node('child', 'pdf', { label: 'One', src: 'b.pdf' }, 'frame');

describe('selectNodesToPreprocess', () => {
  it('selects a node the write created, with nothing as its previous input', () => {
    const [candidate] = selectNodesToPreprocess({
      ...commit([], [pdf]),
      contentEditedNodeIds: [],
    });
    expect(candidate.node).toBe(pdf);
    expect(candidate.previousSnapshot).toBeUndefined();
    expect(candidate.snapshot).toMatchObject({ title: 'Paper', src: 'a.pdf' });
  });

  it('selects nothing when a write only moves, restyles or re-places a node', () => {
    for (const data of [
      { frameColumn: 1, frameRow: 2 },
      { paintKey: 'a5', trackKey: 'a1' },
      { style: { accent: 'red' } },
      { properties: { status: 'read' } },
    ])
      expect(select([pdf], [withData(pdf, data)])).toEqual([]);
    expect(
      select([pdf], [{ ...pdf, position: { x: 9, y: 9 } } as CanvasNode]),
    ).toEqual([]);
    expect(select([frame], [withData(frame, { layoutOrder: [[]] })])).toEqual(
      [],
    );
  });

  it('selects a node whose watched input changed, with its previous input', () => {
    const [candidate] = selectNodesToPreprocess({
      ...commit([pdf], [withData(pdf, { src: 'other.pdf' })]),
      contentEditedNodeIds: [],
    });
    expect(candidate.previousSnapshot).toMatchObject({ src: 'a.pdf' });
    expect(candidate.snapshot).toMatchObject({ src: 'other.pdf' });
    expect(select([pdf], [withData(pdf, { label: 'Renamed' })])).toEqual([
      'pdf',
    ]);
  });

  it('follows each type’s own watched fields', () => {
    const image = node('img', 'image', { label: 'Pic', src: 'a.png' });
    // An image is derived from its source; its title is not an input.
    expect(select([image], [withData(image, { label: 'Renamed' })])).toEqual(
      [],
    );
    expect(select([image], [withData(image, { src: 'b.png' })])).toEqual([
      'img',
    ]);
    const video = node('vid', 'video', { label: 'Clip', src: 'a.mp4' });
    expect(select([video], [withData(video, { label: 'Renamed' })])).toEqual(
      [],
    );
  });

  it('selects a Frame when a child’s title changes or its children change', () => {
    const renamed = withData(child, { label: 'Two' });
    expect(select([frame, child], [frame, renamed])).toEqual([
      'child',
      'frame',
    ]);
    // A child that only moves inside the Frame changes nothing for it.
    expect(
      select([frame, child], [frame, withData(child, { frameColumn: 3 })]),
    ).toEqual([]);
    const { parentId: _parentId, ...detached } = child;
    expect(select([frame, child], [frame, detached as CanvasNode])).toEqual([
      'frame',
    ]);
  });

  it('leaves a note body to the editor that is left, but not its creation or title', () => {
    const note = node('note', 'note', { label: 'Note', content: 'Body' });
    const edited = withData(note, { content: 'Body, typed on' });
    expect(select([note], [edited], ['note'])).toEqual([]);
    expect(select([note], [withData(note, { label: 'Renamed' })])).toEqual([
      'note',
    ]);
    expect(select([], [note])).toEqual(['note']);
    // A body put back by a command that is not an edit is processed.
    expect(select([note], [edited])).toEqual(['note']);
  });

  it('derives again only what a restored node lost with its deletion', () => {
    const note = node('note', 'note', { label: 'Kept', content: 'Body' });
    const video = node('vid', 'video', { label: 'Clip', src: 'a.mp4' });
    const selected = selectNodesToPreprocess({
      ...commit([], [note, pdf, video]),
      contentEditedNodeIds: [],
      restoredNodeIds: ['note', 'pdf', 'vid'],
    }).map((candidate) => candidate.node.id);
    // The note came back whole, title included; the PDF's text and the
    // video's cover did not.
    expect(selected).toEqual(['pdf', 'vid']);
  });

  it('does not look at the Space for a batch that touches no watched field', () => {
    // A node array that cannot be read: any indexing would throw.
    const unreadable = new Proxy([] as CanvasNode[], {
      get(target, key) {
        if (key === 'length') return 0;
        throw new Error(`The Space was read (${String(key)})`);
      },
    });
    const moved = diffCanvasState(
      { nodes: [pdf, child], edges: [] },
      {
        nodes: [
          { ...pdf, position: { x: 5, y: 5 } } as CanvasNode,
          withData(child, { frameColumn: 2, paintKey: 'a2' }),
        ],
        edges: [],
      },
    );
    expect(moved).toHaveLength(2);
    expect(
      selectNodesToPreprocess({
        deltas: moved,
        prestateNodes: unreadable,
        finalNodes: unreadable,
        contentEditedNodeIds: [],
      }),
    ).toEqual([]);
  });

  it('never selects types whose pipeline does nothing', () => {
    for (const type of ['sketch', 'spacePreview', 'fileReference', 'audio'])
      expect(select([], [node('n', type, { label: 'X', src: 's' })])).toEqual(
        [],
      );
  });
});
