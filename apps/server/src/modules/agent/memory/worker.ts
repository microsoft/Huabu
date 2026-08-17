// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory worker — per-canvas single-flight scheduler.
 *
 * Public surface: {@link schedule}. The route calls it via
 * {@link import('./index.js').enqueue} after the op-counter crosses
 * its threshold. Everything else (the LLM call, the writers) happens
 * here, off the request hot path.
 *
 * Concurrency model:
 *
 *   - At most one analysis pass per canvas at any moment. If a
 *     second `schedule(canvasId)` arrives while one is already
 *     running, we set a `pending` flag rather than queueing — the
 *     in-flight pass will already cover the new ops, and at most
 *     one follow-up pass is needed regardless of how many bumps
 *     land in between. This bounds total work to O(triggers) under
 *     bursty op streams.
 *   - Dispatch goes through `setImmediate` so the route handler can
 *     return before any of this starts (zero latency impact).
 *   - Errors are caught, logged via `logger.warn`, and never
 *     surfaced to the route. A failed pass leaves `lastAnalyzedAt`
 *     untouched — the next trigger will retry naturally.
 *
 * The actual analysis lives in `./analyzer.ts` — that module owns
 * context assembly + the `runAgent` call + tool-result aggregation.
 */

import { runAnalysisPass } from './analyzer.js';
import { markAnalyzed } from './trigger.js';

import type { MemoryLogger } from './index.js';
import type { WriteResult } from './writers.js';

/**
 * One promise per actively-running canvas analysis. Cleared from the
 * map when the pass settles (success or failure).
 */
const running = new Map<string, Promise<void>>();

/**
 * Canvases that asked to run while another pass was in flight. We
 * coalesce: at most one follow-up per canvas, regardless of how many
 * `schedule` calls arrive in between.
 */
const pending = new Set<string>();

/**
 * Schedule an analysis pass for `canvasId`.
 *
 * Returns synchronously. The actual work runs after the next tick.
 */
export function schedule(canvasId: string, logger?: MemoryLogger): void {
  if (running.has(canvasId)) {
    pending.add(canvasId);
    return;
  }
  // Wrap the worker in a Promise we can dedupe against. `setImmediate`
  // hands control back to libuv so the route handler completes its
  // response cycle before we start touching disk / LLMs.
  const task = new Promise<void>((resolve) => {
    setImmediate(() => {
      runOnce(canvasId, logger).finally(resolve);
    });
  });
  running.set(canvasId, task);
  task.finally(() => {
    running.delete(canvasId);
    if (pending.delete(canvasId)) {
      schedule(canvasId, logger);
    }
  });
}

/** Idle-state probe used by tests to wait for in-flight passes. */
export function _waitForIdle(): Promise<void> {
  if (running.size === 0) return Promise.resolve();
  return Promise.allSettled([...running.values()]).then(() => undefined);
}

async function runOnce(canvasId: string, logger?: MemoryLogger): Promise<void> {
  try {
    const outcome = await runAnalysisPass(canvasId, logger);
    if (outcome.status === 'skipped') {
      logger?.info(
        `[memory] pass for canvas ${canvasId} skipped — Space not found`,
      );
      return;
    }
    const { results } = outcome;
    // markAnalyzed is intentionally always called when the pass finished
    // without throwing — even if individual writers rejected (e.g. a
    // create-rationale violation). The bookkeeping records "we tried",
    // not "we wrote". This avoids hammering the threshold with retries
    // when the LLM keeps producing rejected outputs.
    markAnalyzed(canvasId).catch((err: unknown) => {
      // markAnalyzed is now async (it shares the per-canvas state
      // lock with bumpOpCounter). A bookkeeping write failure does
      // not invalidate the pass — log and continue.
      logger?.warn(
        `[memory] markAnalyzed failed for canvas ${canvasId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    summariseResults(canvasId, results, logger);
  } catch (err) {
    logger?.warn(
      `[memory] analysis pass failed for canvas ${canvasId}: ${
        (err as Error).message
      }`,
    );
  }
}

function summariseResults(
  canvasId: string,
  results: WriteResult[],
  logger?: MemoryLogger,
): void {
  const ok = results.filter((r) => r.ok).length;
  const rejected = results.length - ok;
  logger?.info(
    `[memory] pass for canvas ${canvasId} done — ${ok} ok, ${rejected} rejected`,
  );
}
