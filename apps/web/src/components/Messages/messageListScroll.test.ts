// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  forgetMessageListScrollPosition,
  positionMessageListOnOpen,
  rememberMessageListScrollPosition,
  restoreMessageListScrollPosition,
} from './messageListScroll';

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 300,
    bottom: top + height,
    left: 0,
    width: 300,
    height,
    toJSON: () => ({}),
  };
}

describe('positionMessageListOnOpen', () => {
  it('places the last user message at the top for an unread conversation', () => {
    const container = document.createElement('div');
    const firstUserMessage = document.createElement('div');
    const lastUserMessage = document.createElement('div');
    firstUserMessage.dataset.chatUserMessage = '';
    lastUserMessage.dataset.chatUserMessage = '';
    container.append(firstUserMessage, lastUserMessage);

    container.getBoundingClientRect = () => rect(100, 200);
    firstUserMessage.getBoundingClientRect = () => rect(250, 50);
    lastUserMessage.getBoundingClientRect = () => rect(500, 50);

    expect(positionMessageListOnOpen(container, 'last-user')).toBe('last-user');
    expect(container.scrollTop).toBe(400);
  });

  it('opens a previously read conversation at its final message', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', { value: 900 });

    expect(positionMessageListOnOpen(container, 'bottom')).toBe('bottom');
    expect(container.scrollTop).toBe(900);
  });
});

describe('per-view scroll positions', () => {
  it('restores the exact position saved for a thread', () => {
    const container = document.createElement('div');
    rememberMessageListScrollPosition('thread-1', 240);

    expect(restoreMessageListScrollPosition(container, 'thread-1')).toBe(true);
    expect(container.scrollTop).toBe(240);
  });

  it('keeps positions isolated between threads', () => {
    const container = document.createElement('div');
    rememberMessageListScrollPosition('isolated-thread-2', 120);

    expect(
      restoreMessageListScrollPosition(container, 'isolated-thread-1'),
    ).toBe(false);
    expect(container.scrollTop).toBe(0);
  });

  it('forgets the position when a conversation view is closed', () => {
    const container = document.createElement('div');
    rememberMessageListScrollPosition('closed-thread', 360);

    forgetMessageListScrollPosition('closed-thread');

    expect(restoreMessageListScrollPosition(container, 'closed-thread')).toBe(
      false,
    );
  });

  it('retains positions when more than 50 conversations are visited', () => {
    for (let index = 0; index <= 50; index += 1) {
      rememberMessageListScrollPosition(`retained-thread-${index}`, index);
    }
    const container = document.createElement('div');

    expect(
      restoreMessageListScrollPosition(container, 'retained-thread-0'),
    ).toBe(true);
    expect(container.scrollTop).toBe(0);
    expect(
      restoreMessageListScrollPosition(container, 'retained-thread-50'),
    ).toBe(true);
    expect(container.scrollTop).toBe(50);
  });
});
