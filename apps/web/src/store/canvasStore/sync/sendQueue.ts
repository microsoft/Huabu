// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Send queue for this page's structural edits.
 *
 * One serial lane per open Space. A batch that already ran locally is
 * appended here and sent to `POST /api/canvas/:id/execute` one request at a
 * time, each with a request id (`operationId`). A transport failure repeats
 * the same request with the same id, which the server answers from its
 * stored result, so a batch never executes twice.
 *
 * Every batch is one run of the request and states the read version it was
 * made on (`runs`), and the earlier, still unconfirmed batches of this page
 * it was made on top of. The server checks each run against the nodes it
 * names only, so edits to unrelated nodes from two pages never reject each
 * other, and takes or refuses a run as a whole.
 *
 * The queue only transports. Applying the result, releasing in-flight
 * holds and telling the user are the caller's, through `onSettled`.
 *
 * Retries are bounded by attempts and by elapsed time. Past either limit
 * the lane stalls: nothing is dropped and nothing is sent until the caller
 * resumes or discards it.
 *
 * A derived entry reports something the page computed (a measured height or
 * box), not something the user did. It is sent like any other, but it is not
 * unsent work: a lane that reaches the limit holding only derived entries
 * gives them up instead of stalling, and `derivedPending` lets callers leave
 * them out of what they tell or ask the user.
 */

import { ApiError } from '@/api/_client';

import type {
  CanvasCommand,
  CanvasExecuteRun,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';

export type SendOutcome =
  /** The server answered; per-command results are in the response. */
  | { kind: 'response'; response: PostCanvasExecuteResponse }
  /**
   * The server refused the request (`sent: true`), or the entry's gate
   * failed and nothing was sent (`sent: false`).
   */
  | { kind: 'failed'; error: unknown; sent: boolean }
  /** The caller discarded the lane before the request was answered. */
  | { kind: 'discarded' };

/** One queued batch, by the entry it is in and its place there. */
export interface QueuedRunRef {
  readonly entryId: string;
  readonly start: number;
  readonly count: number;
}

/** One queued batch as a run of its entry's commands. */
export interface QueuedRun {
  readonly start: number;
  readonly count: number;
  /** The read version the batch was made on. */
  readonly basis: string;
  /** Unconfirmed batches of this page the batch was made on top of. */
  readonly after: readonly QueuedRunRef[];
}

/** Most earlier batches a run names; the newest are kept. */
export const MAX_RUN_AFTER = 64;

export interface SendQueueEntry {
  /** Request id sent as `operationId`. */
  readonly id: string;
  readonly canvasId: string;
  readonly commands: CanvasCommand[];
  /** The batches folded into the entry that state a read version. */
  readonly runs: QueuedRun[];
  /** Every batch in the entry is a derived report; see the module comment. */
  readonly derived: boolean;
  /** Resolves once the entry leaves the queue. Never rejects. */
  readonly settled: Promise<SendOutcome>;
}

export type SendQueuePhase =
  /** Nothing waiting. */
  | 'idle'
  /** A request is on the wire or about to be. */
  | 'sending'
  /** The last attempt failed; another is scheduled. */
  | 'retrying'
  /** The retry limit was reached; waiting for the user to decide. */
  | 'stalled';

export interface SendQueueStatus {
  canvasId: string;
  phase: SendQueuePhase;
  /** Entries not yet answered. */
  pending: number;
  /** How many of them are derived reports rather than the user's edits. */
  derivedPending: number;
  /** Consecutive failed attempts; above zero the Space is unsynced. */
  failures: number;
}

export interface SendQueueRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Consecutive failed attempts before the lane stalls. */
  maxAttempts: number;
  /** Time since the first consecutive failure before the lane stalls. */
  maxElapsedMs: number;
}

export const DEFAULT_SEND_RETRY: SendQueueRetryPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: 8,
  maxElapsedMs: 60_000,
};

export interface SendQueueOptions {
  send: (
    canvasId: string,
    request: PostCanvasExecuteRequest,
    options?: { keepalive?: boolean },
  ) => Promise<PostCanvasExecuteResponse>;
  /** Identifies this page in `originator.tabId`. */
  clientId: string;
  createId?: () => string;
  retry?: SendQueueRetryPolicy;
  /** Largest merged batch; a longer run of edits is sent as several. */
  maxBatchCommands?: number;
  /**
   * What became of a batch of an earlier entry, when its answer is known. A
   * batch that took effect is no longer named in `after`; any other is, and
   * the server decides.
   */
  runOutcome?: (ref: QueuedRunRef) => 'applied' | 'refused' | undefined;
  now?: () => number;
  /**
   * Called synchronously when an entry leaves the queue, before the next
   * one is sent, so results are handled in send order.
   */
  onSettled?: (entry: SendQueueEntry, outcome: SendOutcome) => void;
}

