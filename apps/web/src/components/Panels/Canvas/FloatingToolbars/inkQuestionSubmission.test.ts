// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  deriveInkSubmissionCandidate,
  inkLassoIdentity,
  inkSelectionIdentity,
  inkStrokeSelectionIdentity,
  isViewportStableForBounds,
  retainedLassoBounds,
  unionSelectionBounds,
} from './inkQuestionSubmission';

import type { Node } from '@xyflow/react';

function node(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
): Node {
  return { id, type, selected: true, position: { x: 0, y: 0 }, data };
}

describe('Ink Question submission candidate', () => {
  it('counts a partial Sketch and whole-node sources without duplication', () => {
    const candidate = deriveInkSubmissionCandidate(
      [node('sketch-1', 'sketch'), node('note-1', 'note')],
      { 'sketch-1': ['stroke-1', 'stroke-2'] },
    );

    expect(candidate).toMatchObject({
      kind: 'ready',
      sourceCount: 2,
      selectedNodeIds: ['sketch-1', 'note-1'],
      target: null,
    });
  });

  it('routes an explicitly chosen internal Question without counting it as a source', () => {
    const candidate = deriveInkSubmissionCandidate(
      [
        node('question-1', 'question', {
          threadId: 'thread-1',
          agentBinding: { kind: 'internal' },
          agentMode: 'operate',
        }),
        node('note-1', 'note'),
      ],
      { 'sketch-1': ['stroke-1'] },
      'question-1',
    );

    expect(candidate).toMatchObject({
      kind: 'ready',
      sourceCount: 2,
      selectedNodeIds: ['note-1'],
      target: {
        nodeId: 'question-1',
        threadId: 'thread-1',
        mode: 'operate',
        binding: { kind: 'internal' },
      },
    });
  });

  it('ignores multiple selected Questions and accepts an explicit external Question target', () => {
    expect(
      deriveInkSubmissionCandidate(
        [
          node('question-1', 'question', { threadId: 'thread-1' }),
          node('question-2', 'question', { threadId: 'thread-2' }),
        ],
        { 'sketch-1': ['stroke-1'] },
      ),
    ).toMatchObject({
      kind: 'ready',
      target: null,
      sourceCount: 1,
    });

    expect(
      deriveInkSubmissionCandidate(
        [
          node('question-1', 'question', {
            threadId: 'thread-1',
            agentBinding: {
              kind: 'external',
              profileId: 'profile-1',
              alias: 'External',
            },
          }),
        ],
        { 'sketch-1': ['stroke-1'] },
        'question-1',
      ),
    ).toMatchObject({
      kind: 'ready',
      target: {
        nodeId: 'question-1',
        threadId: 'thread-1',
        binding: {
          kind: 'external',
          profileId: 'profile-1',
          alias: 'External',
        },
      },
    });
  });

  it('blocks a Question with a malformed persisted binding', () => {
    expect(
      deriveInkSubmissionCandidate(
        [
          node('question-1', 'question', {
            threadId: 'thread-1',
            agentBinding: { kind: 'external', profileId: '' },
          }),
        ],
        { 'sketch-1': ['stroke-1'] },
        'question-1',
      ),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-question-target',
    });
  });

  it('ignores selected malformed Questions unless explicitly targeted', () => {
    const nodes = [
      node('broken', 'question', { agentBinding: { kind: 'bad' } }),
    ];
    expect(
      deriveInkSubmissionCandidate(nodes, { ink: ['stroke'] }),
    ).toMatchObject({
      kind: 'ready',
      target: null,
      sourceCount: 1,
      excludedNodeIds: ['broken'],
    });
    expect(
      deriveInkSubmissionCandidate(nodes, { ink: ['stroke'] }, 'missing'),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-question-target',
    });
  });

  it('does not change source identity when Agent Node selection changes', () => {
    const question = node('question', 'question');
    const selection = { ink: ['stroke'] };
    expect(inkSelectionIdentity('canvas', [question], selection)).toBe(
      inkSelectionIdentity(
        'canvas',
        [{ ...question, selected: false }],
        selection,
      ),
    );
  });

  it('changes identity when the Canvas, whole nodes, or strokes change', () => {
    const nodes = [node('note-1', 'note')];
    const identity = inkSelectionIdentity('canvas-1', nodes, {
      'sketch-1': ['stroke-1'],
    });

    expect(
      inkSelectionIdentity('canvas-1', nodes, {
        'sketch-1': ['stroke-1'],
      }),
    ).toBe(identity);
    expect(
      inkSelectionIdentity('canvas-1', nodes, {
        'sketch-1': ['stroke-2'],
      }),
    ).not.toBe(identity);
    expect(
      inkSelectionIdentity('canvas-2', nodes, {
        'sketch-1': ['stroke-1'],
      }),
    ).not.toBe(identity);
  });

  it('keeps stroke identity stable when only whole-node selection changes', () => {
    const selection = { 'sketch-1': ['stroke-1'] };
    expect(inkStrokeSelectionIdentity('canvas-1', selection)).toBe(
      inkStrokeSelectionIdentity('canvas-1', selection),
    );
    expect(inkStrokeSelectionIdentity('canvas-1', selection)).not.toBe(
      inkStrokeSelectionIdentity('canvas-1', {
        'sketch-1': ['stroke-2'],
      }),
    );
  });

  it('identifies a Lasso by its strokes and retained polygon', () => {
    const selection = { 'sketch-1': ['stroke-1'] };
    const polygon = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ];
    const identity = inkLassoIdentity('canvas-1', selection, polygon);

    expect(inkLassoIdentity('canvas-1', selection, polygon)).toBe(identity);
    expect(
      inkLassoIdentity('canvas-1', selection, [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 30 },
      ]),
    ).not.toBe(identity);
  });

  it('unions partial-stroke and whole-node bounds', () => {
    expect(
      unionSelectionBounds(
        { x: 20, y: 30, width: 40, height: 50 },
        { x: 0, y: 60, width: 100, height: 20 },
      ),
    ).toEqual({ x: 0, y: 30, width: 100, height: 50 });
  });

  it('ignores imperceptible viewport corrections during grounding capture', () => {
    const bounds = { x: 100, y: 50, width: 200, height: 100 };

    expect(
      isViewportStableForBounds(
        { x: 0, y: 0, zoom: 1 },
        { x: 0.25, y: -0.25, zoom: 1 },
        bounds,
      ),
    ).toBe(true);
    expect(
      isViewportStableForBounds(
        { x: 0, y: 0, zoom: 1 },
        { x: -0.1, y: -0.05, zoom: 1.001 },
        bounds,
      ),
    ).toBe(true);
  });

  it('detects viewport changes that visibly move grounding sources', () => {
    const bounds = { x: 100, y: 50, width: 200, height: 100 };

    expect(
      isViewportStableForBounds(
        { x: 0, y: 0, zoom: 1 },
        { x: 0.5, y: 0, zoom: 1 },
        bounds,
      ),
    ).toBe(false);
    expect(
      isViewportStableForBounds(
        { x: 0, y: 0, zoom: 1 },
        { x: 0, y: 0, zoom: 1.01 },
        bounds,
      ),
    ).toBe(false);
  });

  it('anchors to the retained Lasso bounds including its live move', () => {
    expect(
      retainedLassoBounds(
        [
          { x: 20, y: 30 },
          { x: 80, y: 20 },
          { x: 90, y: 70 },
          { x: 10, y: 60 },
        ],
        { dx: 5, dy: -10 },
      ),
    ).toEqual({ x: 15, y: 10, width: 80, height: 50 });
    expect(retainedLassoBounds(null)).toBeNull();
  });
});
