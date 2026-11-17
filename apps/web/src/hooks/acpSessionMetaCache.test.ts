// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, describe, expect, it } from 'vitest';

import {
  readDisplayedInitialPreferences,
  sessionMetaCacheKey,
  useSessionMetaCache,
} from './acpSessionMetaCache';

import type {
  AcpSessionMetaSnapshot,
  AcpThreadCachedMetaResponse,
} from '@huabu/shared';

const snapshot = (
  selections: AcpSessionMetaSnapshot['selections'],
): AcpSessionMetaSnapshot => ({
  availableModes: [],
  currentModeId: null,
  availableModels: [],
  currentModelId: null,
  configOptions: [
    {
      id: 'model_id',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ] as AcpSessionMetaSnapshot['configOptions'],
  selections,
  sessionInfo: null,
  usage: null,
  updatedAt: 1,
});

function show(
  source: AcpThreadCachedMetaResponse['source'],
  selections: AcpSessionMetaSnapshot['selections'],
) {
  const key = sessionMetaCacheKey('canvas-1', 'thread-1', 'profile-1');
  if (!key) throw new Error('expected a cache key');
  useSessionMetaCache
    .getState()
    .set(key, { meta: snapshot(selections), source, fetchedAt: 1 });
}

const displayed = () =>
  readDisplayedInitialPreferences('canvas-1', 'thread-1', 'profile-1');

afterEach(() => {
  useSessionMetaCache.getState().clear();
});

describe('preferences a draft conversation is displaying', () => {
  it('reports the selected model and thought level', () => {
    show('profile', { model_id: 'opus', effort: 'high' });

    expect(displayed()).toEqual({ model: 'opus', thoughtLevel: 'high' });
  });

  it('reports the observed model but not an unconfirmed thought level', () => {
    show('profile', {});

    expect(displayed()).toEqual({ model: 'sonnet' });
  });

  it('reports nothing once the conversation owns a session', () => {
    show('thread', { model_id: 'opus' });

    expect(displayed()).toBeUndefined();
  });

  it('reports nothing when the conversation has shown no snapshot', () => {
    expect(displayed()).toBeUndefined();
  });
});
