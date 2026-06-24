import { describe, expect, it } from 'vitest';

import {
  appendMetadataTags,
  stripMetadataTags,
  type UserMessageMetadata,
} from './user-message-metadata.js';

import type { ChatAttachment } from '@sediment/shared';

describe('appendMetadataTags / stripMetadataTags round-trip', () => {
  it('round-trips all UI breadcrumbs from a plain-string body', () => {
    const attachments: ChatAttachment[] = [
      {
        type: 'image',
        source: 'upload',
        url: 'artifact://abc',
        label: 'Butterfly',
      },
    ];
    const meta: UserMessageMetadata = {
      selectedNodeIds: ['n1', 'n2'],
      attachments,
      invokedSkills: ['expert-review'],
    };
    const tagged = appendMetadataTags('hello world', meta);
    expect(typeof tagged).toBe('string');

    const { content, meta: parsed } = stripMetadataTags(tagged as string);
    expect(content).toBe('hello world');
    expect(parsed.selectedNodeIds).toEqual(['n1', 'n2']);
    expect(parsed.invokedSkills).toEqual(['expert-review']);
    expect(parsed.attachments).toEqual([
      {
        type: 'image',
        source: 'upload',
        url: 'artifact://abc',
        label: 'Butterfly',
      },
    ]);
  });

  it('round-trips attachments through the multipart content path', () => {
    const parts = [
      { type: 'text' as const, text: 'describe this' },
      { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' },
    ];
    const meta: UserMessageMetadata = {
      attachments: [
        { type: 'image', source: 'upload', url: 'artifact://photo.png' },
      ],
    };
    const tagged = appendMetadataTags(parts, meta);
    expect(Array.isArray(tagged)).toBe(true);
    const arr = tagged as typeof parts;
    expect(arr).toHaveLength(3);
    expect(arr[2]).toMatchObject({ type: 'text' });

    // Stripping operates on the persisted string form: the trailing
    // text part is what carries the tags.
    const lastText = arr[arr.length - 1];
    if (lastText.type !== 'text') throw new Error('expected text part');
    const { meta: parsed } = stripMetadataTags(lastText.text);
    expect(parsed.attachments?.[0]?.url).toBe('artifact://photo.png');
  });

  it('filters sketch-raster attachments out of the persisted UI breadcrumb and auto-derives the hint', () => {
    const tagged = appendMetadataTags('redo this', {
      attachments: [
        {
          type: 'image',
          source: 'selection',
          url: 'sketch-raster-deadbeef.png',
          originNodeIds: ['node-1234567890abc', 'node-fedcba0987654'],
          label: 'Sketch cluster',
        },
      ],
    });
    const { meta } = stripMetadataTags(tagged as string);
    // No user-visible attachments → no breadcrumb chip on rehydrate.
    expect(meta.attachments).toBeUndefined();
    // Hint tag is auto-derived from the sketch-raster subset.
    expect(meta.hint).toContain('sketch-raster-deadbeef.png');
    expect(meta.hint).toContain('node-12345678');
  });

  it('keeps user-visible attachments while still hinting about sketch-rasters in the same turn', () => {
    const tagged = appendMetadataTags('mix', {
      attachments: [
        { type: 'image', source: 'upload', url: 'artifact://user.png' },
        {
          type: 'image',
          source: 'selection',
          url: 'sketch-raster-cafe.png',
          originNodeIds: ['node-abc1234567890'],
        },
      ],
    });
    const { meta } = stripMetadataTags(tagged as string);
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments?.[0]?.url).toBe('artifact://user.png');
    expect(meta.hint).toContain('sketch-raster-cafe.png');
  });

  it('drops selection-sourced attachments whose origin is already in selectedNodeIds', () => {
    // The image node is already represented by `selectedNodeIds`;
    // the auto-derived vision attachment must not show up as a
    // second chip on rehydrate.
    const tagged = appendMetadataTags('look', {
      selectedNodeIds: ['img-node-1', 'sketch-node-1'],
      attachments: [
        {
          type: 'image',
          source: 'selection',
          url: 'artifact://cat.png',
          label: 'Cute cat',
          originNodeId: 'img-node-1',
        },
        { type: 'image', source: 'upload', url: 'artifact://uploaded.png' },
      ],
    });
    const { meta } = stripMetadataTags(tagged as string);
    expect(meta.selectedNodeIds).toEqual(['img-node-1', 'sketch-node-1']);
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments?.[0]?.url).toBe('artifact://uploaded.png');
  });

  it('keeps a selection-sourced attachment whose origin is NOT covered by selectedNodeIds', () => {
    // Defensive: if a selection-sourced attachment somehow points at
    // a node outside the current selection, preserve it so the user
    // does not silently lose the reference.
    const tagged = appendMetadataTags('look', {
      selectedNodeIds: ['other-node'],
      attachments: [
        {
          type: 'image',
          source: 'selection',
          url: 'artifact://cat.png',
          originNodeId: 'img-node-1',
        },
      ],
    });
    const { meta } = stripMetadataTags(tagged as string);
    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments?.[0]?.url).toBe('artifact://cat.png');
  });

  it('lets an explicit hint override the auto-derived one', () => {
    const tagged = appendMetadataTags('go', {
      attachments: [
        {
          type: 'image',
          source: 'selection',
          url: 'sketch-raster-aaa.png',
          originNodeIds: ['node-x'],
        },
      ],
      hint: 'custom directive',
    });
    const { meta } = stripMetadataTags(tagged as string);
    expect(meta.hint).toBe('custom directive');
  });

  it('strips the LLM-only hint without leaking it as user-visible text', () => {
    const tagged = appendMetadataTags('go ahead', {
      hint: 'reuse sketch-raster-abc.png for node n1',
    });
    const { content, meta } = stripMetadataTags(tagged as string);
    expect(content).toBe('go ahead');
    // hint MAY be parsed back into meta, but the visible content
    // must never carry the tag.
    expect(content).not.toContain('[SYSTEM hint');
    expect(meta.hint).toBeDefined();
  });

  it('returns content unchanged when no metadata is supplied', () => {
    expect(appendMetadataTags('plain', {})).toBe('plain');
  });

  it('skips empty arrays and empty strings', () => {
    expect(
      appendMetadataTags('plain', {
        selectedNodeIds: [],
        invokedSkills: [],
        attachments: [],
        hint: '',
      }),
    ).toBe('plain');
  });

  it('still strips a malformed JSON tag while dropping the decoded value', () => {
    const corrupt =
      'hi\n[SYSTEM selectedNodeIds:[not, valid]]\n[SYSTEM invokedSkills:["s1"]]';
    const { content, meta } = stripMetadataTags(corrupt);
    expect(content).toBe('hi');
    expect(meta.selectedNodeIds).toBeUndefined();
    expect(meta.invokedSkills).toEqual(['s1']);
  });

  it('parses a legacy history line with a space after the hint colon', () => {
    // The original Option-B writer emitted "[SYSTEM hint: <text>]" with
    // a leading space. The refactored writer omits the space; older
    // chat history files must still rehydrate cleanly.
    const legacy =
      'hello\n[SYSTEM hint: pre-rasterized sketch artifacts are ready]';
    const { content } = stripMetadataTags(legacy);
    expect(content).toBe('hello');
  });
});
