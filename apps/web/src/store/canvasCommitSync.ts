// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasCommitEvent, MutationAck } from '@huabu/shared';

const DEFAULT_SEEN_COMMIT_CAPACITY = 128;

/**
 * The small part of canvas state needed to order commit notifications.
 * Structure generations are local-only: equality means the server-backed
 * structure has no unsaved or in-flight local successor.
 */
export type CanvasCommitCursor = {
  version: number;
  structureRevision: string | null;
  structureDirtyGeneration: number;
  structureSyncedGeneration: number;
};

export type CanvasCommitInput<TContext = unknown> =
  | {
      kind: 'event';
      commit: CanvasCommitEvent;
      localTabId: string;
      /** Caller-owned data retained while an out-of-order event is buffered. */
      context?: TContext;
    }
  | {
      kind: 'ack';
      ack: MutationAck;
      /** Caller-owned data retained while an out-of-order ack is buffered. */
      context?: TContext;
    };

export type AcceptedCanvasCommit<TContext = unknown> = {
  input: CanvasCommitInput<TContext>;
  cursor: CanvasCommitCursor;
  apply: 'none' | 'nodes' | 'structure';
  /** The event was our optimistic echo, so its payload must not replay. */
  ownOptimisticEcho: boolean;
  /** A remote structure advanced, but the local unsaved view won visually. */
  preservedLocalStructure: boolean;
};

export type CanvasCommitDecision<TContext = unknown> =
  | { kind: 'duplicate' | 'stale' | 'invalid'; cursor: CanvasCommitCursor }
  | {
      kind: 'gap';
      cursor: CanvasCommitCursor;
      localStructureDirty: boolean;
      /** Buffered ordering capacity was exceeded; snapshot reload is required. */
      requiresReload?: true;
    }
  | {
      kind: 'accepted';
      cursor: CanvasCommitCursor;
      apply: 'none' | 'nodes' | 'structure';
      /** The event was our optimistic echo, so its payload must not replay. */
      ownOptimisticEcho: boolean;
      /** A remote structure advanced, but the local unsaved view won visually. */
      preservedLocalStructure: boolean;
      /**
       * The accepted input followed by every now-adjacent buffered input.
       * `cursor` is the final cursor after this ordered sequence.
       */
      accepted: readonly AcceptedCanvasCommit<TContext>[];
    };

type CommitMetadata = Pick<
  MutationAck,
  | 'commitId'
  | 'fromVersion'
  | 'toVersion'
  | 'structureRevision'
  | 'recordChanged'
>;

/** True when applying the event can change the slim canvas topology/title. */
export function isStructuralCanvasCommit(event: CanvasCommitEvent): boolean {
  return (
    event.structureDeltas.length > 0 ||
    event.nodeChanges.some((change) => change.kind === 'delete') ||
    event.title !== undefined ||
    event.nodeOrder !== undefined ||
    event.edgeOrder !== undefined
  );
}

function metadataOf(input: CanvasCommitInput): CommitMetadata {
  return input.kind === 'event' ? input.commit : input.ack;
}

/**
 * Version gate shared by HTTP acknowledgements and realtime commit events.
 * It deliberately has no canvas-store dependency, making ordering behavior
 * deterministic and directly testable.
 */
