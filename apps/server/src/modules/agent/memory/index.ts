// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory module public entry point.
 *
 * Single function used by the canvas event route: when the per-canvas
 * op counter crosses {@link OP_THRESHOLD}, the route calls
 * {@link enqueue} to ask the memory sub-agent to run an analysis pass.
 *
 * Phase boundary (PR-C):
 *   - `enqueue` now hands off to the real per-canvas single-flight
 *     worker in `./worker.ts` (`setImmediate` dispatch, pending-flag
 *     coalescing). The worker exercises the writer + sandbox stack
 *     in dry-run mode, so no LLM is called and no file is touched
 *     yet. PR-D swaps the analyzer body for a real `runAgent` call.
 *
 * The function is intentionally `void` and never throws — the route
 * fires it after responding to the client, so any logic that lives
 * behind it must remain non-blocking + failure-tolerant.
 */

export { OP_THRESHOLD } from './trigger.js';
export type { MemoryState } from './trigger.js';
export {
  bumpOpCounter,
  markAnalyzed,
  readMemoryState,
  writeMemoryState,
} from './trigger.js';
export { _waitForIdle } from './worker.js';
export { readWorkspaceMemory, readCanvasMemory } from './read.js';

import { schedule } from './worker.js';

/**
 * Minimal logger surface the memory module needs.
 *
 * Fastify's `request.log` satisfies this; so does `console`. The
 * memory worker uses the same surface to emit warn-level failure
 * messages without pulling in pino as a hard dep.
 */
export interface MemoryLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Ask the memory sub-agent to analyse the current canvas state.
 *
 * Returns synchronously; the worker runs after the next tick via
 * `setImmediate`. Per-canvas single-flight + pending-coalescing keep
 * back-pressure bounded under bursty op streams.
 *
 * `logger` is optional: route handlers pass `request.log` so the call
 * appears in the same request-scoped log stream as the events POST
 * that triggered it.
 */
export function enqueue(canvasId: string, logger?: MemoryLogger): void {
  schedule(canvasId, logger);
}
