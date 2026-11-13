// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Send queue for this page's structural edits.
 *
 * One serial lane per open Space. A batch that already ran locally is
 * appended here and sent to `POST /api/canvas/:id/execute` one request at a
 * time, each with a request id (`operationId`). A transport failure repeats
 * the same request with the same id, which the server answers from its
 * stored result, so a batch never executes twice. No read version is sent:
 * the server runs every batch on its latest state, so edits to unrelated
 * nodes from two pages never reject each other.
 *
 * The queue only transports. Applying the result, releasing in-flight
 * holds and telling the user are the caller's, through `onSettled`.
 *
 * Retries are bounded by attempts and by elapsed time. Past either limit
 * the lane stalls: nothing is dropped and nothing is sent until the caller
 * resumes or discards it.
 */

import { ApiError } from '@/api/_client';

import type {
  CanvasCommand,
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

export interface SendQueueEntry {
  /** Request id sent as `operationId`. */
  readonly id: string;
  readonly canvasId: string;
  readonly commands: CanvasCommand[];
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
  gate?: Promise<unknown>;
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

  const requestOf = (entry: Entry): PostCanvasExecuteRequest => ({
    commands: entry.commands,
    originator: { source: 'ui', tabId: options.clientId },
    operationId: entry.id,
  });

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
