// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../storage/index.js', () => ({
  getStructuredStore: vi.fn(),
}));

import { logIntentEpisode } from './intent-store.js';
import { getStructuredStore } from '../../storage/index.js';

import type { IntentEpisode } from '@huabu/shared';

const EPISODE: IntentEpisode = {
  id: 'episode-1',
  timestamp: 1,
  contextSummary: 'selected a note action',
  candidates: [{ label: 'Create note' }],
  outcome: {
    type: 'selected',
    chosenIndex: 0,
    chosenLabel: 'Create note',
  },
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installIntents() {
  const put = vi.fn(async (_episode: IntentEpisode): Promise<void> => {});
  const space = vi.fn(() => ({ history: { intents: { put } } }));
  vi.mocked(getStructuredStore).mockReturnValue({
    space,
  } as unknown as ReturnType<typeof getStructuredStore>);
  return { space, put };
}

beforeEach(() => {
  vi.mocked(getStructuredStore).mockReset();
});

describe('logIntentEpisode', () => {
  it('is a successful no-op when canvasId is absent', async () => {
    await logIntentEpisode(EPISODE);

    expect(getStructuredStore).not.toHaveBeenCalled();
  });

  it('writes through the structured intent part and awaits it', async () => {
    const { space, put } = installIntents();
    const write = deferred();
    put.mockReturnValueOnce(write.promise);

    let settled = false;
    const logging = logIntentEpisode(EPISODE, 'canvas-1').then(() => {
      settled = true;
    });

    expect(space).toHaveBeenCalledWith('canvas-1');
    expect(put).toHaveBeenCalledWith(EPISODE);
    await Promise.resolve();
    expect(settled).toBe(false);

    write.resolve();
    await logging;
    expect(settled).toBe(true);
  });

  it('propagates intent write failures', async () => {
    const { put } = installIntents();
    const error = new Error('intent write failed');
    put.mockRejectedValueOnce(error);

    await expect(logIntentEpisode(EPISODE, 'canvas-1')).rejects.toBe(error);
  });
});
