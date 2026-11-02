// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';

import { createPageLifecycle, isPageUnloading } from './pageLifecycle';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('page lifecycle', () => {
  it('preserves synchronous action setup while tracking its asynchronous lifetime', async () => {
    const lifecycle = createPageLifecycle();
    const started = vi.fn();
    const task = lifecycle.run('updating', async () => {
      started();
    });
    expect(started).toHaveBeenCalledOnce();
    await task;
  });

  it('tracks page exit independently of React component cleanup', () => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(isPageUnloading()).toBe(true);

    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    expect(isPageUnloading()).toBe(false);
  });

  it('settles editors, waits through insertion, then flushes registered owners', async () => {
    const lifecycle = createPageLifecycle();
    const upload = deferred();
    const events: string[] = [];
    lifecycle.register('editor', {
      settle: () => {
        events.push('settle');
      },
    });
    lifecycle.register('canvas', {
      flush: async () => {
        events.push('save');
      },
    });
    const importing = lifecycle.run('importing', async () => {
      await upload.promise;
      events.push('insert');
    });
    const close = lifecycle.prepare(new AbortController().signal, vi.fn());
    await Promise.resolve();
    expect(events).toEqual(['settle']);
    upload.resolve();
    await Promise.all([importing, close]);
    expect(events).toEqual(['settle', 'insert', 'save']);
  });

  it('drains follow-up operations started during a final save', async () => {
    const lifecycle = createPageLifecycle();
    const child = deferred();
    const flush = vi.fn(async () => {
      if (flush.mock.calls.length === 1)
        void lifecycle.run('updating', () => child.promise);
    });
    lifecycle.register('canvas', { flush });
    let finished = false;
    const close = lifecycle
      .prepare(new AbortController().signal, vi.fn())
      .then(() => {
        finished = true;
      });
    await Promise.resolve();
    expect(finished).toBe(false);
    child.resolve();
    await close;
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('retains failures from operations that finish during preparation', async () => {
    const lifecycle = createPageLifecycle();
    const upload = deferred();
    const operation = lifecycle
      .run('importing', () => upload.promise)
      .catch(() => {});
    const close = lifecycle.prepare(new AbortController().signal, vi.fn());
    const failed = expect(close).rejects.toThrow('Upload failed');
    upload.reject(new Error('Upload failed'));
    await Promise.all([operation, failed]);
  });

  it('cancels only the close request and permits retry while the operation continues', async () => {
    const lifecycle = createPageLifecycle();
    const upload = deferred();
    const controller = new AbortController();
    const operation = lifecycle.run('importing', () => upload.promise);
    const close = lifecycle.prepare(controller.signal, vi.fn());
    controller.abort();
    await expect(close).rejects.toMatchObject({ name: 'AbortError' });
    const retry = lifecycle.prepare(new AbortController().signal, vi.fn());
    upload.resolve();
    await Promise.all([operation, retry]);
  });

  it('unregisters participants without removing their newer replacement', async () => {
    const lifecycle = createPageLifecycle();
    const old = lifecycle.register('canvas', { flush: vi.fn() });
    const flush = vi.fn(async () => {});
    const remove = lifecycle.register('canvas', { flush });
    old();
    await lifecycle.prepare(new AbortController().signal, vi.fn());
    expect(flush).toHaveBeenCalledOnce();
    remove();
    await lifecycle.prepare(new AbortController().signal, vi.fn());
    expect(flush).toHaveBeenCalledOnce();
  });

  it('accepts a retry immediately after abort without the old cleanup releasing its lock', async () => {
    const lifecycle = createPageLifecycle();
    const save = deferred();
    const flush = vi.fn(() => save.promise);
    lifecycle.register('canvas', { flush });
    const controller = new AbortController();
    const first = lifecycle.prepare(controller.signal);
    const cancelled = expect(first).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    const retry = lifecycle.prepare(new AbortController().signal);
    await cancelled;
    expect(flush).toHaveBeenCalledTimes(2);
    await expect(
      lifecycle.prepare(new AbortController().signal),
    ).rejects.toThrow('already in progress');
    save.resolve();
    await retry;
    await lifecycle.prepare(new AbortController().signal);
  });
});
