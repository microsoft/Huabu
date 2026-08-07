// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

interface TurnLease {
  released: Promise<void>;
  resolveReleased: () => void;
}

const activeThreads = new Map<string, TurnLease>();

/**
 * Acquire exclusive execution for one live thread.
 *
 * Returns an idempotent release callback, or `null` when another turn is
 * already running.
 */
export function acquireAgentTurn(threadId: string): (() => void) | null {
  if (activeThreads.has(threadId)) return null;

  let resolveReleased: (() => void) | undefined;
  const lease: TurnLease = {
    released: new Promise<void>((resolve) => {
      resolveReleased = resolve;
    }),
    resolveReleased: () => resolveReleased?.(),
  };
  activeThreads.set(threadId, lease);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeThreads.get(threadId) === lease) {
      activeThreads.delete(threadId);
    }
    lease.resolveReleased();
  };
}

/**
 * Wait until the current turn releases, resolving immediately when idle.
 *
 * Bounded by `timeoutMs`: a wedged turn that never releases must not hang a
 * replacement request forever. On timeout the promise still resolves, letting
 * the caller fall through to `acquireAgentTurn` (which returns `null` — and a
 * `409` — while the lease is genuinely still held).
 */
export async function waitForAgentTurnRelease(
  threadId: string,
  timeoutMs = 5000,
): Promise<void> {
  const released = activeThreads.get(threadId)?.released;
  if (!released) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([released, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
