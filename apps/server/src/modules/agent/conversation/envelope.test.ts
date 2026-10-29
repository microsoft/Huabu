// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatEnvelopeSchema } from '@huabu/shared';

const readMany = vi.hoisted(() => vi.fn());
const readCanvas = vi.hoisted(() => vi.fn());
const rasterize = vi.hoisted(() => vi.fn());
const rasterizeOcr = vi.hoisted(() => vi.fn());
const isInkOcrConfigured = vi.hoisted(() => vi.fn());
const recognizeInk = vi.hoisted(() => vi.fn());

vi.mock('../../storage/index.js', () => ({
  space: () => ({
    read: readCanvas,
    nodes: {
      readMany,
      read: vi.fn(),
    },
  }),
}));

vi.mock('../../canvas/snapshot-nodes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotNodesModule>()),
  renderInkOcrRaster: rasterizeOcr,
  snapshotNodesToArtifacts: rasterize,
}));

vi.mock('./ink-ocr.js', () => ({
  isInkOcrConfigured,
  recognizeInk,
}));

import { buildChatEnvelope, InkVisualPreparationError } from './envelope.js';

import type * as SnapshotNodesModule from '../../canvas/snapshot-nodes.js';
import type { NodeContent, NodeSnapshot } from '../../storage/index.js';
import type { FastifyBaseLogger } from 'fastify';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function snapshot(nodeId: string, content: string): NodeSnapshot {
  return {
    record: {
      nodeId,
      type: 'note',
      label: `Label ${nodeId}`,
      content,
    } as NodeContent,
    revision: `revision-${nodeId}`,
  };
}

