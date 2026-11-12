// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Coordinator between this page's send queue, its in-flight set and the
 * Canvas Sync apply channel.
 *
 * - `submit` — a batch already ran locally: hold what it changed and queue
 *   the commands.
 * - `prepareRemote` — an update is about to be replayed: rewrite it to the
 *   property units it changed, keep back the ones this page holds, and on
 *   `finish` release the holds of this page's own confirmed batch.
 * - `deferReload` — a whole-Space reload is wanted (version gap, snapshot
 *   mismatch, rejected command): run it only once nothing is left to send.
 *
 * Store access goes through `deps`, so this module has no import cycle with
 * `canvasStore` and can be driven by a fake store in tests.
 */

import { toFieldLevelDeltas, type FieldLevelResult } from './fieldLevelDeltas';
import {
  deriveHeldKeys,
  InFlightSet,
  orderKey,
  type WithheldUnit,
} from './inFlight';
import {
  createSendQueue,
  type EnqueueResult,
  type SendOutcome,
  type SendQueue,
  type SendQueueEntry,
  type SendQueueOptions,
  type SendQueueStatus,
} from './sendQueue';

import type { UnitNode } from './propertyUnits';
import type { CanvasCommand, PostCanvasExecuteResponse } from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';

type UnitEdge = { id: string } & Record<string, unknown>;

export interface BrowserSyncDeps {
  send: SendQueueOptions['send'];
  clientId: string;
  retry?: SendQueueOptions['retry'];
  /** The open Space and the version it has applied. */
  getState: () => { canvasId: string; version: number };
  /**
   * Replay this page's own response through the normal apply path. Called
   * only when the response is the next contiguous version, i.e. when it is
   * exactly the update the stream is about to deliver.
   */
  applyOwnResponse: (
    response: PostCanvasExecuteResponse,
    operationId: string,
  ) => void;
  /** Install unit values on live nodes; no save, no undo entry. */
  applyWithheld: (canvasId: string, units: readonly WithheldUnit[]) => void;
  /** Commands the server refused (not a no-op), or a refused request. */
  onRejected: (info: {
    canvasId: string;
    entry: SendQueueEntry;
    outcome: SendOutcome;
  }) => void;
  /** Adopt the server's whole Space; called only with an empty queue. */
  reload: (canvasId: string) => void;
  /** Units saved by another writer, never held by the queue. */
  ignoreUnit?: (unit: string) => boolean;
  /** How long to wait for a confirmed batch's update before reloading. */
  echoTimeoutMs?: number;
}

export interface SubmitInput {
  canvasId: string;
  commands: CanvasCommand[];
  /**
   * State before the batch ran locally — for a batch that closes a pointer
   * gesture, the state when the gesture began, so what its live ticks moved
   * without a command is held too.
   */
  prev: { nodes: readonly UnitNode[]; edges: readonly UnitEdge[] };
  /** State after the batch ran locally. */
  next: { nodes: readonly UnitNode[]; edges: readonly UnitEdge[] };
  gate?: Promise<unknown>;
  /**
   * The batch reports something the page derived (a measured height) rather
   * than something the user did. Its units are held while it is in flight,
   * but a server that does not take it leaves the page's value in place
   * instead of putting back the one before.
   */
  derived?: boolean;
  /**
   * Called synchronously when the batch's request is answered or dropped,
   * after its holds are released and before the next request is sent.
   * `offset` is the index of this batch's first command in the response.
   */
  onSettled?: (outcome: SendOutcome, offset: number) => void;
}

export interface PrepareRemoteInput {
  deltas: readonly Delta[];
  localNodes: readonly UnitNode[];
  localEdges: readonly UnitEdge[];
  /** Request id carried by the update, when its writer supplied one. */
  operationId?: string;
  /** Who wrote the batch, when the server says. */
  source?: 'ui' | 'agent' | 'system';
  /**
   * Keys held for a reason the queue does not know: what a pointer gesture
   * has changed so far and not sent yet.
   */
  alsoHeld?: (key: string) => boolean;
}

