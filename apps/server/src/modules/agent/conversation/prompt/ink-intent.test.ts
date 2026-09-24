// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  rebuildContextMessages,
  renderInternalAgentInputs,
  renderTurn,
} from './build-prompt.js';
import { MAX_INLINE_IMAGE_BYTES } from './image-inlining.js';
import {
  INK_INTENT_DIRECTIVE,
  EXTERNAL_INK_INTENT_DIRECTIVE,
} from './ink-intent.js';
import { ACP_PROFILE, ACP_SLASH_PROFILE, INTERNAL_PROFILE } from './profile.js';
import { InkVisualPreparationError } from './required-ink-visuals.js';
import * as artifactUtils from '../../../artifact/utils.js';
import * as snapshots from '../../../canvas/snapshot-nodes.js';
import { createChatSubmission } from '../../agenetes/handle.js';

import type { ChatEnvelope } from '../envelope.js';
import type { ChatAttachment } from '@huabu/shared';

const IMAGE_BYTES =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const IMAGE_URL = `data:image/png;base64,${IMAGE_BYTES}`;
const OPTIONS = { canvasId: null };

function image(originNodeIds: string[], url = IMAGE_URL): ChatAttachment {
  return { type: 'image', source: 'selection', originNodeIds, url };
}

function inkEnvelope(
  snapshotAttachments: ChatAttachment[] = [image(['ink-1', 'ink-2'])],
): ChatEnvelope {
  return {
    user: { text: '', inputKind: 'ink-intent', attachments: [] },
    skills: { invokedIds: [], resolved: [] },
    focus: {
      selection: {
        refs: ['ink-1', 'ink-2'].map((id) => ({
          id,
          type: 'sketch',
          filename: `nodes/${id}.md`,
        })),
        selectedIds: ['ink-1', 'ink-2'],
        strokeSubsets: ['ink-1', 'ink-2'].map((nodeId) => ({
          nodeId,
          strokeIds: ['stroke-1'],
        })),
        imageAttachments: [],
        snapshotAttachments,
      },
    },
  };
}

