// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import {
  forgetMessageListScrollCanvas,
  forgetMessageListScrollTarget,
  messageListViewKey,
  nodePreviewViewKey,
  reconcileMessageListScrollTargets,
  registerMessageListScrollTarget,
  replaceMessageListScrollTarget,
} from '@/store/previewWorkspace/scrollMemory';

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
  it('isolates node and Chat positions with matching Canvas and target ids', () => {
    const chatViewKey = messageListViewKey('canvas-shared', 'target-shared');
    const nodeViewKey = nodePreviewViewKey('canvas-shared', 'target-shared');
    rememberMessageListScrollPosition(chatViewKey, 120);
    rememberMessageListScrollPosition(nodeViewKey, 240);

    const container = document.createElement('div');
    expect(restoreMessageListScrollPosition(container, chatViewKey)).toBe(true);
    expect(container.scrollTop).toBe(120);
    expect(restoreMessageListScrollPosition(container, nodeViewKey)).toBe(true);
    expect(container.scrollTop).toBe(240);
  });

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

  it('forgets a Question target by its conversation-owner view key', () => {
    const target = {
      kind: 'node' as const,
      canvasId: 'world-canvas',
      nodeId: 'question-ref',
    };
    const viewKey = 'source-canvas:question-thread';
    registerMessageListScrollTarget(target, viewKey);
    rememberMessageListScrollPosition(viewKey, 180);

    forgetMessageListScrollTarget(target);

    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(false);
  });

  it('retains a shared conversation until its final target is removed', () => {
    const viewKey = 'source-canvas:shared-thread';
    const first = {
      kind: 'node' as const,
      canvasId: 'world-a',
      nodeId: 'question-ref-a',
    };
    const second = {
      kind: 'node' as const,
      canvasId: 'world-b',
      nodeId: 'question-ref-b',
    };
    registerMessageListScrollTarget(first, viewKey);
    registerMessageListScrollTarget(second, viewKey);
    rememberMessageListScrollPosition(viewKey, 220);

    forgetMessageListScrollTarget(first);
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(true);

    forgetMessageListScrollTarget(second);
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(false);
  });

  it('retains a shared conversation when the remaining target never mounted', () => {
    const viewKey = 'source-canvas:unmounted-shared-thread';
    const mounted = {
      kind: 'node' as const,
      canvasId: 'world-shared',
      nodeId: 'mounted-question-ref',
    };
    const unmounted = {
      kind: 'node' as const,
      canvasId: 'world-shared',
      nodeId: 'unmounted-question-ref',
    };
    registerMessageListScrollTarget(mounted, viewKey);
    rememberMessageListScrollPosition(viewKey, 230);

    reconcileMessageListScrollTargets('world-shared', [
      { target: unmounted, viewKey },
    ]);

    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(true);

    reconcileMessageListScrollTargets('world-shared', []);
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(false);
  });

  it('forgets the previous owner when a target resolves to a new thread', () => {
    const target = {
      kind: 'node' as const,
      canvasId: 'world-rebound',
      nodeId: 'question-ref-rebound',
    };
    const previousViewKey = 'source-canvas:previous-thread';
    registerMessageListScrollTarget(target, previousViewKey);
    rememberMessageListScrollPosition(previousViewKey, 240);

    registerMessageListScrollTarget(target, 'source-canvas:next-thread');

    expect(
      restoreMessageListScrollPosition(
        document.createElement('div'),
        previousViewKey,
      ),
    ).toBe(false);
  });

  it('moves a registration when a tab target is replaced', () => {
    const previous = {
      kind: 'chat' as const,
      canvasId: 'canvas-replace',
      threadId: 'thread-replace',
    };
    const next = {
      kind: 'node' as const,
      canvasId: 'canvas-replace',
      nodeId: 'question-replace',
    };
    const viewKey = 'canvas-replace:thread-replace';
    registerMessageListScrollTarget(previous, viewKey);
    rememberMessageListScrollPosition(viewKey, 260);

    replaceMessageListScrollTarget(previous, next);
    forgetMessageListScrollTarget(previous);
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(true);

    forgetMessageListScrollTarget(next);
    expect(
      restoreMessageListScrollPosition(document.createElement('div'), viewKey),
    ).toBe(false);
  });

  it('forgets every unreferenced position owned or presented by a Canvas', () => {
    const directViewKey = messageListViewKey('canvas-delete', 'chat-thread');
    const nodeViewKey = nodePreviewViewKey('canvas-delete', 'note-delete');
    const sourceViewKey = messageListViewKey(
      'source-canvas',
      'question-thread-delete',
    );
    registerMessageListScrollTarget(
      {
        kind: 'node',
        canvasId: 'canvas-delete',
        nodeId: 'question-ref-delete',
      },
      sourceViewKey,
    );
    rememberMessageListScrollPosition(directViewKey, 100);
    rememberMessageListScrollPosition(nodeViewKey, 150);
    rememberMessageListScrollPosition(sourceViewKey, 200);

    forgetMessageListScrollCanvas('canvas-delete');

    expect(
      restoreMessageListScrollPosition(
        document.createElement('div'),
        directViewKey,
      ),
    ).toBe(false);
    expect(
      restoreMessageListScrollPosition(
        document.createElement('div'),
        nodeViewKey,
      ),
    ).toBe(false);
    expect(
      restoreMessageListScrollPosition(
        document.createElement('div'),
        sourceViewKey,
      ),
    ).toBe(false);
  });
});