export function createCanvasCommitGate<TContext = unknown>(
  capacity = DEFAULT_SEEN_COMMIT_CAPACITY,
): {
  consume(
    input: CanvasCommitInput<TContext>,
    cursor: CanvasCommitCursor,
  ): CanvasCommitDecision<TContext>;
  clear(): void;
} {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('Commit dedupe capacity must be a positive integer');
  }

  const seen = new Map<string, true>();
  const buffered = new Map<string, CanvasCommitInput<TContext>>();

  const wasSeen = (commitId: string): boolean => {
    if (seen.has(commitId)) {
      // Refresh recency so a repeated SSE/HTTP pair remains resident while
      // genuinely newer commits age out first.
      seen.delete(commitId);
      seen.set(commitId, true);
      return true;
    }
    return false;
  };

  const remember = (commitId: string): void => {
    seen.set(commitId, true);
    if (seen.size > capacity) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  };

  const buffer = (input: CanvasCommitInput<TContext>): boolean => {
    const commitId = metadataOf(input).commitId;
    const previous = buffered.get(commitId);
    // A full event is strictly more useful than a legacy ack because it can
    // replay the node/structure projection after the missing predecessor.
    if (!previous || (previous.kind === 'ack' && input.kind === 'event')) {
      buffered.set(commitId, input);
    }
    if (buffered.size > capacity) {
      const oldest = buffered.keys().next().value;
      if (oldest !== undefined) buffered.delete(oldest);
      return true;
    }
    return false;
  };

  const consumeOne = (
    input: CanvasCommitInput<TContext>,
    cursor: CanvasCommitCursor,
  ): CanvasCommitDecision<TContext> => {
    const metadata = metadataOf(input);
    const expectedToVersion = metadata.recordChanged
      ? metadata.fromVersion + 1
      : metadata.fromVersion;
    if (metadata.toVersion !== expectedToVersion) {
      return { kind: 'invalid', cursor };
    }
    if (wasSeen(metadata.commitId)) {
      return { kind: 'duplicate', cursor };
    }

    // A delayed HTTP response or SSE frame can acknowledge an already
    // superseded version, but it must never move either cursor backwards.
    if (metadata.toVersion < cursor.version) {
      remember(metadata.commitId);
      return { kind: 'stale', cursor };
    }

    const localStructureDirty =
      cursor.structureDirtyGeneration !== cursor.structureSyncedGeneration;

    if (!metadata.recordChanged) {
      if (metadata.fromVersion !== cursor.version) {
        if (metadata.fromVersion < cursor.version) {
          remember(metadata.commitId);
          return { kind: 'stale', cursor };
        }
        return { kind: 'gap', cursor, localStructureDirty };
      }
      remember(metadata.commitId);
      const accepted: AcceptedCanvasCommit<TContext> = {
        input,
        cursor: {
          ...cursor,
          structureRevision: metadata.structureRevision,
        },
        apply: 'none',
        ownOptimisticEcho: false,
        preservedLocalStructure: false,
      };
      return {
        kind: 'accepted',
        ...accepted,
        accepted: [accepted],
      };
    }

    if (metadata.fromVersion !== cursor.version) {
      if (metadata.toVersion === cursor.version) {
        remember(metadata.commitId);
        return { kind: 'stale', cursor };
      }
      return { kind: 'gap', cursor, localStructureDirty };
    }

    const ownOptimisticEcho =
      input.kind === 'event' &&
      input.commit.optimistic &&
      input.commit.originator.tabId !== undefined &&
      input.commit.originator.tabId === input.localTabId;
    const structural =
      input.kind === 'event' && isStructuralCanvasCommit(input.commit);
    const preservedLocalStructure =
      structural && localStructureDirty && !ownOptimisticEcho;

    remember(metadata.commitId);

    const accepted: AcceptedCanvasCommit<TContext> = {
      input,
      cursor: {
        ...cursor,
        version: metadata.toVersion,
        // A conflicting remote structural view must not become the CAS
        // baseline for our unsaved local topology. Its next PUT carries
        // the old revision and lets the server arbitrate the conflict.
        structureRevision: preservedLocalStructure
          ? cursor.structureRevision
          : metadata.structureRevision,
      },
      apply:
        input.kind === 'ack' || ownOptimisticEcho
          ? 'none'
          : structural
            ? preservedLocalStructure
              ? 'none'
              : 'structure'
            : 'nodes',
      ownOptimisticEcho,
      preservedLocalStructure,
    };
    return {
      kind: 'accepted',
      ...accepted,
      accepted: [accepted],
    };
  };

  return {
    consume(input, cursor) {
      const bufferedInput = buffered.get(metadataOf(input).commitId);
      if (bufferedInput) buffered.delete(metadataOf(input).commitId);
      const effectiveInput =
        bufferedInput?.kind === 'event' && input.kind === 'ack'
          ? bufferedInput
          : input.kind === 'event' && bufferedInput?.kind === 'ack'
            ? input
            : (bufferedInput ?? input);
      const first = consumeOne(effectiveInput, cursor);
      if (first.kind === 'gap') {
        return buffer(effectiveInput)
          ? { ...first, requiresReload: true }
          : first;
      }
      if (first.kind !== 'accepted') return first;

      const accepted = [...first.accepted];
      let nextCursor = first.cursor;
      let drained = true;
      while (drained) {
        drained = false;
        for (const [commitId, candidate] of buffered) {
          const metadata = metadataOf(candidate);
          if (metadata.fromVersion < nextCursor.version) {
            buffered.delete(commitId);
            consumeOne(candidate, nextCursor);
            drained = true;
            break;
          }
          if (metadata.fromVersion !== nextCursor.version) continue;
          buffered.delete(commitId);
          const result = consumeOne(candidate, nextCursor);
          if (result.kind === 'accepted') {
            accepted.push(...result.accepted);
            nextCursor = result.cursor;
          } else if (result.kind === 'gap') {
            buffer(candidate);
          }
          drained = true;
          break;
        }
      }

      return { ...first, cursor: nextCursor, accepted };
    },

    clear() {
      seen.clear();
      buffered.clear();
    },
  };
}

let fallbackTabSequence = 0;

/** One opaque id for this browser tab/process, attached to every UI write. */
export const canvasSyncTabId =
  globalThis.crypto?.randomUUID?.() ??
  `tab-${Date.now().toString(36)}-${(++fallbackTabSequence).toString(36)}`;
