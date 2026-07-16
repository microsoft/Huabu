const activeThreads = new Set<string>();

/**
 * Acquire exclusive execution for one live thread.
 *
 * Returns an idempotent release callback, or `null` when another turn is
 * already running.
 */
export function acquireAgentTurn(threadId: string): (() => void) | null {
  if (activeThreads.has(threadId)) return null;
  activeThreads.add(threadId);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeThreads.delete(threadId);
  };
}
