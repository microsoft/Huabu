// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./analyzer.js', () => ({ runAnalysisPass: vi.fn() }));
vi.mock('./trigger.js', () => ({ markAnalyzed: vi.fn() }));

import { runAnalysisPass } from './analyzer.js';
import { markAnalyzed } from './trigger.js';
import { _waitForIdle, schedule } from './worker.js';

import type { MemoryLogger } from './index.js';

function logger() {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
  };
}

async function runScheduled(canvasId: string, log: MemoryLogger) {
  schedule(canvasId, log);
  await _waitForIdle();
}

beforeEach(async () => {
  await _waitForIdle();
  vi.mocked(runAnalysisPass).mockReset();
  vi.mocked(markAnalyzed).mockReset().mockResolvedValue();
});

describe('memory worker outcomes', () => {
  it('does not mark a missing Space analysis as completed', async () => {
    vi.mocked(runAnalysisPass).mockResolvedValue({
      status: 'skipped',
      reason: 'space-not-found',
    });
    const log = logger();

    await runScheduled('missing-space', log);

    expect(markAnalyzed).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      '[memory] pass for canvas missing-space skipped — Space not found',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not mark a failed repository read as completed', async () => {
    vi.mocked(runAnalysisPass).mockRejectedValue(new Error('events corrupt'));
    const log = logger();

    await runScheduled('broken-space', log);

    expect(markAnalyzed).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      '[memory] analysis pass failed for canvas broken-space: events corrupt',
    );
  });

  it('marks completed passes after summarising writer results', async () => {
    vi.mocked(runAnalysisPass).mockResolvedValue({
      status: 'completed',
      results: [{ ok: true, target: 'space', reason: 'updated' }],
    });
    const log = logger();

    await runScheduled('canvas-a', log);

    expect(markAnalyzed).toHaveBeenCalledWith('canvas-a');
    expect(log.info).toHaveBeenCalledWith(
      '[memory] pass for canvas canvas-a done — 1 ok, 0 rejected',
    );
  });
});
