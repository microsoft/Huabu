// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { agentRequestSchema, stopThreadResponseSchema } from './agent.js';

describe('agentRequestSchema input kinds', () => {
  it('accepts node-only lasso requests and retains complete Text and lazy containers', () => {
    const request = {
      inputKind: 'selection-intent',
      content: '',
      canvasId: 'canvas-1',
      canvasContext: {
        selectedNodes: [
          { id: 'text', type: 'text', content: 'Complete text\nSecond line' },
          {
            id: 'frame',
            type: 'frame',
            referenceOnly: true,
            children: [{ id: 'note', type: 'note', referenceOnly: true }],
          },
        ],
      },
    };
    expect(agentRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    { canvasId: undefined, selectedNodes: [{ id: 'text', type: 'text' }] },
    { canvasId: 'canvas', selectedNodes: [] },
    { canvasId: 'canvas', selectedNodes: [{ id: 'q', type: 'question' }] },
    {
      canvasId: 'canvas',
      selectedNodes: [{ id: 'ink', type: 'sketch', strokeIds: ['stroke'] }],
    },
  ])(
    'rejects invalid node-only lasso sources: %j',
    ({ canvasId, selectedNodes }) => {
      expect(
        agentRequestSchema.safeParse({
          inputKind: 'selection-intent',
          content: '',
          canvasId,
          canvasContext: { selectedNodes },
        }).success,
      ).toBe(false);
    },
  );

  const inkRequest = {
    inputKind: 'ink-intent',
    content: '',
    canvasId: 'canvas-1',
    canvasContext: {
      selectedNodes: [
        { id: 'sketch-1', type: 'sketch', strokeIds: ['stroke-1'] },
      ],
    },
  };
  const groundingVisual = {
    kind: 'visible-canvas' as const,
    dataUrl: 'data:image/png;base64,cG5n',
    viewport: {
      x: 0,
      y: 0,
      zoom: 1,
      width: 1200,
      height: 800,
      devicePixelRatio: 2,
    },
    crop: { x: 100, y: 120, width: 500, height: 300 },
    selectedNodeIds: ['note-1'],
    strokeSubsets: [{ nodeId: 'sketch-1', strokeIds: ['stroke-1'] }],
  };

  it('preserves legacy text without adding an input kind', () => {
    expect(agentRequestSchema.parse({ content: 'Hello' })).toEqual({
      content: 'Hello',
    });
  });

  it.each([undefined, 'text'])(
    'rejects empty text for kind %s',
    (inputKind) => {
      expect(
        agentRequestSchema.safeParse({ content: '', inputKind }).success,
      ).toBe(false);
    },
  );

  it('accepts a quote-only request and trims quote and comment boundaries', () => {
    const parsed = agentRequestSchema.parse({
      content: '',
      quotedComments: [
        {
          quote: ' \nOriginal  passage\n\n    indentation\nEnd. \n',
          contextBefore: 'Before ',
          contextAfter: ' after',
          comment: '  Explain this.  ',
        },
      ],
    });

    expect(parsed.quotedComments).toEqual([
      {
        quote: 'Original  passage\n\n    indentation\nEnd.',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain this.',
      },
    ]);
  });

  it('preserves Note snapshot evidence without requiring it on legacy Chat quotes', () => {
    const source = {
      kind: 'note',
      canvasId: 'space',
      nodeId: 'note',
      snapshotRevision: 'captured-version',
    };
    const quote = {
      quote: 'excerpt',
      contextBefore: 'before',
      contextAfter: 'after',
      comment: 'explain',
    };
    const parsed = agentRequestSchema.parse({
      content: '',
      quotedComments: [quote, { ...quote, source }],
    });
    expect(parsed.quotedComments).toEqual([quote, { ...quote, source }]);
    for (const invalid of [
      { ...source, nodeId: '' },
      { ...source, snapshotRevision: '' },
      { ...source, kind: 'web' },
      { nodeId: 'note' },
    ]) {
      expect(
        agentRequestSchema.safeParse({
          content: '',
          quotedComments: [{ ...quote, source: invalid }],
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    { quotedComments: [] },
    {
      quotedComments: [
        {
          quote: ' ',
          contextBefore: '',
          contextAfter: '',
          comment: 'Explain.',
        },
      ],
    },
    {
      quotedComments: [
        { quote: 'Passage', contextBefore: '', contextAfter: '', comment: ' ' },
      ],
    },
    { quotedComments: [{ quote: 'Passage', comment: 'Explain.' }] },
  ])(
    'rejects quote-only requests without complete usable comments: %j',
    ({ quotedComments }) => {
      expect(
        agentRequestSchema.safeParse({ content: '', quotedComments }).success,
      ).toBe(false);
    },
  );

  it.each(['ask', 'operate'])(
    'accepts selected Ink with empty text in %s mode',
    (mode) => {
      expect(
        agentRequestSchema.safeParse({ ...inkRequest, mode }).success,
      ).toBe(true);
    },
  );

  it('rejects Ink without a Canvas', () => {
    expect(
      agentRequestSchema.safeParse({ ...inkRequest, canvasId: undefined })
        .success,
    ).toBe(false);
  });

  it.each([undefined, [], ['']])(
    'rejects a Sketch without valid partial strokes: %j',
    (strokeIds) => {
      expect(
        agentRequestSchema.safeParse({
          ...inkRequest,
          canvasContext: {
            selectedNodes: [{ id: 'sketch-1', type: 'sketch', strokeIds }],
          },
        }).success,
      ).toBe(false);
    },
  );

  it('accepts partial Sketch sources nested in a Frame', () => {
    expect(
      agentRequestSchema.safeParse({
        ...inkRequest,
        canvasContext: {
          selectedNodes: [
            {
              id: 'frame-1',
              type: 'frame',
              children: inkRequest.canvasContext.selectedNodes,
            },
          ],
        },
        groundingVisual: {
          ...groundingVisual,
          selectedNodeIds: ['frame-1'],
        },
      }).success,
    ).toBe(true);
  });

  it('requires hidden grounding for mixed Ink/object requests', () => {
    const mixed = {
      ...inkRequest,
      canvasContext: {
        selectedNodes: [
          ...inkRequest.canvasContext.selectedNodes,
          { id: 'note-1', type: 'note' },
        ],
      },
    };
    expect(agentRequestSchema.safeParse(mixed).success).toBe(false);
    expect(
      agentRequestSchema.safeParse({ ...mixed, groundingVisual }).success,
    ).toBe(true);
  });

  it('does not require relationship grounding for pure Ink', () => {
    expect(agentRequestSchema.safeParse(inkRequest).success).toBe(true);
  });

  it('rejects grounding metadata that does not match the mixed selection', () => {
    expect(
      agentRequestSchema.safeParse({
        ...inkRequest,
        canvasContext: {
          selectedNodes: [
            ...inkRequest.canvasContext.selectedNodes,
            { id: 'note-1', type: 'note' },
          ],
        },
        groundingVisual: {
          ...groundingVisual,
          selectedNodeIds: ['other-note'],
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      selectedNodeIds: ['note-1', 'note-1'],
      strokeSubsets: groundingVisual.strokeSubsets,
    },
    {
      selectedNodeIds: groundingVisual.selectedNodeIds,
      strokeSubsets: [
        { nodeId: 'sketch-1', strokeIds: ['stroke-1', 'stroke-1'] },
      ],
    },
    {
      selectedNodeIds: groundingVisual.selectedNodeIds,
      strokeSubsets: [
        ...groundingVisual.strokeSubsets,
        ...groundingVisual.strokeSubsets,
      ],
    },
  ])('rejects duplicate grounding operands: %j', (duplicates) => {
    expect(
      agentRequestSchema.safeParse({
        ...inkRequest,
        canvasContext: {
          selectedNodes: [
            ...inkRequest.canvasContext.selectedNodes,
            { id: 'note-1', type: 'note' },
          ],
        },
        groundingVisual: { ...groundingVisual, ...duplicates },
      }).success,
    ).toBe(false);
  });

  it('rejects hidden grounding on text turns', () => {
    expect(
      agentRequestSchema.safeParse({
        content: 'Hello',
        groundingVisual,
      }).success,
    ).toBe(false);
  });

  it('does not treat stroke IDs on an ordinary node as Ink', () => {
    expect(
      agentRequestSchema.safeParse({
        ...inkRequest,
        canvasContext: {
          selectedNodes: [
            { id: 'note-1', type: 'note', strokeIds: ['stroke-1'] },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('accepts external bindings for an existing Question target', () => {
    expect(
      agentRequestSchema.safeParse({
        ...inkRequest,
        agentBinding: {
          kind: 'external',
          alias: 'External',
          profileId: 'profile-1',
        },
      }).success,
    ).toBe(true);
  });
});

describe('stopThreadResponseSchema', () => {
  it('carries durable acceptance when the stopped turn already started', () => {
    expect(
      stopThreadResponseSchema.parse({
        stopped: true,
        acceptance: { threadId: 'thread-1', turnStartSeq: 3 },
      }),
    ).toEqual({
      stopped: true,
      acceptance: { threadId: 'thread-1', turnStartSeq: 3 },
    });
  });
});