describe('buildChatEnvelope selection records', () => {
  const resource = {
    id: 'sigil',
    fingerprint: '0123456789abcdef',
    targetNodeId: 'child-1',
    targetType: 'note' as const,
    label: 'Frozen title',
    sourceBounds: { x: 0, y: 0, width: 40, height: 40 },
    sources: [1, 2, 3, 4].map((index) => ({
      nodeId: 'ink-1',
      strokeId: `stroke-${index}`,
    })),
  };

  function sigilInput() {
    const strokeIds = resource.sources.map((source) => source.strokeId);
    readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'ink-1',
            type: 'sketch',
            position: { x: 0, y: 0 },
            data: {
              initialSize: { width: 100, height: 100 },
              strokes: strokeIds.map((id) => ({
                id,
                points: [
                  [1, 2],
                  [3, 4],
                ],
                color: 'black',
                size: 2,
                createdAt: 0,
              })),
            },
          },
        ],
      },
    });
    return {
      inputKind: 'ink-intent' as const,
      content: '',
      canvasId: 'space',
      logger,
      selectedNodes: [{ id: 'ink-1', type: 'sketch' as const, strokeIds }],
      inkResources: [resource],
    };
  }

  it('prepares off-selection references without expanding the Lasso or changing frozen labels', async () => {
    const envelope = await buildChatEnvelope(sigilInput());
    expect(envelope.focus.selection.selectedIds).toEqual(['ink-1']);
    expect(envelope.focus.resources?.refs).toEqual([
      expect.objectContaining({ id: 'child-1', type: 'note' }),
    ]);
    expect(envelope.focus.resources?.bindings[0].label).toBe('Frozen title');
    expect(envelope.user.attachments).toEqual([]);
    expect(chatEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('deduplicates preparation against selected resources while retaining binding provenance', async () => {
    const input = sigilInput();
    const envelope = await buildChatEnvelope({
      ...input,
      selectedNodes: [...input.selectedNodes, { id: 'child-1', type: 'note' }],
    });
    expect(envelope.focus.resources?.refs).toEqual([]);
    expect(envelope.focus.resources?.bindings).toEqual([resource]);
  });

  it('rejects missing and wrong-type references instead of silently omitting them', async () => {
    const input = sigilInput();
    await expect(
      buildChatEnvelope({
        ...input,
        inkResources: [{ ...resource, targetNodeId: 'missing' }],
      }),
    ).rejects.toThrow('missing or changed type');
    await expect(
      buildChatEnvelope({
        ...input,
        inkResources: [{ ...resource, targetType: 'pdf' }],
      }),
    ).rejects.toThrow('missing or changed type');
  });

  it('uses the authoritative image source and fails explicitly when it is unavailable', async () => {
    const input = sigilInput();
    const imageRecord: NodeSnapshot = {
      record: {
        nodeId: 'image',
        type: 'image',
        label: 'Image',
        src: 'actual.png',
        content: '',
      },
      revision: 'rev',
    };
    readMany.mockResolvedValue(new Map([['image', imageRecord]]));
    const envelope = await buildChatEnvelope({
      ...input,
      inkResources: [
        { ...resource, targetNodeId: 'image', targetType: 'image' },
      ],
    });
    expect(envelope.focus.resources?.imageAttachments).toEqual([
      expect.objectContaining({ originNodeId: 'image', url: 'actual.png' }),
    ]);
    delete imageRecord.record.src;
    await expect(
      buildChatEnvelope({
        ...input,
        inkResources: [
          { ...resource, targetNodeId: 'image', targetType: 'image' },
        ],
      }),
    ).rejects.toThrow('no readable image source');
  });

  beforeEach(() => {
    rasterize.mockReset();
    rasterize.mockResolvedValue([
      { src: 'ink.png', originNodeIds: ['ink-1', 'ink-2'] },
    ]);
    rasterizeOcr.mockReset();
    rasterizeOcr.mockResolvedValue({
      png: Buffer.from('ocr'),
      width: 200,
      height: 100,
      originNodeIds: ['ink-1', 'ink-2'],
    });
    isInkOcrConfigured.mockReset();
    isInkOcrConfigured.mockReturnValue(false);
    recognizeInk.mockReset();
    readCanvas.mockReset();
    readCanvas.mockResolvedValue({
      state: {
        nodes: ['ink-1', 'ink-2'].map((id) => ({
          id,
          type: 'sketch',
          position: { x: 0, y: 0 },
          data: {
            initialSize: { width: 100, height: 100 },
            strokes: [
              {
                id: 'stroke-1',
                points: [
                  [1, 2],
                  [3, 4],
                ],
              },
            ],
          },
        })),
      },
    });
    readMany.mockReset();
    readMany.mockImplementation(async (nodeIds: readonly string[]) => {
      const available = new Map<string, NodeSnapshot>([
        ['frame-1', snapshot('frame-1', 'Frame body')],
        ['child-1', snapshot('child-1', 'Child body')],
      ]);
      return new Map(
        nodeIds.flatMap((nodeId) => {
          const record = available.get(nodeId);
          return record ? [[nodeId, record] as const] : [];
        }),
      );
    });
  });

  it('enriches recursively included frame children from their records', async () => {
    const envelope = await buildChatEnvelope({
      content: 'Review this frame',
      attachments: [],
      selectedNodes: [
        {
          id: 'frame-1',
          type: 'frame',
          children: [{ id: 'child-1', type: 'note' }],
        },
      ],
      canvasId: 'canvas-1',
      logger,
    });

    expect(readMany).toHaveBeenCalledWith(['frame-1', 'child-1']);
    expect(envelope.focus.selection.refs).toEqual([
      expect.objectContaining({ id: 'frame-1', preview: 'Frame body' }),
      expect.objectContaining({ id: 'child-1', preview: 'Child body' }),
    ]);
    expect(envelope.focus.selection.selectedIds).toEqual(['frame-1']);
  });

  it('persists full Text but only previews and references for Note and Frame directories', async () => {
    const content = 'Complete Text\n' + 'Full body. '.repeat(100);
    const envelope = await buildChatEnvelope({
      inputKind: 'selection-intent',
      content: '',
      canvasId: 'canvas-1',
      logger,
      selectedNodes: [
        { id: 'text', type: 'text', content },
        { id: 'child-1', type: 'note' },
        {
          id: 'frame-1',
          type: 'frame',
          referenceOnly: true,
          children: [
            { id: 'ink-1', type: 'sketch', referenceOnly: true },
            {
              id: 'image',
              type: 'image',
              referenceOnly: true,
              src: 'hidden.png',
            },
            { id: 'child-1', type: 'note', referenceOnly: true },
          ],
        },
      ],
    });
    expect(envelope.focus.selection.textContents).toEqual([
      { nodeId: 'text', content },
    ]);
    expect(envelope.focus.selection.refs.map((ref) => ref.id)).toEqual([
      'text',
      'child-1',
      'frame-1',
      'ink-1',
      'image',
    ]);
    expect(
      envelope.focus.selection.refs.find((ref) => ref.id === 'child-1'),
    ).toMatchObject({
      preview: 'Child body',
    });
    expect(envelope.focus.selection.snapshotAttachments).toEqual([]);
    expect(envelope.focus.selection.imageAttachments).toEqual([]);
    expect(rasterize).not.toHaveBeenCalled();
    expect(recognizeInk).not.toHaveBeenCalled();
    expect(
      chatEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope))),
    ).toEqual(envelope);
  });

  it('reads non-hydrated Text in full and fails explicitly when it is unavailable', async () => {
    const input = {
      inputKind: 'selection-intent' as const,
      content: '',
      canvasId: 'canvas-1',
      logger,
      selectedNodes: [{ id: 'child-1', type: 'text' as const }],
    };
    expect(
      (await buildChatEnvelope(input)).focus.selection.textContents,
    ).toEqual([{ nodeId: 'child-1', content: 'Child body' }]);
    await expect(
      buildChatEnvelope({
        ...input,
        selectedNodes: [{ id: 'missing', type: 'text' }],
      }),
    ).rejects.toThrow('Selected Text content is unavailable');
  });

  it('persists quoted comments through the validated envelope without changing ordinary text', async () => {
    const quotedComments = [
      {
        quote: 'Original reply',
        contextBefore: 'Before ',
        contextAfter: ' after',
        comment: 'Explain this.',
        source: {
          kind: 'note' as const,
          canvasId: 'space',
          nodeId: 'note',
          snapshotRevision: 'captured',
        },
      },
    ];
    const envelope = await buildChatEnvelope({
      content: '',
      quotedComments,
      canvasId: null,
      logger,
    });
    const restored = chatEnvelopeSchema.parse(
      JSON.parse(JSON.stringify(envelope)),
    );
    expect(restored.user).toEqual({
      text: '',
      attachments: [],
      quotedComments,
    });
    expect(readMany).not.toHaveBeenCalled();
  });

  it.each([undefined, 'text', 'ink-intent'] as const)(
    'preserves the optional input kind %s without changing legacy user fields',
    async (inputKind) => {
      const envelope = await buildChatEnvelope({
        content: 'Review this frame',
        inputKind,
        canvasId: 'canvas-1',
        selectedNodes: [
          { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] },
        ],
        logger,
      });

      expect(envelope.user).toStrictEqual({
        text: 'Review this frame',
        attachments: [],
        ...(inputKind ? { inputKind } : {}),
      });
      expect(chatEnvelopeSchema.parse(envelope)).toStrictEqual(envelope);
      expect(
        chatEnvelopeSchema.safeParse({
          ...envelope,
          user: { ...envelope.user, inputKind: 'ocr' },
        }).success,
      ).toBe(false);
    },
  );

  it('keeps every recursively selected partial Sketch in the snapshot KEEP-list', async () => {
    const envelope = await buildChatEnvelope({
      content: '',
      inputKind: 'ink-intent',
      canvasId: 'canvas-1',
      selectedNodes: [
        {
          id: 'frame-1',
          type: 'frame',
          children: [
            { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] },
            { id: 'ink-2', type: 'sketch', strokeIds: ['stroke-1'] },
          ],
        },
      ],
      logger,
    });

    expect(rasterize).toHaveBeenCalledExactlyOnceWith(
      {
        canvasId: 'canvas-1',
        nodeIds: ['ink-1', 'ink-2'],
        strokeSubsets: [
          { nodeId: 'ink-1', strokeIds: ['stroke-1'] },
          { nodeId: 'ink-2', strokeIds: ['stroke-1'] },
        ],
      },
      expect.any(Array),
    );
    expect(envelope.focus.selection.snapshotAttachments).toEqual([
      expect.objectContaining({ originNodeIds: ['ink-1', 'ink-2'] }),
    ]);
    expect(envelope.focus.selection.inkGeometry).toEqual(
      ['ink-1', 'ink-2'].map((nodeId) => ({
        nodeId,
        strokeIds: ['stroke-1'],
        bounds: { x: 1, y: 2, width: 2, height: 2 },
      })),
    );
  });

  it('freezes scaled partial-stroke bounds through nested frames with the raster snapshot', async () => {
    const ink = {
      id: 'ink-1',
      type: 'sketch',
      parentId: 'inner',
      position: { x: 10, y: 20 },
      style: { width: 200, height: 300 },
      data: {
        initialSize: { width: 100, height: 100 },
        strokes: [
          {
            id: 'stroke-1',
            points: [
              [1, 2],
              [3, 4],
            ],
          },
          {
            id: 'unselected',
            points: [
              [90, 90],
              [100, 100],
            ],
          },
        ],
      },
    };
    readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'outer',
            type: 'frame',
            position: { x: 100, y: 200 },
            data: {},
          },
          {
            id: 'inner',
            type: 'frame',
            parentId: 'outer',
            position: { x: 30, y: 40 },
            data: {},
          },
          ink,
          {
            id: 'owner',
            type: 'question',
            position: { x: 9000, y: 9000 },
            data: {},
          },
        ],
      },
    });
    rasterize.mockImplementationOnce(async () => {
      ink.position.x = 4000;
      ink.data.strokes[0].points = [[500, 500]];
      return [{ src: 'ink.png', originNodeIds: ['ink-1'] }];
    });
    const envelope = await buildChatEnvelope({
      content: '',
      inputKind: 'ink-intent',
      canvasId: 'canvas-1',
      selectedNodes: [{ id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] }],
      logger,
    });
    expect(envelope.focus.selection.inkGeometry).toEqual([
      {
        nodeId: 'ink-1',
        strokeIds: ['stroke-1'],
        bounds: { x: 142, y: 266, width: 4, height: 6 },
      },
    ]);
    expect(
      chatEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope))).focus
        .selection.inkGeometry,
    ).toEqual(envelope.focus.selection.inkGeometry);
  });

  it('rejects a partially stale Ink selection rather than shrinking its spatial evidence', async () => {
    await expect(
      buildChatEnvelope({
        content: '',
        inputKind: 'ink-intent',
        canvasId: 'canvas-1',
        selectedNodes: [
          { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1', 'missing'] },
        ],
        logger,
      }),
    ).rejects.toBeInstanceOf(InkVisualPreparationError);
  });

  it('attaches OCR derived from the same captured nodes as the required visual', async () => {
    isInkOcrConfigured.mockReturnValue(true);
    recognizeInk.mockResolvedValue({
      provider: 'azure-vision',
      apiVersion: '2024-02-01',
      originNodeIds: ['ink-1'],
      lines: [{ text: '手写问题', confidence: 0.9 }],
    });

    const envelope = await buildChatEnvelope({
      content: '',
      inputKind: 'ink-intent',
      canvasId: 'canvas-1',
      selectedNodes: [{ id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] }],
      logger,
    });

    expect(rasterizeOcr).toHaveBeenCalledExactlyOnceWith(
      rasterize.mock.calls[0]?.[1],
      [{ nodeId: 'ink-1', strokeIds: ['stroke-1'] }],
    );
    expect(recognizeInk).toHaveBeenCalledWith({
      raster: expect.objectContaining({ originNodeIds: ['ink-1', 'ink-2'] }),
      logger,
      signal: undefined,
    });
    expect(envelope.focus.selection.inkRecognition).toEqual({
      provider: 'azure-vision',
      apiVersion: '2024-02-01',
      originNodeIds: ['ink-1'],
      lines: [{ text: '手写问题', confidence: 0.9 }],
    });
  });

  it('continues image-only when optional OCR raster preparation fails', async () => {
    isInkOcrConfigured.mockReturnValue(true);
    rasterizeOcr.mockRejectedValue(new Error('private raster failure'));

    const envelope = await buildChatEnvelope({
      content: '',
      inputKind: 'ink-intent',
      canvasId: 'canvas-1',
      selectedNodes: [{ id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] }],
      logger,
    });

    expect(envelope.focus.selection.inkRecognition).toBeUndefined();
    expect(recognizeInk).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { outcome: 'raster_error', nodeCount: 1 },
      '[ink-ocr] optional raster preparation failed',
    );
  });

  it('propagates user cancellation instead of starting image-only execution', async () => {
    const controller = new AbortController();
    isInkOcrConfigured.mockReturnValue(true);
    recognizeInk.mockImplementation(async () => {
      controller.abort();
      return undefined;
    });

    await expect(
      buildChatEnvelope({
        content: '',
        inputKind: 'ink-intent',
        canvasId: 'canvas-1',
        selectedNodes: [
          { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] },
        ],
        logger,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([
    { result: [], missingIds: ['ink-1', 'ink-2'] },
    {
      result: [{ src: 'other.png', originNodeIds: ['other-image'] }],
      missingIds: ['ink-1', 'ink-2'],
    },
    {
      result: [{ src: 'ink.png', originNodeIds: ['ink-1'] }],
      missingIds: ['ink-2'],
    },
    {
      result: [{ src: '', originNodeIds: ['ink-1', 'ink-2'] }],
      missingIds: ['ink-1', 'ink-2'],
    },
  ])(
    'rejects a snapshot result that omits a required source: %j',
    async ({ result, missingIds }) => {
      rasterize.mockResolvedValue(result);
      await expect(
        buildChatEnvelope({
          content: '',
          inputKind: 'ink-intent',
          canvasId: 'canvas-1',
          selectedNodes: [
            { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] },
            { id: 'ink-2', type: 'sketch', strokeIds: ['stroke-1'] },
          ],
          attachments: [
            { type: 'image', source: 'upload', url: 'unrelated.png' },
          ],
          logger,
        }),
      ).rejects.toMatchObject({
        name: 'InkVisualPreparationError',
        nodeIds: missingIds,
        cause: undefined,
      });
      expect(rasterize).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, 'text', 'ink-intent'] as const)(
    'only requires snapshots for Ink, input kind %s',
    async (inputKind) => {
      const cause = new Error('snapshot failed');
      rasterize.mockRejectedValue(cause);
      const pending = buildChatEnvelope({
        content: 'look',
        inputKind,
        canvasId: 'canvas-1',
        selectedNodes: [
          { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] },
        ],
        logger,
      });
      if (inputKind === 'ink-intent') {
        await expect(pending).rejects.toMatchObject({
          name: 'InkVisualPreparationError',
          code: 'ink_visual_unavailable',
          nodeIds: ['ink-1'],
          cause,
        });
      } else {
        expect((await pending).focus.selection.snapshotAttachments).toEqual([]);
        expect(readCanvas).not.toHaveBeenCalled();
      }
      expect(rasterize).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { nodes: [] },
    { nodes: [{ id: 'ink-1', type: 'image' }] },
    { nodes: [{ id: 'ink-1', type: 'sketch', data: { strokes: [] } }] },
    {
      nodes: [
        {
          id: 'ink-1',
          type: 'sketch',
          data: { strokes: [{ id: 'other', points: [[1, 2]] }] },
        },
      ],
    },
    {
      nodes: [
        {
          id: 'ink-1',
          type: 'sketch',
          data: {
            initialSize: { width: 100, height: 100 },
            strokes: [{ id: 'stroke-1', points: [] }],
          },
        },
      ],
    },
  ])('never widens a stale or unpaintable subset: %j', async (state) => {
    readCanvas.mockResolvedValue({ state });
    await expect(
      buildChatEnvelope({
        content: '',
        inputKind: 'ink-intent',
        canvasId: 'canvas-1',
        selectedNodes: [
          { id: 'ink-1', type: 'sketch', strokeIds: ['stroke-1'] },
        ],
        logger,
      }),
    ).rejects.toBeInstanceOf(InkVisualPreparationError);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it.each([null, 'canvas-1'])(
    'rejects Ink without a bounded source on %s',
    async (canvasId) => {
      await expect(
        buildChatEnvelope({
          content: '',
          inputKind: 'ink-intent',
          canvasId,
          logger,
        }),
      ).rejects.toBeInstanceOf(InkVisualPreparationError);
      expect(rasterize).not.toHaveBeenCalled();
    },
  );
});
