// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { putNodeContentBodySchema } from '../../types/api/canvas.js';
import {
  executeCanvasCommands,
  nodeRevision,
  nodeRevisionOf,
  extractCanvasChanges,
  fingerprintNodeFields,
  orderedPropertyKeys,
} from '../index.js';

import type { CanvasNode } from '../interfaces.js';

const note: CanvasNode = {
  id: 'note',
  type: 'note',
  position: { x: 0, y: 0 },
  data: { content: '' },
};
const pdf: CanvasNode = {
  id: 'pdf',
  type: 'pdf',
  position: { x: 0, y: 0 },
  data: {
    properties: {
      title: 'Paper',
      year: 2026,
      reviewed: false,
      tags: ['reading'],
    },
  },
};

function merge(patch: Record<string, unknown>, nodes = [pdf, note]) {
  return executeCanvasCommands(
    {
      source: 'agent',
      commands: [
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'pdf' as never, patch }],
        },
      ],
    },
    { nodes, edges: [], canvasId: 'space' },
  ).writeResult.nodes[0];
}

/** The revision of loosely held fields, as a stored record passes them. */
const revOf = (fields: object): string => nodeRevisionOf(fields);

describe('node properties', () => {
  it('rejects properties on non-sidecar Space previews instead of losing them on reload', () => {
    const result = executeCanvasCommands(
      {
        source: 'agent',
        commands: [
          {
            type: 'MERGE_NODE_DATA',
            patches: [
              {
                nodeId: 'node-space',
                patch: { properties: { Status: 'Read' } },
              },
            ],
          },
        ],
      },
      {
        canvasId: 'space',
        edges: [],
        nodes: [
          {
            id: 'node-space',
            type: 'spacePreview',
            position: { x: 0, y: 0 },
            data: { targetCanvasId: 'destination' },
          },
        ],
      },
    );
    expect(result.commandResults[0]).toMatchObject({
      applied: false,
      reason: 'invalid-target',
    });
  });
  it('resolves saved priority without losing unordered properties or repeating stale keys', () => {
    const properties = {
      '2': 'Second',
      '1': 'First',
      Venue: 'UIST',
      New: true,
    };
    expect(
      orderedPropertyKeys(properties, ['Venue', '2', 'missing', 'Venue', '1']),
    ).toEqual(['Venue', '2', '1', 'New']);
    expect(orderedPropertyKeys(properties, [])).toEqual([
      '1',
      '2',
      'Venue',
      'New',
    ]);
  });

  it('marks a creation revert stale when metadata is added after creation', () => {
    const [change] = extractCanvasChanges([
      { type: 'INSERT_NODE', node: note },
    ]);
    expect(
      fingerprintNodeFields(
        { ...note, data: { ...note.data, properties: { reviewed: true } } },
        change.fingerprintKeys ?? [],
      ),
    ).not.toBe(change.appliedFingerprint);
  });
  it('merges individual keys and deletes explicit tombstones without losing siblings', () => {
    const changed = merge({
      properties: { year: null, reviewed: true, authors: ['Ada'] },
      propertyDisplayKeys: [],
    });
    expect(changed.data.properties).toEqual({
      title: 'Paper',
      reviewed: true,
      tags: ['reading'],
      authors: ['Ada'],
    });
    expect(merge({ properties: {} }, [changed, note]).data.properties).toEqual(
      changed.data.properties,
    );
  });

  it('rejects invalid property values and accepts deletion tombstones', () => {
    expect(merge({ properties: { nested: { value: 1 } } }).data).toEqual(
      pdf.data,
    );
    expect(
      putNodeContentBodySchema.safeParse({
        nodeType: 'pdf',
        properties: { value: null },
      }).success,
    ).toBe(true);
    expect(
      putNodeContentBodySchema.safeParse({
        nodeType: 'pdf',
        properties: { value: [1] },
      }).success,
    ).toBe(false);
  });

  it('leaves custom properties and their display order out of the content revision', () => {
    const body = { type: 'note', content: 'Body', src: 'artifacts/a.png' };
    const rev = revOf(body);
    // Set, change, remove, reorder: none of them is a new revision.
    expect(revOf({ ...body, properties: { year: 2026 } })).toBe(rev);
    expect(revOf({ ...body, properties: { year: 2027, tags: ['a'] } })).toBe(
      rev,
    );
    expect(
      revOf({
        ...body,
        properties: { year: 2026 },
        propertyDisplayKeys: ['year'],
      }),
    ).toBe(rev);
    expect(revOf({ ...body, propertyDisplayKeys: [] })).toBe(rev);
    expect(
      nodeRevision({
        id: 'n',
        type: 'note',
        position: { x: 0, y: 0 },
        data: { ...body, properties: { year: 2026 } },
      }),
    ).toBe(rev);
    // A node that has only properties has the revision of empty content.
    expect(revOf({ properties: { caption: 'Art' } })).toBe(revOf({}));
  });

  it('changes the content revision with the body and with the source', () => {
    const body = {
      type: 'note',
      content: 'Body',
      src: 'artifacts/a.png',
      properties: { year: 2026 },
      propertyDisplayKeys: ['year'],
    };
    expect(revOf({ ...body, content: 'Body.' })).not.toBe(revOf(body));
    expect(revOf({ ...body, src: 'artifacts/b.png' })).not.toBe(revOf(body));
    // A bodyless type is not given a body by its properties.
    expect(revOf({ type: 'image', content: '', properties: { a: 'b' } })).toBe(
      revOf({ type: 'image' }),
    );
  });

  it('still fingerprints properties canonically for a review record', () => {
    const node = (properties: Record<string, unknown>): CanvasNode => ({
      id: 'n',
      type: 'note',
      position: { x: 0, y: 0 },
      data: { content: '', properties },
    });
    expect(
      fingerprintNodeFields(node({ title: 'Paper', year: 2026 }), [
        'properties',
      ]),
    ).toBe(
      fingerprintNodeFields(node({ year: 2026, title: 'Paper' }), [
        'properties',
      ]),
    );
    expect(
      fingerprintNodeFields(node({ year: 2027 }), ['properties']),
    ).not.toBe(fingerprintNodeFields(node({ year: 2026 }), ['properties']));
  });
});
