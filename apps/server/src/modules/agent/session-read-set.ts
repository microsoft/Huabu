// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Session-scoped read-sets, keyed by conversation `threadId`. Each maps
 * `nodeId → authored-content rev` — the revs the agent has actually
 * **read** (full body) during this conversation. `read`'s `recordNodeRev`
 * populates it (re-reads overwrite with the fresh rev, self-healing
 * staleness); `canvas_commands` consumes it to auto-inject `expectRev`.
 *
 * NOT seeded from context previews: a node ref carries only a ~120-char
 * preview, not the body, so knowing its rev is no basis for rewriting its
 * content. "Has an entry" therefore means "was fully read this session" —
 * true read-before-write (Claude Code's model).
 *
 * In-memory only; lost on server restart (a dropped entry just costs one
 * re-read). Bounded by a small LRU over threads to avoid unbounded growth.
 *
 * Lives in its own module (rather than inline in `agent.service.ts`) so
 * both the composition shell (`runAgent`) and the built-in driver factory
 * (`agenetes/drivers.ts`) can resolve the same per-thread map without a
 * circular import between those two modules.
 */
const SESSION_READ_SETS = new Map<string, Map<string, string>>();
const MAX_TRACKED_THREADS = 200;

/**
 * Resolve the read-set map for a conversation `threadId` (creating it on
 * first use, refreshing LRU recency on reuse). Stateless callers with no
 * thread get an ephemeral per-run map.
 */
export function getSessionReadSet(
  threadId: string | undefined,
): Map<string, string> {
  // No thread (stateless callers) → an ephemeral per-run map.
  if (!threadId) return new Map();
  const existing = SESSION_READ_SETS.get(threadId);
  if (existing) {
    // Refresh LRU recency (Map preserves insertion order).
    SESSION_READ_SETS.delete(threadId);
    SESSION_READ_SETS.set(threadId, existing);
    return existing;
  }
  const created = new Map<string, string>();
  SESSION_READ_SETS.set(threadId, created);
  if (SESSION_READ_SETS.size > MAX_TRACKED_THREADS) {
    const oldest = SESSION_READ_SETS.keys().next().value;
    if (oldest !== undefined) SESSION_READ_SETS.delete(oldest);
  }
  return created;
}
