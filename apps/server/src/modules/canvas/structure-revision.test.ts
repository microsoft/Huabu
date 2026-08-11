// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  canonicalSlimCanvasStructureJson,
  projectSlimCanvasStructure,
  structureRevisionOf,
} from './structure-revision.js';

import type { CanvasStructureSource } from './structure-revision.js';

function source(
  overrides: Partial<CanvasStructureSource> = {},
): CanvasStructureSource {
  return {
    title: 'Board',
    state: {
      nodes: [
        {
          id: 'node-1',
          type: 'note',
          position: { x: 10, y: 20 },
          selected: true,
          dragging: false,
          measured: { width: 300, height: 200 },
          handles: { source: [] },
          internals: { positionAbsolute: { x: 10, y: 20 } },
          data: {
            content: 'authored body',
            label: 'A note',
            labelSource: 'user',
            src: 'artifact.png',
            summary: 'derived',
            keywords: ['derived'],
            provenance: { model: 'example' },
            contentMissing: true,
            artifactMissing: true,
            contentDuplicate: true,
            duplicateFiles: ['one.md', 'two.md'],
            structuralFlag: 'kept',
          },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'node-1',
          target: 'node-2',
          selected: true,
          data: { label: 'kept edge data' },
        },
      ],
      viewport: { x: 100, y: 100, zoom: 2 },
    },
    ...overrides,
  };
}

describe('projectSlimCanvasStructure', () => {
  it('keeps authored topology and strips sidecar, derived, and runtime fields', () => {
    const input = source();

    expect(projectSlimCanvasStructure(input)).toEqual({
      title: 'Board',
      state: {
        nodes: [
          {
            id: 'node-1',
            type: 'note',
            position: { x: 10, y: 20 },
            data: { structuralFlag: 'kept' },
          },
        ],
        edges: [
          {
            id: 'edge-1',
            source: 'node-1',
            target: 'node-2',
            data: { label: 'kept edge data' },
          },
        ],
      },
    });

    expect(
      (input.state.nodes[0] as { data: { content: string } }).data.content,
    ).toBe('authored body');
  });
});

describe('structureRevisionOf', () => {
  it('uses canonical SHA-256 bytes', () => {
    const empty: CanvasStructureSource = {
      title: null,
      state: { nodes: [], edges: [] },
    };

    expect(canonicalSlimCanvasStructureJson(empty)).toBe(
      '{"state":{"edges":[],"nodes":[]},"title":null}',
    );
    expect(structureRevisionOf(empty)).toBe(
      'sha256:5de79b4315f0e489c1cf2e793c906d5adc0a52dc6909e0d319f76b4272761fce',
    );
  });

  it('is stable across object key order and ignored hydrated fields', () => {
    const first = source();
    const second: CanvasStructureSource = {
      state: {
        edges: [
          {
            target: 'node-2',
            data: { label: 'kept edge data' },
            source: 'node-1',
            id: 'edge-1',
            selected: false,
          },
        ],
        nodes: [
          {
            data: {
              structuralFlag: 'kept',
              content: 'different and arbitrarily large',
              summary: 'different derived value',
            },
            position: { y: 20, x: 10 },
            type: 'note',
            id: 'node-1',
            selected: false,
          },
        ],
      },
      title: 'Board',
    };

    expect(structureRevisionOf(second)).toBe(structureRevisionOf(first));
  });

  it('changes for title, authored node data, geometry, and array order', () => {
    const baseline = structureRevisionOf(source());
    const twoNodes = source({
      state: {
        nodes: [
          { id: 'node-1', position: { x: 0, y: 0 }, data: {} },
          { id: 'node-2', position: { x: 1, y: 1 }, data: {} },
        ],
        edges: [],
      },
    });

    expect(structureRevisionOf(source({ title: 'Renamed' }))).not.toBe(
      baseline,
    );
    expect(
      structureRevisionOf(
        source({
          state: {
            nodes: [
              {
                id: 'node-1',
                type: 'note',
                position: { x: 11, y: 20 },
                data: { structuralFlag: 'kept' },
              },
            ],
            edges: source().state.edges,
          },
        }),
      ),
    ).not.toBe(baseline);
    expect(
      structureRevisionOf({
        ...twoNodes,
        state: {
          ...twoNodes.state,
          nodes: [...twoNodes.state.nodes].reverse(),
        },
      }),
    ).not.toBe(structureRevisionOf(twoNodes));
  });

  it('rejects cyclic non-wire data rather than producing an unstable token', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() =>
      structureRevisionOf({
        title: 'Board',
        state: { nodes: [{ id: 'node-1', data: cyclic }], edges: [] },
      }),
    ).toThrow(/cyclic/);
  });
});