export interface PreparedRemote extends FieldLevelResult {
  /** The update confirms a batch this page sent. */
  own: boolean;
  /** Whether this page holds an unconfirmed change to a parent's child order. */
  orderHeld: (parentId: string | null) => boolean;
  /** Record what was withheld and release this page's confirmed holds. */
  finish: () => void;
}

export interface BrowserSync {
  readonly queue: SendQueue;
  submit(input: SubmitInput): EnqueueResult;
  prepareRemote(input: PrepareRemoteInput): PreparedRemote;
  /** Run `reload` now, or as soon as the queue has nothing left to send. */
  deferReload(canvasId: string): void;
  /** Unanswered entries, or confirmed ones whose update has not arrived. */
  isBusy(canvasId: string): boolean;
  /** Resolves when not busy, or as soon as the queue stalls. */
  whenQuiet(canvasId: string): Promise<'quiet' | 'stalled'>;
  /** The page adopted a whole-Space server state: forget every hold. */
  adoptedServerState(canvasId: string): void;
  /** Drop unsent changes; a wanted reload then runs. */
  discard(canvasId: string): void;
  /** Forget all queue and hold state without side effects. For test isolation. */
  reset(): void;
}

export function createBrowserSync(deps: BrowserSyncDeps): BrowserSync {
  const inFlight = new InFlightSet();
  const echoTimeoutMs = deps.echoTimeoutMs ?? 8_000;
  /** Confirmed entries whose update this page has not applied yet. */
  const awaitingEcho = new Map<
    string,
    { canvasId: string; timer: ReturnType<typeof setTimeout> }
  >();
  const reloadWanted = new Set<string>();
  const settleHooks = new Map<
    string,
    Array<{ offset: number; run: NonNullable<SubmitInput['onSettled']> }>
  >();
  const quietWaiters = new Set<() => void>();

  const changed = (): void => {
    for (const waiter of [...quietWaiters]) waiter();
  };

  const release = (
    canvasId: string,
    entryId: string,
    covered: ReadonlySet<string>,
  ): void => {
    const pending = awaitingEcho.get(entryId);
    if (pending) {
      clearTimeout(pending.timer);
      awaitingEcho.delete(entryId);
    }
    const freed = inFlight.release(entryId, covered);
    if (freed.length > 0) deps.applyWithheld(canvasId, freed);
  };

  const runReloadIfIdle = (canvasId: string): void => {
    if (!reloadWanted.has(canvasId) || queue.hasPending(canvasId)) return;
    reloadWanted.delete(canvasId);
    deps.reload(canvasId);
  };

  const onSettled = (entry: SendQueueEntry, outcome: SendOutcome): void => {
    try {
      settleEntry(entry, outcome);
    } finally {
      const hooks = settleHooks.get(entry.id);
      settleHooks.delete(entry.id);
      for (const hook of hooks ?? []) hook.run(outcome, hook.offset);
      changed();
    }
  };

  const settleEntry = (entry: SendQueueEntry, outcome: SendOutcome): void => {
    const { canvasId } = entry;
    if (outcome.kind === 'discarded') {
      // The discard is followed by a reload, which clears the holds.
      changed();
      return;
    }
    if (outcome.kind === 'failed') {
      release(canvasId, entry.id, new Set());
      deps.onRejected({ canvasId, entry, outcome });
      // A request that was never sent changed nothing on the server; the
      // released holds already put this page back.
      if (outcome.sent) reloadWanted.add(canvasId);
      changed();
      return;
    }

    const { response } = outcome;
    const refused = response.results.some(
      (result) => !result.applied && result.reason !== 'no-op',
    );
    const state = deps.getState();
    if (response.toVersion === response.fromVersion) {
      // Nothing was written, so no update will arrive: what other pages
      // wrote to the held units meanwhile is the server's value.
      release(canvasId, entry.id, new Set());
    } else if (state.canvasId === canvasId) {
      if (state.version === response.fromVersion) {
        deps.applyOwnResponse(response, entry.id);
      } else if (state.version < response.toVersion) {
        awaitingEcho.set(entry.id, {
          canvasId,
          timer: setTimeout(() => {
            if (!awaitingEcho.has(entry.id)) return;
            // The stream never delivered it; converge by reloading.
            reloadWanted.add(canvasId);
            runReloadIfIdle(canvasId);
          }, echoTimeoutMs),
        });
      } else {
        // The update already arrived on the stream. When it carried this
        // request's id it released the entry and this finds nothing; when
        // it did not, its values for the held units were kept back and are
        // installed now.
        release(canvasId, entry.id, new Set());
      }
    } else {
      release(canvasId, entry.id, new Set());
    }
    if (refused) {
      deps.onRejected({ canvasId, entry, outcome });
      reloadWanted.add(canvasId);
    }
    changed();
  };

  const queue = createSendQueue({
    send: deps.send,
    clientId: deps.clientId,
    ...(deps.retry ? { retry: deps.retry } : {}),
    onSettled,
  });

  queue.subscribe((status: SendQueueStatus) => {
    if (status.phase === 'idle') runReloadIfIdle(status.canvasId);
    changed();
  });

  const isBusy = (canvasId: string): boolean => {
    if (queue.hasPending(canvasId)) return true;
    for (const pending of awaitingEcho.values()) {
      if (pending.canvasId === canvasId) return true;
    }
    return false;
  };

  return {
    queue,

    submit(input) {
      const result = queue.enqueue(input.canvasId, input.commands, {
        ...(input.gate ? { gate: input.gate } : {}),
      });
      const keys = deriveHeldKeys(input.prev, input.next, deps.ignoreUnit);
      if (input.derived) for (const key of keys.keys()) keys.set(key, null);
      inFlight.hold(result.entry.id, keys);
      if (input.onSettled) {
        const hooks = settleHooks.get(result.entry.id) ?? [];
        hooks.push({ offset: result.offset, run: input.onSettled });
        settleHooks.set(result.entry.id, hooks);
      }
      return result;
    },

    prepareRemote(input) {
      const { operationId } = input;
      const own = operationId !== undefined && queue.isOwn(operationId);
      const except = own ? operationId : undefined;
      const result = toFieldLevelDeltas({
        deltas: input.deltas,
        localNodes: input.localNodes,
        localEdges: input.localEdges,
        isHeld: (key) =>
          inFlight.isHeld(key, except) || input.alsoHeld?.(key) === true,
        stripInsertedSelection: !own && input.source === 'ui',
      });
      return {
        ...result,
        own,
        orderHeld: (parentId) => inFlight.isHeld(orderKey(parentId), except),
        finish: () => {
          for (const unit of result.withheld) inFlight.withhold(unit);
          if (own && operationId !== undefined)
            release(deps.getState().canvasId, operationId, result.covered);
          changed();
        },
      };
    },

    deferReload(canvasId) {
      reloadWanted.add(canvasId);
      runReloadIfIdle(canvasId);
    },

    isBusy,

    whenQuiet(canvasId) {
      return new Promise((resolve) => {
        const check = (): boolean => {
          if (queue.status(canvasId).phase === 'stalled') {
            quietWaiters.delete(check);
            resolve('stalled');
            return true;
          }
          if (isBusy(canvasId)) return false;
          quietWaiters.delete(check);
          resolve('quiet');
          return true;
        };
        if (!check()) quietWaiters.add(check);
      });
    },

    adoptedServerState(canvasId) {
      inFlight.clear();
      for (const [entryId, pending] of awaitingEcho) {
        if (pending.canvasId !== canvasId) continue;
        clearTimeout(pending.timer);
        awaitingEcho.delete(entryId);
      }
      reloadWanted.delete(canvasId);
      changed();
    },

    discard(canvasId) {
      queue.discard(canvasId);
      changed();
    },

    reset() {
      queue.reset();
      inFlight.clear();
      for (const pending of awaitingEcho.values()) clearTimeout(pending.timer);
      awaitingEcho.clear();
      reloadWanted.clear();
      settleHooks.clear();
      changed();
    },
  };
}
