// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { chatInputText } from './chat-input.js';

describe('chatInputText', () => {
  it('preserves legacy user text', () => {
    expect(chatInputText({ text: 'Original text' })).toBe('Original text');
  });

  it('includes quote-only messages and general instructions without hidden context', () => {
    const quotedComments = [
      {
        quote: 'First\n\n    indented',
        contextBefore: 'Hidden context',
        contextAfter: 'Hidden context',
        comment: 'Explain this.',
      },
    ];
    expect(chatInputText({ text: '', quotedComments })).toBe(
      '> First\n> \n>     indented\n\nExplain this.',
    );
    expect(
      chatInputText({ text: 'General instructions', quotedComments }),
    ).toBe(
      '> First\n> \n>     indented\n\nExplain this.\n\nGeneral instructions',
    );
  });
});