export interface EnqueueOptions {
  /**
   * Awaited before the entry is sent. A rejection fails the entry without
   * sending it.
   */
  gate?: Promise<unknown>;
  /** The batch is a derived report, not an edit the user made. */
  derived?: boolean;
  /**
   * The read version the batch was made on, and the unconfirmed batches of
   * this page it was made on top of. Omitted, the batch is sent unchecked.
   */
  run?: { basis: string; after?: readonly QueuedRunRef[] };
}

export interface EnqueueResult {
  entry: SendQueueEntry;
  /** Index of the first of these commands within `entry.commands`. */
  offset: number;
}

export interface SendQueue {
  enqueue(
    canvasId: string,
    commands: CanvasCommand[],
    options?: EnqueueOptions,
  ): EnqueueResult;
  status(canvasId: string): SendQueueStatus;
  /** Whether `canvasId` has entries not yet answered. */
  hasPending(canvasId: string): boolean;
  /** Whether `canvasId` has an unanswered entry that is the user's edit. */
  hasUserPending(canvasId: string): boolean;
  /** Whether `operationId` is a request this page issued. */
  isOwn(operationId: string): boolean;
  /** Resolves when the lane is empty, or as soon as it stalls. */
  whenIdle(canvasId: string): Promise<'idle' | 'stalled'>;
  /**
   * Start over: forget the failures so far, leave the stalled state or cut
   * a retry delay short, and try again. For a deliberate choice ("Keep
   * trying") or a sign that the cause is gone (back online, session renewed).
   */
  resume(canvasId: string): void;
  /**
   * Cut a retry delay short without forgetting the failures so far, so the
   * attempt counts towards the retry limit. A stalled lane stays stalled.
   */
  retryNow(canvasId: string): void;
  /** Drop every unanswered entry of the lane. */
  discard(canvasId: string): void;
  /**
   * Page-close flush: repeat the request on the wire and send everything
   * still queued, with `keepalive`, without waiting for answers.
   */
  flushKeepalive(): void;
  subscribe(listener: (status: SendQueueStatus) => void): () => void;
  /** Forget every lane without notifying anyone. For test isolation. */
  reset(): void;
}

/** Whether repeating the same request can still succeed. */
export function isRetryableSendError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // network failure, abort
  // 401 waits for the session to be renewed; the rest are transient.
  return (
    error.status >= 500 ||
    error.status === 401 ||
    error.status === 408 ||
    error.status === 429
  );
}

function isExecuteResponse(value: unknown): value is PostCanvasExecuteResponse {
  const response = value as Partial<PostCanvasExecuteResponse> | null;
  return (
    typeof response === 'object' &&
    response !== null &&
    Array.isArray(response.results) &&
    Array.isArray(response.deltas) &&
    typeof response.fromVersion === 'number' &&
    typeof response.toVersion === 'number'
  );
}

interface Entry extends SendQueueEntry {
  derived: boolean;
  gate?: Promise<unknown>;
  /**
   * The request as first sent. Every repeat sends exactly this: the server
   * answers a request id only for the request it was first used for.
   */
  request?: PostCanvasExecuteRequest;
  sending: boolean;
  attempted: boolean;
  resolve: (outcome: SendOutcome) => void;
}

interface Lane {
  canvasId: string;
  entries: Entry[];
  running: boolean;
  phase: SendQueuePhase;
  failures: number;
  firstFailureAt: number | null;
  wake: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  idleWaiters: Array<(result: 'idle' | 'stalled') => void>;
}

const MAX_REMEMBERED_IDS = 2_000;

