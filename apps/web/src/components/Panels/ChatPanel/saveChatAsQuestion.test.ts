// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { saveChatAsQuestion } from './saveChatAsQuestion';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { CanvasNodeId, ConversationTitle } from '@huabu/shared';

const input: AddNodeInput & { id: CanvasNodeId } = {
  id: 'node-question-1',
  nodeType: 'question' as const,
  data: { threadId: 'thread-1' },
};

describe('saveChatAsQuestion', () => {
  it.each([
    ['user', 'user'],
    ['acp', 'auto'],
    ['generated', 'auto'],
    ['fallback', 'auto'],
    [null, 'auto'],
  ] as const)(
    'transfers the current %s title with labelSource %s and naming provenance',
    (source, labelSource) => {
      const addNode = vi.fn();
      saveChatAsQuestion(input, {
        canvasId: 'canvas-1',
        previewTabId: 'tab-1',
        addNode,
        nodeExists: () => true,
        replaceTabTarget: vi.fn(),
        conversationTitle: { title: 'Retained conversation name', source },
      });
      expect(addNode).toHaveBeenCalledWith({
        ...input,
        data: {
          ...input.data,
          label: 'Retained conversation name',
          labelSource,
          conversationTitleSource: source,
        },
      });
    },
  );

  it.each<ConversationTitle | undefined>([
    undefined,
    { title: null, source: null },
    { title: '', source: 'fallback' },
  ])(
    'preserves existing fallback input when no title is available (%j)',
    (conversationTitle) => {
      const addNode = vi.fn();
      const fallbackInput = {
        ...input,
        data: {
          ...input.data,
          content: 'Existing first user prompt',
          label: 'Existing fallback label',
          labelSource: 'auto' as const,
        },
      };

      saveChatAsQuestion(fallbackInput, {
        canvasId: 'canvas-1',
        previewTabId: 'tab-1',
        conversationTitle,
        addNode,
        nodeExists: () => true,
        replaceTabTarget: vi.fn(),
      });

      expect(addNode).toHaveBeenCalledWith(fallbackInput);
    },
  );

  it('does not retain a live reference to the Chat title', () => {
    const addNode = vi.fn();
    const conversationTitle: ConversationTitle = {
      title: 'Title at conversion',
      source: 'acp',
    };

    saveChatAsQuestion(input, {
      canvasId: 'canvas-1',
      previewTabId: 'tab-1',
      conversationTitle,
      addNode,
      nodeExists: () => true,
      replaceTabTarget: vi.fn(),
    });
    conversationTitle.title = 'Later generated title';
    conversationTitle.source = 'generated';

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(addNode).toHaveBeenCalledWith({
      ...input,
      data: {
        ...input.data,
        label: 'Title at conversion',
        labelSource: 'auto',
        conversationTitleSource: 'acp',
      },
    });
  });

  it('replaces the workspace tab after node creation succeeds', () => {
    const replaceTabTarget = vi.fn();
    const addNode = vi.fn();

    const saved = saveChatAsQuestion(input, {
      canvasId: 'canvas-1',
      previewTabId: 'tab-1',
      addNode,
      nodeExists: () => true,
      replaceTabTarget,
    });

    expect(saved).toBe(true);
    expect(addNode).toHaveBeenCalledWith(input);
    expect(replaceTabTarget).toHaveBeenCalledWith('tab-1', {
      kind: 'node',
      canvasId: 'canvas-1',
      nodeId: 'node-question-1',
    });
  });

  it('leaves the Chat presentation unchanged when creation fails', () => {
    const replaceTabTarget = vi.fn();

    const saved = saveChatAsQuestion(input, {
      canvasId: 'canvas-1',
      previewTabId: 'tab-1',
      addNode: vi.fn(),
      nodeExists: () => false,
      replaceTabTarget,
    });

    expect(saved).toBe(false);
    expect(replaceTabTarget).not.toHaveBeenCalled();
  });
});
