// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPresenceReporter } from './presenceReporter';

import type { PresenceReportOutcome } from '@/api/canvasPresence';
import type { CanvasPresenceReportBody } from '@huabu/shared';

function setup(
  respond: () => Promise<PresenceReportOutcome> = async () => ({ ok: true }),
) {
  const sent: CanvasPresenceReportBody[] = [];
  const leave = vi.fn();
  const reporter = createPresenceReporter({
    pageId: 'page-a',
    label: 'Chrome · Mac',
    intervalMs: 100,
    heartbeatMs: 10_000,
    send: (body) => {
      sent.push(body);
      return respond();
    },
    leave,
  });
  return { reporter, sent, leave };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('presence reporter', () => {
  it('sends the first pointer position at once and only the pointer', async () => {
    const { reporter, sent } = setup();
    reporter.setPointer({ x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ pageId: 'page-a', pointer: { x: 1, y: 2 } }]);
    reporter.stop();
  });

  it('throttles pointer movement to one report per interval, carrying the latest position', async () => {
    const { reporter, sent } = setup();
    // 100 moves in one second, as a 100 Hz pointer would produce.
    for (let tick = 0; tick < 100; tick += 1) {
      reporter.setPointer({ x: tick, y: 0 });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.length).toBeGreaterThanOrEqual(9);
    expect(sent.length).toBeLessThanOrEqual(11);
    expect(sent.at(-1)).toEqual({ pageId: 'page-a', pointer: { x: 99, y: 0 } });
    reporter.stop();
  });

  it('sends nothing while the pointer rests', async () => {
    const { reporter, sent } = setup();
    reporter.setPointer({ x: 1, y: 2 });
    await vi.advanceTimersByTimeAsync(200);
    for (let tick = 0; tick < 20; tick += 1) {
      reporter.setPointer({ x: 1, y: 2 });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(sent).toHaveLength(1);
    reporter.stop();
  });

  it('reports node state when it changes, not when the same ids are set again', async () => {
    const { reporter, sent } = setup();
    reporter.setNodes({ selectedNodeIds: ['n1'], draggingNodeIds: [] });
    await vi.advanceTimersByTimeAsync(200);
    reporter.setNodes({ selectedNodeIds: ['n1'], draggingNodeIds: [] });
    await vi.advanceTimersByTimeAsync(200);
    reporter.setNodes({ editingNodeIds: ['n1'] });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([
      {
        pageId: 'page-a',
        selectedNodeIds: ['n1'],
        draggingNodeIds: [],
        editingNodeIds: [],
      },
      {
        pageId: 'page-a',
        selectedNodeIds: ['n1'],
        draggingNodeIds: [],
        editingNodeIds: ['n1'],
      },
    ]);
    reporter.stop();
  });

  it('never has two requests in flight and folds what changed meanwhile into the next one', async () => {
    let release!: (outcome: PresenceReportOutcome) => void;
    const { reporter, sent } = setup(
      () => new Promise((resolve) => (release = resolve)),
    );
    reporter.setPointer({ x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(0);
    reporter.setPointer({ x: 2, y: 2 });
    reporter.setNodes({ selectedNodeIds: ['n1'] });
    reporter.setPointer({ x: 3, y: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    release({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      pageId: 'page-a',
      pointer: { x: 3, y: 3 },
      selectedNodeIds: ['n1'],
      draggingNodeIds: [],
      editingNodeIds: [],
    });
    release({ ok: true });
    reporter.stop();
  });

  it('announces the whole state with the label, and repeats it as a heartbeat', async () => {
    const { reporter, sent } = setup();
    reporter.setPointer({ x: 4, y: 5 });
    reporter.setNodes({ selectedNodeIds: ['n1'] });
    reporter.announce();
    await vi.advanceTimersByTimeAsync(0);
    const whole = {
      pageId: 'page-a',
      label: 'Chrome · Mac',
      pointer: { x: 4, y: 5 },
      selectedNodeIds: ['n1'],
      draggingNodeIds: [],
      editingNodeIds: [],
    };
    expect(sent).toEqual([whole]);
    await vi.advanceTimersByTimeAsync(10_050);
    expect(sent).toEqual([whole, whole]);
    reporter.stop();
  });

  it('waits out a refusal, then resends what the refused report carried', async () => {
    const outcomes: PresenceReportOutcome[] = [
      { ok: false, retryAfterMs: 1_000 },
      { ok: true },
    ];
    const { reporter, sent } = setup(
      async () => outcomes.shift() ?? { ok: true },
    );
    reporter.setNodes({ selectedNodeIds: ['n1'] });
    await vi.advanceTimersByTimeAsync(900);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      label: 'Chrome · Mac',
      selectedNodeIds: ['n1'],
    });
    reporter.stop();
  });

  it('does not retry a failed request until something changes or the heartbeat', async () => {
    const { reporter, sent } = setup(async () => ({
      ok: false,
      retryAfterMs: null,
    }));
    reporter.setPointer({ x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_050);
    expect(sent).toHaveLength(2);
    reporter.stop();
  });

  it('caps each id list at the wire limit', async () => {
    const { reporter, sent } = setup();
    reporter.setNodes({
      selectedNodeIds: Array.from({ length: 500 }, (_, index) => `n${index}`),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]?.selectedNodeIds).toHaveLength(200);
    reporter.stop();
  });

  it('leaves once on stop and sends nothing afterwards', async () => {
    const { reporter, sent, leave } = setup();
    reporter.setPointer({ x: 1, y: 1 });
    await vi.advanceTimersByTimeAsync(0);
    reporter.setPointer({ x: 2, y: 2 });
    reporter.stop();
    reporter.stop();
    reporter.setPointer({ x: 3, y: 3 });
    reporter.announce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(leave).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
