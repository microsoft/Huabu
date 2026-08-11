// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
  space: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../../storage/index.js', () => ({
  getStructuredStore: () => ({ space: storageMocks.space }),
}));

import { logIntentEpisode } from './intent-store.js';

import type { IntentEpisode } from '@huabu/shared';

const episode: IntentEpisode = {
  id: 'episode-a',
  timestamp: 1,
  contextSummary: 'one note selected',
  candidates: [{ label: 'Summarize it' }],
  outcome: { type: 'dismissed' },
};

beforeEach(() => {
  storageMocks.upsert.mockReset().mockResolvedValue(undefined);
  storageMocks.space.mockReset().mockReturnValue({
    intents: { upsert: storageMocks.upsert },
  });
});

describe('logIntentEpisode', () => {
  it('writes through the structured intent repository', async () => {
    await logIntentEpisode(episode, 'canvas-a');

    expect(storageMocks.space).toHaveBeenCalledWith('canvas-a');
    expect(storageMocks.upsert).toHaveBeenCalledWith(episode);
  });

  it('resolves only after the repository write is durable', async () => {
    let releaseWrite!: () => void;
    storageMocks.upsert.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );

    let settled = false;
    const write = logIntentEpisode(episode, 'canvas-a').then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseWrite();
    await write;
    expect(settled).toBe(true);
  });

  it('does not resolve storage when the legacy optional canvas id is absent', async () => {
    await logIntentEpisode(episode);

    expect(storageMocks.space).not.toHaveBeenCalled();
    expect(storageMocks.upsert).not.toHaveBeenCalled();
  });
});
