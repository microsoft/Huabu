// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { conversationAttention, mostPressing } from './attention';

describe('attention', () => {
  it('puts an approval before a failure before a finished turn', () => {
    expect(mostPressing([])).toBeNull();
    expect(mostPressing(['done', 'approval', 'error'])).toBe('approval');
    expect(mostPressing(['done', 'error', 'done'])).toBe('error');
  });

  it('counts a finished or failed turn until it has been viewed', () => {
    expect(conversationAttention('done', false, false)).toBe('done');
    expect(conversationAttention('error', false, false)).toBe('error');
    expect(conversationAttention('done', true, false)).toBeNull();
    expect(conversationAttention('running', false, false)).toBeNull();
    expect(conversationAttention('idle', false, false)).toBeNull();
  });

  it('shows a pending approval whatever else is true', () => {
    expect(conversationAttention('running', false, true)).toBe('approval');
    expect(conversationAttention('done', true, true)).toBe('approval');
  });
});
