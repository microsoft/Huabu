import { describe, expect, it } from 'vitest';

import { positionMessageListOnOpen } from './messageListScroll';

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
