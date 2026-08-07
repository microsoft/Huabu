// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  isSketchRasterAttachment,
  projectUserVisibleAttachments,
  selectUserVisibleAttachments,
} from './attachment-chips.js';

import type { ChatAttachment } from '@huabu/shared';

describe('selectUserVisibleAttachments', () => {
  it('drops sketch-raster artifacts', () => {
    const result = selectUserVisibleAttachments(
      [
        {
          type: 'image',
          source: 'selection',
          url: 'sketch-raster-xyz.png',
          originNodeIds: ['node-1'],
        },
        { type: 'image', source: 'upload', url: 'artifact://keep.png' },
      ],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('artifact://keep.png');
  });

  it('drops selection items whose origin nodes are all already selected', () => {
    const result = selectUserVisibleAttachments(
      [
        {
          type: 'image',
          source: 'selection',
          url: 'artifact://cat.png',
          originNodeId: 'img-node-1',
        },
      ],
      ['img-node-1'],
    );
    expect(result).toHaveLength(0);
  });

  it('keeps a selection item whose origin is NOT covered by the selection', () => {
    const result = selectUserVisibleAttachments(
      [
        {
          type: 'image',
          source: 'selection',
          url: 'artifact://cat.png',
          originNodeId: 'img-node-1',
        },
      ],
      ['other-node'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('artifact://cat.png');
  });

  it('keeps a multi-origin selection item unless EVERY origin is selected', () => {
    const att: ChatAttachment = {
      type: 'image',
      source: 'selection',
      url: 'artifact://cluster.png',
      originNodeIds: ['a', 'b'],
    };
    // Only one of the two origins is selected → still visible.
    expect(selectUserVisibleAttachments([att], ['a'])).toHaveLength(1);
    // Both origins selected → covered by node chips, hidden.
    expect(selectUserVisibleAttachments([att], ['a', 'b'])).toHaveLength(0);
  });

  it('always keeps non-selection (uploaded) attachments', () => {
    const result = selectUserVisibleAttachments(
      [{ type: 'image', source: 'upload', url: 'artifact://up.png' }],
      ['anything'],
    );
    expect(result).toHaveLength(1);
  });
});

describe('projectUserVisibleAttachments', () => {
  it('strips the bulky content body while keeping identity + label + url', () => {
    const projected = projectUserVisibleAttachments(
      [
        {
          type: 'file',
          source: 'upload',
          url: 'artifact://doc.txt',
          label: 'Doc',
          filename: 'doc.txt',
          content: 'a very long body that should not survive projection',
        } as ChatAttachment,
      ],
      [],
    );
    expect(projected).toHaveLength(1);
    const [first] = projected;
    expect(first).toEqual({
      type: 'file',
      source: 'upload',
      url: 'artifact://doc.txt',
      label: 'Doc',
      filename: 'doc.txt',
    });
    expect(first && 'content' in first).toBe(false);
  });
});

describe('isSketchRasterAttachment', () => {
  it('matches image attachments whose url starts with sketch-raster-', () => {
    expect(
      isSketchRasterAttachment({
        type: 'image',
        source: 'selection',
        url: 'sketch-raster-abc.png',
      }),
    ).toBe(true);
  });

  it('rejects non-image or non-sketch-raster attachments', () => {
    expect(
      isSketchRasterAttachment({
        type: 'image',
        source: 'upload',
        url: 'artifact://photo.png',
      }),
    ).toBe(false);
    expect(
      isSketchRasterAttachment({
        type: 'file',
        source: 'upload',
        url: 'sketch-raster-abc.png',
      }),
    ).toBe(false);
  });
});
