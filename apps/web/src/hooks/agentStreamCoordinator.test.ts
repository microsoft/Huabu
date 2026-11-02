// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { selectThreadMessages, useChatStore } from '@/store/chatStore';

import {
  abortAgentStreamClaim,
  claimAgentStream,
  hasAgentStreamClaim,
  subscribeAgentStreamRelease,
} from './agentStreamCoordinator';
import { handleStreamEvent } from './useAgentStream';

describe('agentStreamCoordinator', () => {
  it('notifies only the matching waiters after actual release, not abort of a held POST', () => {
    const listener = vi.fn(() => {
      expect(hasAgentStreamClaim('leased', 'thread')).toBe(false);
    });
    const unrelated = vi.fn();
    const unsubscribe = subscribeAgentStreamRelease(
      'leased',
      'thread',
      listener,
    );
    const unsubscribeOther = subscribeAgentStreamRelease(
      'other',
      'thread',
      unrelated,
    );
    const post = claimAgentStream('leased', 'thread', 'post', {
      holdUntilRelease: true,
    });
    try {
      abortAgentStreamClaim('leased', 'thread');
      expect(listener).not.toHaveBeenCalled();
      post?.release();
      post?.release();
      expect(listener).toHaveBeenCalledOnce();
      expect(unrelated).not.toHaveBeenCalled();
      unsubscribe();
      claimAgentStream('leased', 'thread', 'attach')?.release();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      post?.release();
      unsubscribe();
      unsubscribeOther();
    }
  });

  it('holds a cancelled controller claim until lifecycle cleanup finishes', () => {
    const claim = claimAgentStream('held-canvas', 'held-thread', 'post', {
      holdUntilRelease: true,
    });
    abortAgentStreamClaim('held-canvas', 'held-thread');
    expect(claim?.signal.aborted).toBe(true);
    expect(claimAgentStream('held-canvas', 'held-thread', 'post')).toBeNull();
    claim?.release();
    expect(hasAgentStreamClaim('held-canvas', 'held-thread')).toBe(false);
  });
  it('rejects a second text POST while the first owns the thread', () => {
    const claim = claimAgentStream('text-canvas', 'text-thread', 'post');
    expect(claimAgentStream('text-canvas', 'text-thread', 'post')).toBeNull();
    claim?.release();
  });

  it('keeps a replacement turn alive when an old turn releases late', () => {
    const previous = claimAgentStream('text-canvas', 'text-thread', 'post');
    abortAgentStreamClaim('text-canvas', 'text-thread');
    const replacement = claimAgentStream('text-canvas', 'text-thread', 'post');
    previous?.release();
    expect(replacement?.signal.aborted).toBe(false);
    expect(hasAgentStreamClaim('text-canvas', 'text-thread')).toBe(true);
    replacement?.release();
  });

  it('folds text and thinking in order on the originating thread only', () => {
    useChatStore.getState().setMessages('text-owner', []);
    useChatStore.getState().setMessages('other-thread', []);
    const context = { threadId: 'text-owner', assistantId: 'answer' };
    handleStreamEvent(
      { type: 'thinking_delta', data: { content: 'Think' } },
      context,
    );
    handleStreamEvent(
      { type: 'text_delta', data: { content: 'Hello' } },
      context,
    );
    handleStreamEvent(
      { type: 'text_delta', data: { content: ' world' } },
      context,
    );
    handleStreamEvent(
      { type: 'thinking_delta', data: { content: 'Again' } },
      context,
    );
    expect(selectThreadMessages(useChatStore.getState(), 'text-owner')).toEqual(
      [
        {
          id: 'answer',
          role: 'assistant',
          segments: [
            { kind: 'thinking', text: 'Think' },
            { kind: 'text', text: 'Hello world' },
            { kind: 'thinking', text: 'Again' },
          ],
        },
      ],
    );
    expect(
      selectThreadMessages(useChatStore.getState(), 'other-thread'),
    ).toEqual([]);
  });

  it('allows only one consumer per canvas thread', () => {
    const first = claimAgentStream('canvas-a', 'thread-a', 'post');
    expect(first).not.toBeNull();
    expect(claimAgentStream('canvas-a', 'thread-a', 'attach')).toBeNull();
    expect(hasAgentStreamClaim('canvas-a', 'thread-a')).toBe(true);

    first?.release();

    const replacement = claimAgentStream('canvas-a', 'thread-a', 'attach');
    expect(replacement).not.toBeNull();
    replacement?.release();
  });

  it('isolates identical thread ids in different canvases', () => {
    const first = claimAgentStream('canvas-a', 'thread-a', 'attach');
    const second = claimAgentStream('canvas-b', 'thread-a', 'attach');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    first?.release();
    second?.release();
  });

  it('aborts and releases the current consumer', () => {
    const claim = claimAgentStream('canvas-a', 'thread-a', 'attach');
    expect(claim).not.toBeNull();

    abortAgentStreamClaim('canvas-a', 'thread-a');

    expect(claim?.signal.aborted).toBe(true);
    expect(hasAgentStreamClaim('canvas-a', 'thread-a')).toBe(false);
  });
});
