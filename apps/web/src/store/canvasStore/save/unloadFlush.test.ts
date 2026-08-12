// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, expect, it, vi } from 'vitest';

import { createUnloadFlush, type UnloadFlushDeps } from './unloadFlush';

describe('createUnloadFlush', () => {
  it('flushes the local Preview Workspace layout on page unload', () => {
    const flushPreviewWorkspace = vi.fn();
    const deps = {
      flushPreviewWorkspace,
      events: { flushAllKeepalive: vi.fn() },
      nodeContent: { flushAllKeepalive: vi.fn() },
      preprocess: { flushKeepalive: vi.fn() },
      structure: { cancelPending: vi.fn(() => false) },
      getSaveCanvas: vi.fn(),
      hasUnsavedStructure: vi.fn(() => false),
    } as unknown as UnloadFlushDeps;

    createUnloadFlush(deps)();

    expect(flushPreviewWorkspace).toHaveBeenCalledOnce();
  });
});
