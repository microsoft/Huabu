// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readSpacePreviewViewport,
  writeSpacePreviewViewport,
} from './viewportPersistence';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
});

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage.api,
});

beforeEach(() => storage.values.clear());

describe('Space Preview viewport persistence', () => {
  it('round-trips state by host Canvas and preview node', () => {
    writeSpacePreviewViewport('canvas-host', 'node-preview', {
      x: 12,
      y: -4,
      zoom: 2.5,
    });

    expect(readSpacePreviewViewport('canvas-host', 'node-preview')).toEqual({
      x: 12,
      y: -4,
      zoom: 2.5,
    });
    expect(readSpacePreviewViewport('canvas-other', 'node-preview')).toBeNull();
  });

  it('rejects malformed and incompatible records', () => {
    storage.values.set(
      'huabu.spacePreviewViewport.canvas-host.node-preview',
      JSON.stringify({
        version: 2,
        viewport: { x: 1, y: 2, zoom: 3 },
      }),
    );
    expect(readSpacePreviewViewport('canvas-host', 'node-preview')).toBeNull();
  });
});
