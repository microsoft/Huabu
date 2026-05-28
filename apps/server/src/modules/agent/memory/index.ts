/**
 * Memory module public entry point.
 *
 * Single function used by the canvas event route: when the per-canvas
 * op counter crosses {@link OP_THRESHOLD}, the route calls
 * {@link enqueue} to ask the memory sub-agent to run an analysis pass.
 *
 * Stub phase (PR-B):
 *   - the sub-agent + writers don't exist yet, so `enqueue` only logs
 *     the call and returns. This validates the trigger path
 *     end-to-end (events route → bumpOpCounter → enqueue) without
 *     actually touching memory files. PR-C swaps the stub for the
 *     real per-canvas single-flight worker.
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

/**
 * Minimal logger surface the memory module needs.
 *
 * Fastify's `request.log` satisfies this; so does `console`. The
 * memory worker (PR-C) will use the same surface to emit warn-level
 * failure messages without pulling in pino as a hard dep.
 */
export interface MemoryLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Ask the memory sub-agent to analyse the current canvas state.
 *
 * In PR-B this is a stub that only logs. PR-C wires it up to the
 * real per-canvas single-flight worker (`setImmediate` dispatch,
 * pending-flag coalescing). Callers must not await the side effects
 * — the worker is by design non-blocking and silent.
 *
 * `logger` is optional: route handlers pass `request.log` so the call
 * appears in the same request-scoped log stream as the events POST
 * that triggered it.
 */
export function enqueue(canvasId: string, logger?: MemoryLogger): void {
  // PR-B stub. The Promise/single-flight machinery lands in PR-C.
  const log = logger ?? console;
  log.info(
    `[memory] enqueue requested for canvas ${canvasId} (stub — no worker yet)`,
  );
}