export function createSendQueue(options: SendQueueOptions): SendQueue {
  const retry = options.retry ?? DEFAULT_SEND_RETRY;
  // Read through `Date` at call time, so a replaced clock is honoured.
  const now = options.now ?? (() => Date.now());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const maxBatch = options.maxBatchCommands ?? 200;
  const lanes = new Map<string, Lane>();
  const listeners = new Set<(status: SendQueueStatus) => void>();
  const ownIds = new Set<string>();

  const laneOf = (canvasId: string): Lane => {
    let lane = lanes.get(canvasId);
    if (!lane) {
      lane = {
        canvasId,
        entries: [],
        running: false,
        phase: 'idle',
        failures: 0,
        firstFailureAt: null,
        wake: null,
        timer: null,
        idleWaiters: [],
      };
      lanes.set(canvasId, lane);
    }
    return lane;
  };

  const statusOf = (lane: Lane): SendQueueStatus => ({
    canvasId: lane.canvasId,
    phase: lane.phase,
    pending: lane.entries.length,
    derivedPending: lane.entries.filter((entry) => entry.derived).length,
    failures: lane.failures,
  });

  const publish = (lane: Lane): void => {
    const status = statusOf(lane);
    for (const listener of listeners) listener(status);
    if (lane.phase === 'idle' || lane.phase === 'stalled') {
      const waiters = lane.idleWaiters.splice(0);
      for (const waiter of waiters) waiter(lane.phase);
    }
  };

  const setPhase = (lane: Lane, phase: SendQueuePhase): void => {
    lane.phase = phase;
    publish(lane);
  };

  const wireRun = (entry: Entry, run: QueuedRun): CanvasExecuteRun => {
    const after: NonNullable<CanvasExecuteRun['after']> = [];
    for (const ref of run.after) {
      if (ref.entryId === entry.id) {
        after.push({ start: ref.start, count: ref.count });
      } else if (options.runOutcome?.(ref) !== 'applied') {
        after.push({
          operationId: ref.entryId,
          start: ref.start,
          count: ref.count,
        });
      }
    }
    return {
      start: run.start,
      count: run.count,
      basis: run.basis,
      ...(after.length > 0 ? { after: after.slice(-MAX_RUN_AFTER) } : {}),
    };
  };

  const requestOf = (entry: Entry): PostCanvasExecuteRequest => {
    // From here on nothing may be folded into the entry either.
    entry.attempted = true;
    entry.request ??= {
      commands: entry.commands,
      originator: { source: 'ui', tabId: options.clientId },
      operationId: entry.id,
      ...(entry.runs.length > 0
        ? { runs: entry.runs.map((run) => wireRun(entry, run)) }
        : {}),
    };
    return entry.request;
  };

  const settle = (lane: Lane, entry: Entry, outcome: SendOutcome): void => {
    const index = lane.entries.indexOf(entry);
    if (index >= 0) lane.entries.splice(index, 1);
    options.onSettled?.(entry, outcome);
    entry.resolve(outcome);
  };

  const pause = (lane: Lane, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        if (lane.timer) clearTimeout(lane.timer);
        lane.timer = null;
        lane.wake = null;
        resolve();
      };
      lane.wake = done;
      lane.timer = setTimeout(done, ms);
    });

  const pump = async (lane: Lane): Promise<void> => {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.phase !== 'stalled') {
        const entry = lane.entries[0];
        if (!entry) break;
        if (entry.gate) {
          try {
            await entry.gate;
          } catch (error) {
            if (lane.entries[0] === entry)
              settle(lane, entry, { kind: 'failed', error, sent: false });
            continue;
          }
          if (lane.entries[0] !== entry) continue;
        }
        entry.sending = true;
        entry.attempted = true;
        setPhase(lane, 'sending');
        let response: PostCanvasExecuteResponse;
        try {
          response = await options.send(lane.canvasId, requestOf(entry));
        } catch (error) {
          entry.sending = false;
          if (lane.entries[0] !== entry) continue; // discarded meanwhile
          if (!isRetryableSendError(error)) {
            settle(lane, entry, { kind: 'failed', error, sent: true });
            continue;
          }
          lane.failures += 1;
          lane.firstFailureAt ??= now();
          if (
            lane.failures >= retry.maxAttempts ||
            now() - lane.firstFailureAt >= retry.maxElapsedMs
          ) {
            if (lane.entries.every((queued) => queued.derived)) {
              // Nothing of the user's is waiting: give the reports up
              // rather than ask the user to decide about them.
              lane.failures = 0;
              lane.firstFailureAt = null;
              for (const queued of [...lane.entries])
                settle(lane, queued, { kind: 'failed', error, sent: false });
              continue;
            }
            setPhase(lane, 'stalled');
            break;
          }
          setPhase(lane, 'retrying');
          await pause(
            lane,
            Math.min(
              retry.maxDelayMs,
              retry.baseDelayMs * 2 ** (lane.failures - 1),
            ),
          );
          continue;
        }
        entry.sending = false;
        lane.failures = 0;
        lane.firstFailureAt = null;
        if (lane.entries[0] !== entry) continue; // discarded meanwhile
        if (!isExecuteResponse(response)) {
          settle(lane, entry, {
            kind: 'failed',
            error: new Error('Malformed execute response'),
            sent: true,
          });
          continue;
        }
        settle(lane, entry, { kind: 'response', response });
      }
    } finally {
      lane.running = false;
      if (lane.phase !== 'stalled') {
        setPhase(lane, lane.entries.length > 0 ? 'sending' : 'idle');
        // An entry added while the last one was settling.
        if (lane.entries.length > 0) void pump(lane);
      }
    }
  };

  return {
    enqueue(canvasId, commands, enqueueOptions) {
      const lane = laneOf(canvasId);
      const last = lane.entries[lane.entries.length - 1];
      // Fold a run of edits made while a request is on the wire into one
      // batch, so a slider drag does not become one round trip per tick.
      if (
        last &&
        !last.attempted &&
        !last.gate &&
        !enqueueOptions?.gate &&
        last.commands.length + commands.length <= maxBatch
      ) {
        const offset = last.commands.length;
        last.commands.push(...commands);
        if (enqueueOptions?.run && commands.length > 0) {
          last.runs.push({
            start: offset,
            count: commands.length,
            basis: enqueueOptions.run.basis,
            after: enqueueOptions.run.after ?? [],
          });
        }
        last.derived &&= enqueueOptions?.derived === true;
        publish(lane);
        return { entry: last, offset };
      }
      let resolve!: (outcome: SendOutcome) => void;
      const settled = new Promise<SendOutcome>((r) => {
        resolve = r;
      });
      const entry: Entry = {
        id: createId(),
        canvasId,
        commands: [...commands],
        runs:
          enqueueOptions?.run && commands.length > 0
            ? [
                {
                  start: 0,
                  count: commands.length,
                  basis: enqueueOptions.run.basis,
                  after: enqueueOptions.run.after ?? [],
                },
              ]
            : [],
        derived: enqueueOptions?.derived === true,
        settled,
        ...(enqueueOptions?.gate ? { gate: enqueueOptions.gate } : {}),
        sending: false,
        attempted: false,
        resolve,
      };
      ownIds.add(entry.id);
      if (ownIds.size > MAX_REMEMBERED_IDS) {
        ownIds.delete(ownIds.values().next().value as string);
      }
      lane.entries.push(entry);
      if (lane.phase === 'idle') lane.phase = 'sending';
      publish(lane);
      void pump(lane);
      return { entry, offset: 0 };
    },

    status: (canvasId) => statusOf(laneOf(canvasId)),

    hasPending: (canvasId) => (lanes.get(canvasId)?.entries.length ?? 0) > 0,

    hasUserPending: (canvasId) =>
      lanes.get(canvasId)?.entries.some((entry) => !entry.derived) ?? false,

    isOwn: (operationId) => ownIds.has(operationId),

    whenIdle(canvasId) {
      const lane = lanes.get(canvasId);
      if (!lane || lane.entries.length === 0) return Promise.resolve('idle');
      if (lane.phase === 'stalled') return Promise.resolve('stalled');
      return new Promise((resolve) => lane.idleWaiters.push(resolve));
    },

    resume(canvasId) {
      const lane = lanes.get(canvasId);
      if (!lane) return;
      lane.failures = 0;
      lane.firstFailureAt = null;
      if (lane.phase === 'stalled') {
        lane.phase = lane.entries.length > 0 ? 'sending' : 'idle';
        publish(lane);
        void pump(lane);
        return;
      }
      lane.wake?.();
    },

    retryNow(canvasId) {
      const lane = lanes.get(canvasId);
      if (lane && lane.phase !== 'stalled') lane.wake?.();
    },

    discard(canvasId) {
      const lane = lanes.get(canvasId);
      if (!lane) return;
      const dropped = lane.entries.splice(0);
      lane.failures = 0;
      lane.firstFailureAt = null;
      for (const entry of dropped) {
        options.onSettled?.(entry, { kind: 'discarded' });
        entry.resolve({ kind: 'discarded' });
      }
      lane.phase = 'idle';
      lane.wake?.();
      publish(lane);
    },

    flushKeepalive() {
      for (const lane of lanes.values()) {
        for (const entry of lane.entries) {
          // A gated entry has not met its precondition; it cannot be sent.
          if (entry.gate && !entry.attempted) break;
          void options
            .send(lane.canvasId, requestOf(entry), { keepalive: true })
            .catch(() => undefined);
        }
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    reset() {
      for (const lane of lanes.values()) {
        for (const entry of lane.entries.splice(0))
          entry.resolve({ kind: 'discarded' });
        lane.phase = 'idle';
        lane.wake?.();
        for (const waiter of lane.idleWaiters.splice(0)) waiter('idle');
      }
      lanes.clear();
    },
  };
}
