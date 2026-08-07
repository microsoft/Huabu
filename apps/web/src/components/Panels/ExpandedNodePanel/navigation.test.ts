// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  getExpandedNodeNeighbors,
  isExpandedNodeNavigationBlocked,
} from './navigation';

import type { EdgeDirection } from '@huabu/shared';
import type { Edge, Node } from '@xyflow/react';

const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }) as Pick<Node, 'id'>);

function edge(
  source: string,
  target: string,
  id = `${source}-${target}`,
  direction: EdgeDirection = 'forward',
) {
  return {
    id,
    source,
    target,
    data: { edgeStyle: { direction } },
  } as Edge;
}

describe('getExpandedNodeNeighbors', () => {
  it('resolves incoming and outgoing neighbors in canvas node order', () => {
    const edges = [edge('c', 'a'), edge('a', 'd'), edge('b', 'a')];

    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'incoming').map(
        (node) => node.id,
      ),
    ).toEqual(['b', 'c']);
    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'outgoing').map(
        (node) => node.id,
      ),
    ).toEqual(['d']);
  });

  it('ignores duplicate edges, self-loops, and missing endpoints', () => {
    const edges = [
      edge('a', 'b', 'first'),
      edge('a', 'b', 'duplicate'),
      edge('a', 'a', 'self-loop'),
      edge('a', 'missing', 'missing'),
    ];

    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'outgoing').map(
        (node) => node.id,
      ),
    ).toEqual(['b']);
  });

  it('keeps bidirectional and cyclic connections stateless', () => {
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('c', 'a')];

    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'incoming').map(
        (node) => node.id,
      ),
    ).toEqual(['b', 'c']);
    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'outgoing').map(
        (node) => node.id,
      ),
    ).toEqual(['b']);
  });

  it('follows the displayed arrow direction', () => {
    const edges = [
      edge('a', 'b', 'forward', 'forward'),
      edge('a', 'c', 'backward', 'backward'),
      edge('a', 'd', 'both', 'both'),
    ];

    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'incoming').map(
        (node) => node.id,
      ),
    ).toEqual(['c', 'd']);
    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'outgoing').map(
        (node) => node.id,
      ),
    ).toEqual(['b', 'd']);
  });

  it('keeps edges without arrows in a neutral connected group', () => {
    const edges = [edge('a', 'b', 'none', 'none')];

    expect(getExpandedNodeNeighbors(nodes, edges, 'a', 'incoming')).toEqual([]);
    expect(getExpandedNodeNeighbors(nodes, edges, 'a', 'outgoing')).toEqual([]);
    expect(
      getExpandedNodeNeighbors(nodes, edges, 'a', 'undirected').map(
        (node) => node.id,
      ),
    ).toEqual(['b']);
  });
});

describe('isExpandedNodeNavigationBlocked', () => {
  it('blocks editable, search, interactive, media, and viewer-owned targets', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const targets = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('button'),
      document.createElement('video'),
      editable,
    ];
    const search = document.createElement('div');
    search.setAttribute('role', 'searchbox');
    targets.push(search);
    const viewer = document.createElement('div');
    viewer.dataset.expandedNodeArrowOwner = '';
    targets.push(viewer);

    for (const target of targets) {
      expect(isExpandedNodeNavigationBlocked(target)).toBe(true);
    }
  });

  it('blocks descendants of controls and allows ordinary panel surfaces', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.appendChild(icon);

    expect(isExpandedNodeNavigationBlocked(icon)).toBe(true);
    expect(isExpandedNodeNavigationBlocked(document.createElement('div'))).toBe(
      false,
    );
  });
});
