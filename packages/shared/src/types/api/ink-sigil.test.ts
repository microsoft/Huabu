// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { agentRequestSchema } from './agent.js';
import {
  inkResourceBindingSchema,
  inkResourceReferenceSchema,
  sketchResourceBindingDataSchema,
} from './ink-sigil.js';
import {
  isInkResourceBinding,
  hasValidInkResourceBindings,
} from '../../canvas-engine/utils/inkSigil.js';

const strokeIds = ['s0', 's1', 's2', 's3'];
const reference = {
  id: 'binding',
  fingerprint: '0123456789abcdef',
  targetNodeId: 'pdf',
  targetType: 'pdf',
  label: 'Paper',
  sourceBounds: { x: 0, y: 0, width: 40, height: 40 },
  sources: strokeIds.map((strokeId) => ({ nodeId: 'ink', strokeId })),
};
const request = {
  inputKind: 'ink-intent',
  content: '',
  canvasId: 'space',
  canvasContext: { selectedNodes: [{ id: 'ink', type: 'sketch', strokeIds }] },
  inkResources: [reference],
  groundingVisual: {
    kind: 'visible-canvas',
    dataUrl: 'data:image/png;base64,cG5n',
    viewport: {
      x: 0,
      y: 0,
      zoom: 1,
      width: 100,
      height: 100,
      devicePixelRatio: 1,
    },
    crop: { x: 0, y: 0, width: 100, height: 100 },
    selectedNodeIds: [],
    strokeSubsets: [{ nodeId: 'ink', strokeIds }],
  },
};

describe('Ink resource wire contracts', () => {
  it('keeps the zod-free persisted guard aligned with the canonical schema', () => {
    const { sources: _sources, sourceBounds: _bounds, ...fields } = reference;
    const valid = { ...fields, strokeIds };
    const candidates: unknown[] = [
      valid,
      null,
      42,
      'binding',
      [],
      {},
      { ...valid, extra: true },
      { ...valid, strokeIds: 42 },
      { ...valid, strokeIds: 's0' },
      { ...valid, strokeIds: ['s0', 's0', 's2', 's3'] },
      { ...valid, strokeIds: ['s0', 's1', 's2'] },
      { ...valid, strokeIds: ['s0', 's1', null, 's3'] },
      { ...valid, targetType: 'frame' },
      { ...valid, fingerprint: 'bad' },
      { ...valid, label: '' },
      { ...valid, label: 'a'.repeat(201) },
      { ...valid, id: 42 },
      { ...valid, targetNodeId: '' },
      { ...valid, id: 'a'.repeat(200), label: 'a'.repeat(200) },
    ];
    for (const candidate of candidates) {
      expect(isInkResourceBinding(candidate)).toBe(
        inkResourceBindingSchema.safeParse(candidate).success,
      );
      const data = { strokes: [{ resourceBinding: candidate }] };
      expect(hasValidInkResourceBindings(data)).toBe(
        sketchResourceBindingDataSchema.safeParse(data).success,
      );
    }
  });

  it('rejects malformed bindings in Sketch data but keeps ordinary Ink unchanged', () => {
    const stroke = {
      id: 's0',
      points: [
        [0, 0],
        [1, 1],
      ],
      color: 'black',
      size: 2,
    };
    const data = (value: unknown) => ({
      strokes: [{ ...stroke, resourceBinding: value }],
    });
    expect(
      sketchResourceBindingDataSchema.safeParse(data({ strokeIds: 42 }))
        .success,
    ).toBe(false);
    expect(sketchResourceBindingDataSchema.safeParse(data(null)).success).toBe(
      false,
    );
    expect(sketchResourceBindingDataSchema.parse(data(undefined))).toEqual(
      data(undefined),
    );
    const { sources: _sources, sourceBounds: _bounds, ...fields } = reference;
    const valid = data({ ...fields, strokeIds });
    expect(sketchResourceBindingDataSchema.parse(valid)).toEqual(valid);
  });

  it('accepts an off-selection resource without changing grounding operands', () => {
    const parsed = agentRequestSchema.parse(request);
    expect(parsed.inkResources).toEqual([reference]);
    expect(parsed.canvasContext?.selectedNodes).toHaveLength(1);
  });
  it('requires grounding even for a Sigil-only Ink selection', () => {
    expect(
      agentRequestSchema.safeParse({ ...request, groundingVisual: undefined })
        .success,
    ).toBe(false);
  });
  it('rejects partial, forged-owner, duplicate and overlapping source memberships', () => {
    for (const sources of [
      reference.sources.slice(1),
      reference.sources.map((source) => ({ ...source, nodeId: 'other' })),
      reference.sources.map(() => reference.sources[0]),
    ]) {
      expect(
        agentRequestSchema.safeParse({
          ...request,
          inkResources: [{ ...reference, sources }],
        }).success,
      ).toBe(false);
    }
    expect(
      agentRequestSchema.safeParse({
        ...request,
        inkResources: [reference, { ...reference, id: 'second' }],
      }).success,
    ).toBe(false);
  });
  it('does not admit Sigils in ordinary text or unsupported target types', () => {
    expect(
      agentRequestSchema.safeParse({
        content: 'Hello',
        inkResources: [reference],
      }).success,
    ).toBe(false);
    for (const targetType of ['question', 'frame', 'sketch', 'video']) {
      expect(
        inkResourceReferenceSchema.safeParse({ ...reference, targetType })
          .success,
      ).toBe(false);
    }
  });
  it('bounds metadata and rejects unknown fields in durable bindings', () => {
    const { sources: _sources, sourceBounds: _bounds, ...binding } = reference;
    expect(
      inkResourceBindingSchema.parse({ ...binding, strokeIds }).strokeIds,
    ).toHaveLength(4);
    expect(
      inkResourceBindingSchema.safeParse({
        ...binding,
        strokeIds,
        command: 'run',
      }).success,
    ).toBe(false);
    expect(
      inkResourceReferenceSchema.safeParse({
        ...reference,
        label: 'x'.repeat(201),
      }).success,
    ).toBe(false);
    expect(
      agentRequestSchema.safeParse({
        ...request,
        inkResources: Array.from({ length: 33 }, (_, i) => ({
          ...reference,
          id: `${i}`,
        })),
      }).success,
    ).toBe(false);
  });
});
