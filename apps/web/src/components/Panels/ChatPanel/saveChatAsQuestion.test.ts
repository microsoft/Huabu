// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { saveChatAsQuestion } from './saveChatAsQuestion';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent';
import type { CanvasNodeId } from '@huabu/shared';

const input: AddNodeInput & { id: CanvasNodeId } = {
  id: 'node-question-1',
  nodeType: 'question' as const,
  data: { threadId: 'thread-1' },
};

describe('saveChatAsQuestion', () => {
  it('replaces the workspace tab after node creation succeeds', () => {
    const replaceTabTarget = vi.fn();

    const saved = saveChatAsQuestion(input, {
      canvasId: 'canvas-1',
      previewTabId: 'tab-1',
      addNode: vi.fn(),
      nodeExists: () => true,
      replaceTabTarget,
    });

    expect(saved).toBe(true);
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