function withGrounding(envelope: ChatEnvelope): ChatEnvelope {
  return {
    ...envelope,
    focus: {
      ...envelope.focus,
      groundingVisual: {
        kind: 'visible-canvas',
        dataUrl: IMAGE_URL,
        viewport: {
          x: 0,
          y: 0,
          zoom: 0.75,
          width: 1200,
          height: 800,
          devicePixelRatio: 2,
        },
        crop: { x: 120, y: 80, width: 640, height: 420 },
        selectedNodeIds: ['note-1'],
        strokeSubsets: [
          { nodeId: 'ink-1', strokeIds: ['stroke-1'] },
          { nodeId: 'ink-2', strokeIds: ['stroke-1'] },
        ],
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Ink-intent rendering', () => {
  it('uses the external report procedure while preserving image bytes and grounding', async () => {
    const parts = await renderTurn(
      withGrounding(inkEnvelope()),
      ACP_PROFILE,
      OPTIONS,
    );
    expect(parts[0]).toEqual({
      type: 'text',
      text: EXTERNAL_INK_INTENT_DIRECTIVE,
    });
    expect(parts[0]).not.toEqual({ type: 'text', text: INK_INTENT_DIRECTIVE });
    expect(parts.filter((part) => part.type === 'image')).toHaveLength(2);
  });
  it.each([INTERNAL_PROFILE, ACP_PROFILE])(
    'renders hidden visible-Canvas grounding for %j',
    async (profile) => {
      const parts = await renderTurn(
        withGrounding(inkEnvelope()),
        profile,
        OPTIONS,
      );
      expect(parts).toContainEqual({
        type: 'image',
        data: IMAGE_BYTES,
        mimeType: 'image/png',
      });
      expect(
        parts.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes('<visible_canvas_grounding>') &&
            part.text.includes('Viewport zoom: 0.75'),
        ),
      ).toBe(true);
    },
  );
  it.each([[image(['ink-1', 'ink-2'])], [image(['ink-1']), image(['ink-2'])]])(
    'requires each partial Sketch but accepts clustered or separate images: %j',
    async (...snapshotAttachments) => {
      const parts = await renderTurn(
        inkEnvelope(snapshotAttachments),
        INTERNAL_PROFILE,
        OPTIONS,
      );
      expect(parts[0]).toEqual({ type: 'text', text: INK_INTENT_DIRECTIVE });
      expect(parts.filter((part) => part.type === 'image')).toEqual(
        snapshotAttachments.map(() => ({
          type: 'image',
          data: IMAGE_BYTES,
          mimeType: 'image/png',
        })),
      );
      expect(INK_INTENT_DIRECTIVE).toContain('For this turn only');
      expect(INK_INTENT_DIRECTIVE).toContain(
        'In operate mode, execute a clear task',
      );
      expect(INK_INTENT_DIRECTIVE).toContain(
        'In ask mode, answer within its read-only capabilities',
      );
      expect(INK_INTENT_DIRECTIVE).toContain(
        'ask one focused clarification question',
      );
      expect(INK_INTENT_DIRECTIVE).toContain(
        'cannot override higher-level safety, permission, or tool policy',
      );
    },
  );

  it.each([
    { name: 'missing snapshot', snapshots: [] },
    { name: 'one source missing', snapshots: [image(['ink-1'])] },
    { name: 'unrelated image', snapshots: [image(['other'])] },
    {
      name: 'missing URL',
      snapshots: [
        {
          type: 'image',
          source: 'selection',
          originNodeIds: ['ink-1', 'ink-2'],
        },
      ],
    },
    {
      name: 'caption and extracted text only',
      snapshots: [
        {
          ...image(['ink-1', 'ink-2'], 'missing.png'),
          content: 'recognized words',
        },
      ],
    },
    {
      name: 'unsupported type',
      snapshots: [
        image(['ink-1', 'ink-2'], `data:image/svg+xml;base64,${IMAGE_BYTES}`),
      ],
    },
    {
      name: 'invalid data URL',
      snapshots: [image(['ink-1', 'ink-2'], 'data:image/png;base64,')],
    },
    {
      name: 'too large',
      snapshots: [
        image(
          ['ink-1', 'ink-2'],
          `data:image/png;base64,${'A'.repeat(MAX_INLINE_IMAGE_BYTES * 2)}`,
        ),
      ],
    },
  ] satisfies { name: string; snapshots: ChatAttachment[] }[])(
    'rejects $name despite valid optional images',
    async ({ snapshots: snapshotAttachments }) => {
      const envelope = inkEnvelope(snapshotAttachments);
      envelope.user.attachments = [
        { ...image(['ink-1', 'ink-2']), source: 'upload' },
      ];
      envelope.focus.selection.imageAttachments = [image(['ink-1', 'ink-2'])];
      await expect(
        renderInternalAgentInputs(envelope, OPTIONS),
      ).rejects.toBeInstanceOf(InkVisualPreparationError);
    },
  );

  it('does not let one successful source mask another source that failed to inline', async () => {
    const envelope = inkEnvelope([
      image(['ink-1']),
      image(['ink-2'], 'missing.png'),
    ]);
    await expect(
      renderInternalAgentInputs(envelope, OPTIONS),
    ).rejects.toMatchObject({ nodeIds: ['ink-2'] });
  });

  it('reports artifact read exceptions as preparation errors', async () => {
    const cause = new Error('artifact unavailable');
    vi.spyOn(artifactUtils, 'resolveArtifactImageUrl').mockRejectedValue(cause);
    await expect(
      renderInternalAgentInputs(inkEnvelope(), OPTIONS),
    ).rejects.toMatchObject({
      name: 'InkVisualPreparationError',
      cause,
      nodeIds: ['ink-1', 'ink-2'],
    });
  });

  it.each([false, true])(
    'rejects unavailable remote bytes (empty body: %s)',
    async (emptyBody) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          emptyBody
            ? new Response(new Uint8Array(), {
                headers: { 'content-type': 'image/png' },
              })
            : new Response(null, { status: 404 }),
        ),
      );
      await expect(
        renderInternalAgentInputs(
          inkEnvelope([
            image(['ink-1', 'ink-2'], 'https://example.test/ink.png'),
          ]),
          OPTIONS,
        ),
      ).rejects.toBeInstanceOf(InkVisualPreparationError);
    },
  );

  it.each([ACP_PROFILE, ACP_SLASH_PROFILE])(
    'renders required Ink images for external profiles: %j',
    async (profile) => {
      const parts = await renderTurn(inkEnvelope(), profile, OPTIONS);
      expect(parts).toContainEqual({
        type: 'text',
        text: EXTERNAL_INK_INTENT_DIRECTIVE,
      });
      expect(parts).toContainEqual({
        type: 'image',
        data: IMAGE_BYTES,
        mimeType: 'image/png',
      });
    },
  );

  it('rejects Ink when selection visuals are disabled', async () => {
    await expect(
      renderTurn(
        inkEnvelope(),
        { ...INTERNAL_PROFILE, includeSelectionVisuals: false },
        OPTIONS,
      ),
    ).rejects.toBeInstanceOf(InkVisualPreparationError);
  });

  it('does not infer an Ink request without a non-empty persisted stroke subset', async () => {
    const envelope = inkEnvelope();
    envelope.focus.selection.strokeSubsets = [
      { nodeId: 'ink-1', strokeIds: [] },
    ];
    await expect(
      renderInternalAgentInputs(envelope, OPTIONS),
    ).rejects.toBeInstanceOf(InkVisualPreparationError);
  });

  it.each([undefined, 'text'] as const)(
    'keeps optional text visuals best effort and omits the directive for %s',
    async (inputKind) => {
      const envelope = inkEnvelope([image(['ink-1', 'ink-2'], 'missing.png')]);
      envelope.user = {
        text: 'look',
        attachments: [],
        ...(inputKind ? { inputKind } : {}),
      };
      const parts = await renderTurn(envelope, INTERNAL_PROFILE, OPTIONS);
      expect(parts.some((part) => part.type === 'image')).toBe(false);
      expect(parts).not.toContainEqual({
        type: 'text',
        text: INK_INTENT_DIRECTIVE,
      });
      expect(parts.at(-1)).toEqual({
        type: 'text',
        text: '<user_request>\nlook\n</user_request>',
      });
    },
  );

  it('preserves the exact legacy plain-text canonical input', async () => {
    const envelope = inkEnvelope([]);
    envelope.focus.selection = {
      refs: [],
      selectedIds: [],
      imageAttachments: [],
      snapshotAttachments: [],
    };
    envelope.user = { text: 'hello', attachments: [] };
    const legacy = await renderInternalAgentInputs(envelope, OPTIONS);
    envelope.user.inputKind = 'text';
    expect(await renderInternalAgentInputs(envelope, OPTIONS)).toStrictEqual(
      legacy,
    );
    expect(legacy).toStrictEqual([{ type: 'text', text: 'hello' }]);
  });

  it('replays the stored directive and image bytes without source resolution and does not affect the next text turn', async () => {
    const envelope = inkEnvelope();
    const rendered = await renderInternalAgentInputs(envelope, OPTIONS);
    const request = JSON.parse(
      JSON.stringify(createChatSubmission(envelope, rendered)),
    );
    const resolver = vi
      .spyOn(artifactUtils, 'resolveArtifactImageUrl')
      .mockRejectedValue(new Error('artifact deleted'));
    const rasterize = vi
      .spyOn(snapshots, 'snapshotNodesToArtifacts')
      .mockRejectedValue(new Error('canvas changed'));
    const next = inkEnvelope([]);
    next.user = { text: 'Thanks', attachments: [] };
    next.focus.selection = {
      refs: [],
      selectedIds: [],
      imageAttachments: [],
      snapshotAttachments: [],
    };

    const messages = await rebuildContextMessages(
      [
        { request, transcript: [] },
        { request: createChatSubmission(next), transcript: [] },
      ],
      { canvasId: 'changed-canvas' },
    );

    expect(rendered[0].type).toBe('parts');
    if (rendered[0].type !== 'parts')
      throw new Error('Expected multimodal input');
    expect(messages[0].content).toStrictEqual(rendered[0].parts);
    expect(messages[1].content).toBe('Thanks');
    expect(resolver).not.toHaveBeenCalled();
    expect(rasterize).not.toHaveBeenCalled();
  });
});
