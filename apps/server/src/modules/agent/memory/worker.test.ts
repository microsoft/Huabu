// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./analyzer.js', () => ({ runAnalysisPass: vi.fn() }));
vi.mock('./trigger.js', () => ({ markAnalyzed: vi.fn() }));
vi.mock('../agent-defaults.js', () => ({ getAgentDefaults: vi.fn() }));

import { getAgentDefaults } from '../agent-defaults.js';
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
  vi.mocked(getAgentDefaults)
    .mockReset()
    .mockReturnValue({ profileId: 'huabu', functionalModel: '' });
});

describe('memory worker outcomes', () => {
  it.each([null, 'external'])(
    'does not start the legacy curator with default %s',
    async (profileId) => {
      vi.mocked(getAgentDefaults).mockReturnValue({
        profileId,
        functionalModel: '',
      });
      await runScheduled('canvas-a', logger());
      expect(runAnalysisPass).not.toHaveBeenCalled();
      expect(markAnalyzed).not.toHaveBeenCalled();
    },
  );

  it('rechecks queued work before starting', async () => {
    const log = logger();
    schedule('canvas-a', log);
    vi.mocked(getAgentDefaults).mockReturnValue({
      profileId: 'external',
      functionalModel: '',
    });
    await _waitForIdle();
    expect(runAnalysisPass).not.toHaveBeenCalled();
  });

  it('lets an admitted pass finish but skips its coalesced follow-up after switching to external', async () => {
    let finish!: () => void;
    vi.mocked(runAnalysisPass).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: 'completed', results: [] });
        }),
    );
    const log = logger();
    schedule('canvas-a', log);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runAnalysisPass).toHaveBeenCalledTimes(1);
    schedule('canvas-a', log);
    vi.mocked(getAgentDefaults).mockReturnValue({
      profileId: 'external',
      functionalModel: '',
    });
    finish();
    await _waitForIdle();
    await _waitForIdle();
    expect(runAnalysisPass).toHaveBeenCalledTimes(1);
    expect(markAnalyzed).toHaveBeenCalledWith('canvas-a');
  });

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
