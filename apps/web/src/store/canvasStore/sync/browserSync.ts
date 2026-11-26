// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Coordinator between this page's send queue, its in-flight set and the
 * Canvas Sync apply channel.
 *
 * - `submit` — a batch already ran locally: hold what it changed and queue
 *   the commands as one edit, with the read version it was made on.
 * - `prepareRemote` — a remote change is about to be applied (an update, or
 *   content fetched after another page's save): rewrite it to the property
 *   units it changed, keep back the ones this page holds — by an unanswered
 *   batch, or by a holder the caller names (`alsoHeld`: an open gesture,
 *   unsaved content, a node being edited) — and on `finish` buffer what was
 *   kept back and release the holds of this page's own confirmed batch.
 * - `localHoldsEnded` — one of those other holders let go: show what was
 *   kept back for it, unless this page's change replaced it.
 * - `deferReload` — a whole-Space reload is wanted (version gap, snapshot
 *   mismatch, rejected command, an update that never arrived): run it only
 *   once nothing is left to send, one at a time, and again — after a backoff
 *   — when its load failed. A wanted reload is given up only by a load that
 *   succeeded or by leaving the Space.
 *
 * **Read version.** A batch states the Space version this page had applied
 * when the batch was made — taken at `submit`, which runs in the same task
 * as the edit, and never replaced by a newer one while the batch waits in
 * the queue. For a node whose placement this page was holding at that
 * moment (an unanswered batch or an open pointer gesture changed it) the
 * page was not showing what that version says: updates to it were being
 * kept back. The batch then states the version before the first update kept
 * back for a node it names (`keptBackSince`), so the server sees the change
 * the page did not show as one it has not read.
 *
 * **Made on top of.** A batch that names a node whose placement an earlier,
 * still unconfirmed batch of this page changed was made on that batch's
 * result. It says so (`after`), and is refused when that batch was.
 *
 * Store access goes through `deps`, so this module has no import cycle with
 * `canvasStore` and can be driven by a fake store in tests.
 */

import { encodeBasis } from '@huabu/shared';
import { commandReadTargets } from '@huabu/shared/canvas-engine';

import { ApiError } from '@/api/_client';

import { toFieldLevelDeltas, type FieldLevelResult } from './fieldLevelDeltas';
import {
  deriveHeldKeys,
  EXISTENCE_UNIT,
  InFlightSet,
  nodeUnitKey,
  parseKey,
  type HeldKeys,
  type WithheldUnit,
} from './inFlight';
import { PLACEMENT_UNITS, type UnitNode } from './propertyUnits';
import {
  createSendQueue,
  type EnqueueResult,
  type QueuedEditRef,
  type SendOutcome,
  type SendQueue,
  type SendQueueEntry,
  type SendQueueOptions,
  type SendQueueStatus,
} from './sendQueue';

import type { CanvasCommand, PostCanvasExecuteResponse } from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';

type UnitEdge = { id: string } & Record<string, unknown>;

/**
 * How long the update for a confirmed batch is awaited on the stream before
 * the Space is reloaded instead.
 */
export const ECHO_TIMEOUT_MS = 8_000;

/** Waits between attempts of a wanted reload whose load keeps failing. */
export const RELOAD_RETRY = { initialMs: 500, maxMs: 10_000 } as const;

/**
 * What became of a reload:
 * - `loaded` — the Space was loaded (or there is nothing left to load: the
 *   user left it);
 * - `held` — not started; its owner asks again (`deferReload`) when what
 *   holds it is over;
 * - `failed` — the load failed; it is tried again after a backoff;
 * - `again` — the load was overtaken by this page's own work and its result
 *   was not used; it is asked for again at once.
 */
export type ReloadOutcome = 'loaded' | 'held' | 'failed' | 'again';

export interface BrowserSyncDeps {
  send: SendQueueOptions['send'];
  clientId: string;
  retry?: SendQueueOptions['retry'];
  /**
   * The open Space, the version it has applied and the lineage of the read
   * versions the server issued for it (from the load). Without a lineage
   * batches are sent without a read version.
   */
  getState: () => {
    canvasId: string;
    version: number;
    lineage?: string | null;
  };
  /**
   * Keys held for a reason the queue does not know — what an open pointer
   * gesture has changed so far — or null when there is none.
   */
  gestureHeld?: () => ((key: string) => boolean) | null;
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
  /**
   * Adopt the server's whole Space; called only with an empty queue and
   * never while an earlier call for the Space is unsettled.
   */
  reload: (canvasId: string) => ReloadOutcome | Promise<ReloadOutcome>;
  /** Units saved by another writer, never held by the queue. */
  ignoreUnit?: (unit: string) => boolean;
  /** Overrides {@link ECHO_TIMEOUT_MS}. */
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
   * instead of putting back the one before. It is also not unsent work of
   * the user's: see `SendQueueEntry.derived`.
   */
  derived?: boolean;
  /**
   * Called synchronously when the batch's request is answered or dropped,
   * after its holds are released and before the next request is sent.
   * `edit` is the position of this batch's outcome in the response's
   * `edits` (`-1` for a batch without commands).
   */
  onSettled?: (outcome: SendOutcome, edit: number) => void;
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
   * has changed so far and not sent yet, content fields the content queue
   * has not saved, the existence of a node being edited.
   */
  alsoHeld?: (key: string) => boolean;
}

export interface PreparedRemote extends FieldLevelResult {
  /** The update confirms a batch this page sent. */
  own: boolean;
  /** Record what was withheld and release this page's confirmed holds. */
  finish: () => void;
}

export interface BrowserSync {
  readonly queue: SendQueue;
  submit(input: SubmitInput): EnqueueResult;
  prepareRemote(input: PrepareRemoteInput): PreparedRemote;
  /**
   * A hold the queue does not own has ended for `nodeId` — its content was
   * saved or given up, its editing is over. The server values kept back for
   * the units `owns` names that nothing holds any more (`held` is the
   * owner's own predicate) are shown, except the ones `superseded` says
   * this page's change replaced on the server.
   */
  localHoldsEnded(
    canvasId: string,
    nodeId: string,
    hold: {
      owns: (unit: string) => boolean;
      held: (key: string) => boolean;
      superseded?: (unit: string) => boolean;
    },
  ): void;
  /** Run `reload` now, or as soon as the queue has nothing left to send. */
  deferReload(canvasId: string): void;
  /** The page adopted a whole-Space server state: forget every hold. */
  adoptedServerState(canvasId: string): void;
  /** Drop unsent changes; a wanted reload then runs. */
  discard(canvasId: string): void;
  /** Forget all queue and hold state without side effects. For test isolation. */
  reset(): void;
}

export function createBrowserSync(deps: BrowserSyncDeps): BrowserSync {
  const inFlight = new InFlightSet();
  const echoTimeoutMs = deps.echoTimeoutMs ?? ECHO_TIMEOUT_MS;
  /** Confirmed entries whose update this page has not applied yet. */
  const awaitingEcho = new Map<
    string,
    { canvasId: string; timer: ReturnType<typeof setTimeout> }
  >();
  const reloadWanted = new Set<string>();
  /** Spaces whose reload is running. */
  const reloading = new Set<string>();
  /** Failed loads in a row per Space, and the wait before the next attempt. */
  const reloadRetries = new Map<
    string,
    { failures: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  const settleHooks = new Map<
    string,
    Array<{ edit: number; run: NonNullable<SubmitInput['onSettled']> }>
  >();

  /** A queued batch whose holds this page still has. */
  interface Batch extends QueuedEditRef {
    /** Nodes the batch placed: named for it, or changed here by it. */
    readonly placed: ReadonlySet<string>;
    /** Nodes whose parent the batch's commands depend on. */
    readonly moved: ReadonlySet<string>;
    readonly derived: boolean;
    /** The batch stated a read version, so a later one can name it. */
    readonly stated: boolean;
  }
  /** In submit order; dropped when their entry's holds are. */
  let batches: Batch[] = [];
  /**
   * Entry id → its batches, until the entry is answered. Kept apart from
   * `batches` because the update for an entry can release its holds before
   * its response arrives.
   */
  const unanswered = new Map<string, QueuedEditRef[]>();
  /** Discarded entries are not followed by a load: put their holds back. */
  let releaseDiscarded = false;
  /** `entryId:edit` → whether the batch took effect on the server. */
  const outcomes = new Map<string, 'applied' | 'refused'>();
  const MAX_REMEMBERED_OUTCOMES = 5_000;
  /**
   * Node id → the version this page had applied before the first update
   * whose placement of that node it kept back. Present only while kept back.
   */
  const keptBackSince = new Map<string, number>();
  /** Lineages the server did not know although this page had loaded them. */
  const refusedLineages = new Set<string>();

  const outcomeKey = (ref: QueuedEditRef): string =>
    `${ref.entryId}:${ref.edit}`;

  const noteOutcome = (ref: QueuedEditRef, applied: boolean): void => {
    outcomes.set(outcomeKey(ref), applied ? 'applied' : 'refused');
    if (outcomes.size > MAX_REMEMBERED_OUTCOMES)
      outcomes.delete(outcomes.keys().next().value as string);
  };

  /** Forget what was kept back for nodes this page no longer holds. */
  const sweepKeptBack = (): void => {
    if (keptBackSince.size === 0) return;
    const gesture = deps.gestureHeld?.() ?? null;
    for (const nodeId of [...keptBackSince.keys()]) {
      const held = PLACEMENT_UNITS.some((unit) => {
        const key = nodeUnitKey(nodeId, unit);
        return inFlight.isHeld(key) || gesture?.(key) === true;
      });
      if (!held) keptBackSince.delete(nodeId);
    }
  };

  const placedBy = (keys: HeldKeys): Set<string> => {
    const placed = new Set<string>();
    for (const key of keys.keys()) {
      const parsed = parseKey(key);
      if (
        parsed?.kind === 'node' &&
        (parsed.unit === EXISTENCE_UNIT ||
          PLACEMENT_UNITS.includes(parsed.unit))
      )
        placed.add(parsed.nodeId);
    }
    return placed;
  };

  const movedBy = (commands: readonly CanvasCommand[]): Set<string> => {
    const moved = new Set<string>();
    for (const command of commands)
      for (const id of commandReadTargets(command).membership) moved.add(id);
    return moved;
  };

  /**
   * The unconfirmed batches a new batch naming `moved` was made on top of:
   * per node, the latest ones that placed it, back to the first that itself
   * depended on the node's parent (which named the ones before it).
   */
  const madeOnTopOf = (moved: ReadonlySet<string>): QueuedEditRef[] => {
    const refs = new Set<Batch>();
    for (const nodeId of moved) {
      for (let index = batches.length - 1; index >= 0; index--) {
        const batch = batches[index] as Batch;
        if (batch.derived || !batch.stated || !batch.placed.has(nodeId))
          continue;
        if (outcomes.get(outcomeKey(batch)) !== 'applied') refs.add(batch);
        if (batch.moved.has(nodeId)) break;
      }
    }
    return batches
      .filter((batch) => refs.has(batch))
      .map(({ entryId, edit }) => ({ entryId, edit }));
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
    batches = batches.filter((batch) => batch.entryId !== entryId);
    if (freed.length > 0) deps.applyWithheld(canvasId, freed);
    sweepKeptBack();
  };

  const forgetReloadRetry = (canvasId: string): void => {
    const retry = reloadRetries.get(canvasId);
    if (retry?.timer) clearTimeout(retry.timer);
    reloadRetries.delete(canvasId);
  };

  const runReloadIfIdle = (canvasId: string): void => {
    if (
      !reloadWanted.has(canvasId) ||
      queue.hasPending(canvasId) ||
      reloading.has(canvasId) ||
      reloadRetries.get(canvasId)?.timer
    )
      return;
    reloadWanted.delete(canvasId);
    reloading.add(canvasId);
    let started: ReloadOutcome | Promise<ReloadOutcome>;
    try {
      started = deps.reload(canvasId);
    } catch {
      started = 'failed';
    }
    const settle = (outcome: ReloadOutcome): void => {
      // `reset` or a manual load ended this attempt's bookkeeping.
      if (!reloading.delete(canvasId)) return;
      if (outcome === 'failed') {
        // Nothing else asks again: after a refused command the version is
        // in step, so no later event would notice the page is behind.
        reloadWanted.add(canvasId);
        const retry = reloadRetries.get(canvasId) ?? {
          failures: 0,
          timer: null,
        };
        const wait = Math.min(
          RELOAD_RETRY.initialMs * 2 ** retry.failures,
          RELOAD_RETRY.maxMs,
        );
        retry.failures += 1;
        retry.timer = setTimeout(() => {
          retry.timer = null;
          runReloadIfIdle(canvasId);
        }, wait);
        reloadRetries.set(canvasId, retry);
        return;
      }
      forgetReloadRetry(canvasId);
      if (outcome === 'again') reloadWanted.add(canvasId);
      // Also a reload that became wanted while this one was running.
      if (outcome !== 'held') runReloadIfIdle(canvasId);
    };
    if (typeof started === 'string') settle(started);
    else
      void started.then(settle, () => {
        settle('failed');
      });
  };

  const onSettled = (entry: SendQueueEntry, outcome: SendOutcome): void => {
    try {
      settleEntry(entry, outcome);
    } finally {
      const hooks = settleHooks.get(entry.id);
      settleHooks.delete(entry.id);
      for (const hook of hooks ?? []) hook.run(outcome, hook.edit);
    }
  };

  const settleEntry = (entry: SendQueueEntry, outcome: SendOutcome): void => {
    const { canvasId } = entry;
    const answered = unanswered.get(entry.id) ?? [];
    unanswered.delete(entry.id);
    if (outcome.kind === 'discarded') {
      // The discard is followed by a reload, which clears the holds —
      // except where the caller says it is not.
      if (releaseDiscarded) release(canvasId, entry.id, new Set());
      return;
    }
    if (outcome.kind === 'failed') {
      for (const batch of answered) noteOutcome(batch, false);
      release(canvasId, entry.id, new Set());
      if (
        outcome.sent &&
        outcome.error instanceof ApiError &&
        outcome.error.code === 'basis-unknown'
      ) {
        // The server no longer has the history this page's read versions
        // name, so nothing queued can be checked against it: drop the rest
        // and load the Space, which brings the new lineage. A lineage the
        // page had just loaded is not loaded for again — the notice is all.
        const lineage = deps.getState().lineage ?? null;
        const again = lineage !== null && refusedLineages.has(lineage);
        if (lineage !== null) refusedLineages.add(lineage);
        deps.onRejected({ canvasId, entry, outcome });
        if (!again) reloadWanted.add(canvasId);
        releaseDiscarded = again;
        try {
          queue.discard(canvasId);
        } finally {
          releaseDiscarded = false;
        }
        return;
      }
      // A derived report the queue gave up is nothing the user did.
      if (outcome.sent || !entry.derived)
        deps.onRejected({ canvasId, entry, outcome });
      // A request that was never sent changed nothing on the server; the
      // released holds already put this page back.
      if (outcome.sent) reloadWanted.add(canvasId);
      return;
    }

    const { response } = outcome;
    // An edit is taken whole or not at all, and the response says which.
    const refused = response.edits.some((edit) => !edit.applied);
    for (const batch of answered) {
      noteOutcome(batch, response.edits[batch.edit]?.applied === true);
    }
    const state = deps.getState();
    if (response.toVersion === response.fromVersion) {
      // Nothing was written, so no update will arrive: what other pages
      // wrote to the held units meanwhile is the server's value.
      release(canvasId, entry.id, new Set());
    } else if (state.canvasId === canvasId) {
      // A replayed response has no deltas: what the request changed comes
      // with the update on the stream, like for any response that is not
      // the next contiguous version.
      if (
        state.version === response.fromVersion &&
        response.deltas !== undefined
      ) {
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
  };

  const queue = createSendQueue({
    send: deps.send,
    clientId: deps.clientId,
    ...(deps.retry ? { retry: deps.retry } : {}),
    editOutcome: (ref) => outcomes.get(outcomeKey(ref)),
    onSettled,
  });

  queue.subscribe((status: SendQueueStatus) => {
    if (status.phase === 'idle') runReloadIfIdle(status.canvasId);
  });

  return {
    queue,

    submit(input) {
      const state = deps.getState();
      const lineage =
        state.canvasId === input.canvasId ? (state.lineage ?? null) : null;
      const moved = movedBy(input.commands);
      let version = state.version;
      for (const nodeId of moved) {
        const since = keptBackSince.get(nodeId);
        if (since !== undefined && since < version) version = since;
      }
      const result = queue.enqueue(input.canvasId, input.commands, {
        ...(input.gate ? { gate: input.gate } : {}),
        ...(input.derived ? { derived: true } : {}),
        ...(lineage !== null
          ? {
              basis: encodeBasis(lineage, version),
              after: madeOnTopOf(moved),
            }
          : {}),
      });
      const keys = deriveHeldKeys(input.prev, input.next, deps.ignoreUnit);
      if (input.derived) for (const key of keys.keys()) keys.set(key, null);
      inFlight.hold(result.entry.id, keys);
      if (result.edit >= 0) {
        const ref = { entryId: result.entry.id, edit: result.edit };
        unanswered.set(ref.entryId, [
          ...(unanswered.get(ref.entryId) ?? []),
          ref,
        ]);
        batches.push({
          ...ref,
          // What it changed here, and what it set out to place: a move the
          // engine answered by shifting the Frame instead still placed it.
          placed: new Set([...placedBy(keys), ...moved]),
          moved,
          derived: input.derived === true,
          stated: lineage !== null,
        });
      }
      if (input.onSettled) {
        const hooks = settleHooks.get(result.entry.id) ?? [];
        hooks.push({ edit: result.edit, run: input.onSettled });
        settleHooks.set(result.entry.id, hooks);
      }
      return result;
    },

    prepareRemote(input) {
      const { operationId } = input;
      const own = operationId !== undefined && queue.isOwn(operationId);
      const except = own ? operationId : undefined;
      const versionBefore = deps.getState().version;
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
        finish: () => {
          for (const unit of result.withheld) {
            inFlight.withhold(unit);
            // Another writer's placement of a node this page holds: from
            // here on the page does not show what the server has for it.
            if (
              !own &&
              PLACEMENT_UNITS.includes(unit.unit) &&
              !keptBackSince.has(unit.nodeId)
            )
              keptBackSince.set(unit.nodeId, versionBefore);
          }
          // A node the update (re)creates is no longer deleted elsewhere.
          for (const nodeId of result.insertedNodeIds)
            inFlight.forgetWithheld(nodeUnitKey(nodeId, EXISTENCE_UNIT));
          if (own && operationId !== undefined)
            release(deps.getState().canvasId, operationId, result.covered);
        },
      };
    },

    localHoldsEnded(canvasId, nodeId, hold) {
      const freed = inFlight
        .takeWithheld(
          nodeId,
          (key, unit) => hold.owns(unit.unit) && !hold.held(key),
        )
        .filter((unit) => hold.superseded?.(unit.unit) !== true);
      if (freed.length > 0) deps.applyWithheld(canvasId, freed);
    },

    deferReload(canvasId) {
      reloadWanted.add(canvasId);
      runReloadIfIdle(canvasId);
    },

    adoptedServerState(canvasId) {
      inFlight.clear();
      batches = [];
      keptBackSince.clear();
      for (const [entryId, pending] of awaitingEcho) {
        if (pending.canvasId !== canvasId) continue;
        clearTimeout(pending.timer);
        awaitingEcho.delete(entryId);
      }
      reloadWanted.delete(canvasId);
      forgetReloadRetry(canvasId);
    },

    discard(canvasId) {
      queue.discard(canvasId);
    },

    reset() {
      queue.reset();
      inFlight.clear();
      batches = [];
      unanswered.clear();
      outcomes.clear();
      keptBackSince.clear();
      refusedLineages.clear();
      for (const pending of awaitingEcho.values()) clearTimeout(pending.timer);
      awaitingEcho.clear();
      reloadWanted.clear();
      reloading.clear();
      for (const canvasId of [...reloadRetries.keys()])
        forgetReloadRetry(canvasId);
      settleHooks.clear();
    },
  };
}
