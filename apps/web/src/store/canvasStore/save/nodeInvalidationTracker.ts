// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type NodeInvalidationTicket = Readonly<{
  nodeId: string;
  recordRevision: string;
  commitVersion: number;
  generation: number;
}>;

export type NodeInvalidationTracker = {
  begin(
    nodeId: string,
    recordRevision: string,
    commitVersion: number,
  ): NodeInvalidationTicket;
  isCurrent(ticket: NodeInvalidationTicket): boolean;
  consume(ticket: NodeInvalidationTicket): boolean;
  cancelThrough(nodeId: string, commitVersion: number): void;
  clear(): void;
};

const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;

/**
 * Retry a transiently failed invalidation GET until it succeeds or a later
 * inline/delete/load cancels its ticket. Advancing the canvas commit cursor
 * makes an invalidate publication non-replayable, so a one-shot GET would
 * otherwise leave the node stale forever after any network/5xx blip.
 */
export async function retryTrackedInvalidation<T>(opts: {
  tracker: Pick<NodeInvalidationTracker, 'isCurrent'>;
  ticket: NodeInvalidationTicket;
  fetch: () => Promise<T | null>;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<T | null> {
  const wait =
    opts.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  let attempt = 0;
  while (opts.tracker.isCurrent(opts.ticket)) {
    const response = await opts.fetch();
    if (!opts.tracker.isCurrent(opts.ticket)) return null;
    if (response !== null) return response;
    const delayMs = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** attempt,
      MAX_RETRY_DELAY_MS,
    );
    attempt += 1;
    await wait(delayMs);
  }
  return null;
}

/**
 * Coordinates invalidate-driven node GETs with later inline/delete commits.
 * A monotonically increasing ticket avoids an ABA race when the same record
 * revision is requested twice around a cancellation.
 */
export function createNodeInvalidationTracker(): NodeInvalidationTracker {
  let generation = 0;
  const current = new Map<string, NodeInvalidationTicket>();

  return {
    begin(nodeId, recordRevision, commitVersion) {
      const ticket = {
        nodeId,
        recordRevision,
        commitVersion,
        generation: ++generation,
      };
      current.set(nodeId, ticket);
      return ticket;
    },

    isCurrent(ticket) {
      return current.get(ticket.nodeId) === ticket;
    },

    consume(ticket) {
      if (current.get(ticket.nodeId) !== ticket) return false;
      current.delete(ticket.nodeId);
      return true;
    },

    cancelThrough(nodeId, commitVersion) {
      const ticket = current.get(nodeId);
      if (ticket && ticket.commitVersion <= commitVersion) {
        current.delete(nodeId);
      }
    },

    clear() {
      current.clear();
    },
  };
}
