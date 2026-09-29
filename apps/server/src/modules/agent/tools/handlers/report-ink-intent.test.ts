// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCanvas: vi.fn(),
  readNode: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../canvas/write-coordinator.js', () => ({
  withCanvasMutex: async (_canvasId: string, operation: () => unknown) =>
    operation(),
}));
vi.mock('../../../canvas/canvas-executor.js', () => ({
  executeOnServerAlreadyLocked: mocks.execute,
}));
vi.mock('../../../storage/index.js', () => ({
  space: () => ({
    read: mocks.readCanvas,
    nodes: { read: mocks.readNode },
  }),
}));

import { handleReportInkIntent, reportInkIntent } from './report-ink-intent.js';
import { beginActiveInkIntentTurn } from '../../ink-intent-runtime.js';

async function report(
  args: Parameters<typeof handleReportInkIntent>[0],
): Promise<string> {
  const finish = beginActiveInkIntentTurn('canvas-1', 'thread-1', 'question-1');
  try {
    return await handleReportInkIntent(args, {
      canvasId: 'canvas-1',
      threadId: 'thread-1',
    });
  } finally {
    finish();
  }
}

describe('handleReportInkIntent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execute.mockResolvedValue({ results: [{ applied: true }] });
  });

  it('returns a normalized inferred intent', async () => {
    expect(
      JSON.parse(
        await report({
          status: 'inferred',
          text: '  Expand the third comparison step  ',
        }),
      ),
    ).toEqual({
      status: 'inferred',
      text: 'Expand the third comparison step',
      renamed: false,
    });
  });

  it('accepts clarify without inventing text', async () => {
    expect(JSON.parse(await report({ status: 'clarify' }))).toEqual({
      status: 'clarify',
      renamed: false,
    });
  });

  it('renames only an untouched pending Ink Question', async () => {
    mocks.readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'question-1',
            type: 'question',
            data: {
              threadId: 'thread-1',
              pendingInkIntentLabel: true,
            },
          },
        ],
      },
    });
    mocks.readNode.mockResolvedValue({
      record: { label: 'New ink request' },
    });
    mocks.execute.mockResolvedValue({ results: [{ applied: true }] });

    const result = JSON.parse(
      await report({ status: 'inferred', text: 'Expand the third step' }),
    );

    expect(result).toEqual({
      status: 'inferred',
      text: 'Expand the third step',
      renamed: true,
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: 'canvas-1',
        commands: [
          expect.objectContaining({
            type: 'MERGE_NODE_DATA',
            patches: [
              expect.objectContaining({
                patch: expect.objectContaining({
                  label: 'Expand the third step',
                  labelSource: 'agent',
                  pendingInkIntentLabel: false,
                }),
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('does not overwrite a user-owned placeholder label', async () => {
    mocks.readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'question-1',
            type: 'question',
            data: {
              threadId: 'thread-1',
              pendingInkIntentLabel: true,
            },
          },
        ],
      },
    });
    mocks.readNode.mockResolvedValue({
      record: { label: 'New ink request', labelSource: 'user' },
    });

    const result = JSON.parse(
      await report({ status: 'inferred', text: 'Expand the third step' }),
    );

    expect(result.renamed).toBe(false);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [
          expect.objectContaining({
            patches: [
              expect.objectContaining({
                patch: { pendingInkIntentLabel: false },
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('does not rename when the authoritative owner changed', async () => {
    mocks.readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'question-other',
            type: 'question',
            data: {
              threadId: 'thread-1',
              pendingInkIntentLabel: true,
            },
          },
        ],
      },
    });

    const result = JSON.parse(
      await report({ status: 'inferred', text: 'Expand the third step' }),
    );

    expect(result.renamed).toBe(false);
    expect(mocks.readNode).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects calls outside the active Ink turn', async () => {
    await expect(
      handleReportInkIntent(
        { status: 'inferred', text: 'Unexpected' },
        { canvasId: 'canvas-1', threadId: 'thread-1' },
      ),
    ).rejects.toThrow('available only during an Ink turn');
  });

  it('rejects a report cancelled while its node record is being read', async () => {
    const onReport = vi.fn();
    const finish = beginActiveInkIntentTurn(
      'canvas-1',
      'thread-1',
      'question-1',
      'turn-token',
      onReport,
    );
    mocks.readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'question-1',
            type: 'question',
            data: { threadId: 'thread-1', pendingInkIntentLabel: true },
          },
        ],
      },
    });

    mocks.readNode.mockImplementationOnce(async () => {
      finish();
      return { record: { label: 'New ink request' } };
    });
    try {
      await expect(
        reportInkIntent(
          { status: 'inferred', text: 'Too late' },
          {
            canvasId: 'canvas-1',
            threadId: 'thread-1',
            invocationToken: 'turn-token',
          },
        ),
      ).rejects.toThrow('matching active Ink turn');
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(onReport).not.toHaveBeenCalled();
    } finally {
      finish();
    }
  });

  it('does not report success when the pending-label command is rejected', async () => {
    mocks.readCanvas.mockResolvedValue({
      state: {
        nodes: [
          {
            id: 'question-1',
            type: 'question',
            data: { threadId: 'thread-1', pendingInkIntentLabel: true },
          },
        ],
      },
    });
    mocks.readNode.mockResolvedValue({
      record: { label: 'New ink request' },
    });
    mocks.execute.mockResolvedValue({ results: [{ applied: false }] });
    await expect(
      report({ status: 'inferred', text: 'A new title' }),
    ).rejects.toThrow('Failed to settle');
  });
});
