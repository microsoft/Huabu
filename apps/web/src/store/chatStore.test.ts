// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import { selectCurrentDraft, useChatStore } from './chatStore';

describe('chatStore composer drafts', () => {
  beforeEach(() => {
    useChatStore.setState({
      draftsByThread: {},
      threadId: 'thread-a',
    });
  });

  it('isolates drafts by thread and removes cleared entries', () => {
    const { setDraft } = useChatStore.getState();

    setDraft('thread-a', 'first draft');
    setDraft('thread-b', 'second draft');
    expect(selectCurrentDraft(useChatStore.getState())).toBe('first draft');

    useChatStore.setState({ threadId: 'thread-b' });
    expect(selectCurrentDraft(useChatStore.getState())).toBe('second draft');

    setDraft('thread-b', '');
    expect(selectCurrentDraft(useChatStore.getState())).toBe('');
    expect(useChatStore.getState().draftsByThread).toEqual({
      'thread-a': 'first draft',
    });
  });
});
