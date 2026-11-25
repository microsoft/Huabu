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
    } as unknown as UnloadFlushDeps;

    createUnloadFlush(deps)();

    expect(flushPreviewWorkspace).toHaveBeenCalledOnce();
  });

  function depsWithQueue(queue: UnloadFlushDeps['sendQueue']) {
    return {
      flushPreviewWorkspace: vi.fn(),
      events: { flushAllKeepalive: vi.fn() },
      nodeContent: { flushAllKeepalive: vi.fn() },
      sendQueue: queue,
    } as unknown as UnloadFlushDeps;
  }

  it('flushes unsent structure edits and asks the browser to confirm leaving', () => {
    const flushKeepalive = vi.fn();
    const event = new Event('beforeunload', {
      cancelable: true,
    }) as BeforeUnloadEvent;
    createUnloadFlush(
      depsWithQueue({
        hasUnsent: () => true,
        flushKeepalive,
        warnBeforeLeaving: () => true,
      }),
    )(event);
    expect(flushKeepalive).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('flushes without a confirmation where the host has its own close flow', () => {
    const flushKeepalive = vi.fn();
    const event = new Event('beforeunload', {
      cancelable: true,
    }) as BeforeUnloadEvent;
    createUnloadFlush(
      depsWithQueue({
        hasUnsent: () => true,
        flushKeepalive,
        warnBeforeLeaving: () => false,
      }),
    )(event);
    expect(flushKeepalive).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it('neither flushes nor asks when nothing is unsent', () => {
    const flushKeepalive = vi.fn();
    const event = new Event('beforeunload', {
      cancelable: true,
    }) as BeforeUnloadEvent;
    createUnloadFlush(
      depsWithQueue({
        hasUnsent: () => false,
        flushKeepalive,
        warnBeforeLeaving: () => true,
      }),
    )(event);
    expect(flushKeepalive).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
