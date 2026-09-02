// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it } from 'vitest';

import { reconcileQuestionStatus } from './reconcileQuestionStatus';

import type { Node } from '@xyflow/react';

function question(data: Record<string, unknown>): Node {
  return {
    id: 'question-a',
    type: 'question',
    position: { x: 0, y: 0 },
    data: { type: 'question', ...data },
  };
}

describe('reconcileQuestionStatus', () => {
  it('does not infer success from a persisted conversation', () => {
    const node = question({
      threadId: 'thread-a',
      content: 'Hello',
    });

    const result = reconcileQuestionStatus([node]);

    expect(result).toBeInstanceOf(Array);
    expect(result[0]).toBe(node);
    expect(result[0]?.data.status).toBeUndefined();
  });

  it('preserves explicit error and done terminals', () => {
    const failed = question({ status: 'error', errorMessage: 'Failed' });
    const succeeded = question({ id: 'question-b', status: 'done' });

    const result = reconcileQuestionStatus([failed, succeeded]);

    expect(result[0]).toBe(failed);
    expect(result[1]).toBe(succeeded);
  });

  it('removes a legacy auto-run timestamp without changing status', () => {
    const node = question({
      threadId: 'thread-a',
      content: 'Hello',
      runAt: 123,
    });

    const result = reconcileQuestionStatus([node]);

    expect(result[0]).not.toBe(node);
    expect(result[0]?.data.runAt).toBeUndefined();
    expect(result[0]?.data.status).toBeUndefined();
  });
});
