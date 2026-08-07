// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * L1 wiring for the ACP profile-schema cache (M3 / A4).
 *
 * The cache is a purely L1 UX concern (it paints selectors + the `/` menu
 * before a fresh session reports its authoritative surface), so L1 both
 * reads from and writes to it — L2 never reaches up into it. This module
 * owns both directions of that arrow:
 *
 *   - READ: it installs a read-only {@link AcpProfileCachePort} into the ACP
 *     composition shell (`session.ts`) so a cold session can paint its
 *     warm-start slash-command list.
 *   - WRITE: it subscribes to the Agenetes instance's `notifications()`
 *     stream (I9.7) per thread and folds each up-reported {@link AgentMetadata}
 *     snapshot into the cache under the thread's `profileId`. This replaces
 *     the old driver-side `AcpProfileCachePort.mirror(entry)` push — the
 *     driver no longer knows the cache exists.
 *
 * See docs/proposals/layered-architecture.md §7 (M3 / A4).
 */

import { setAcpProfileCachePort } from '@agenetes/acp-driver';

import {
  foldMetadataIntoProfileCache,
  getProfileSchemaCache,
} from './profile-schema-cache.js';
import { agenetes } from '../agenetes/drivers.js';

/** Install the L1 read-side profile-schema-cache port into the ACP shell. */
export function installAcpProfileCachePort(): void {
  setAcpProfileCachePort({
    readCommands: (profileId) => {
      const cache = getProfileSchemaCache(profileId);
      if (!cache?.availableCommands || cache.availableCommands.length === 0) {
        return null;
      }
      return {
        availableCommands: cache.availableCommands,
        commandsUpdatedAt: cache.commandsUpdatedAt ?? 0,
      };
    },
  });
}

/**
 * Threads with a live `notifications()` fold running. Guards against
 * starting a second loop for a thread that is already subscribed — L1 calls
 * {@link ensureProfileCacheSubscription} on every turn / set-RPC, but the
 * fold must run exactly once per live thread.
 */
const subscribedThreads = new Set<string>();

/**
 * Ensure a single `notifications()` fold loop is running for `threadId`,
 * writing every up-reported metadata snapshot into the profile cache under
 * `profileId`. Idempotent: a no-op when the thread is already subscribed.
 *
 * The loop ends when the instance closes the thread's notification stream
 * (on `close(threadId)`), at which point the guard is cleared so a later
 * re-open re-subscribes. Errors are swallowed — a failed fold must never
 * break the turn that spawned the thread.
 */
export function ensureProfileCacheSubscription(
  threadId: string,
  profileId: string,
): void {
  if (!threadId || !profileId) return;
  if (subscribedThreads.has(threadId)) return;
  subscribedThreads.add(threadId);
  void (async () => {
    try {
      for await (const meta of agenetes.notifications(threadId)) {
        foldMetadataIntoProfileCache(profileId, meta);
      }
    } catch {
      // Swallow: the cache is best-effort UX; a fold failure must not
      // surface on the thread's turn.
    } finally {
      subscribedThreads.delete(threadId);
    }
  })();
}
