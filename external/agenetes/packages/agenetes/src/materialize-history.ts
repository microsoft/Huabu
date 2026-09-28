import { AGENT_STREAM_EVENTS } from '@agenetes/protocol';

import { createTranscriptFolder } from './fold.js';

import type { EventLogRecord } from './event-log.js';
import type { PersistedTurn } from './turn-store.js';
import type { AgentTurnMeta, ObservedAgentTurn } from '@agenetes/protocol';

/** The lowest Tier-1 seq no folded turn accounts for, given their ranges. */
export function firstUncoveredSeq(
  persistedTurns: readonly PersistedTurn[],
): number {
  let expected = 1;
  for (const { seqStart, seqEnd } of persistedTurns) {
    if (seqStart > expected) return expected;
    expected = Math.max(expected, seqEnd + 1);
  }
  return expected;
}

/**
 * Build the read-time history snapshot from committed Tier-2 turns and every
 * Tier-1 record no turn covers. The inputs are already snapshots; this
 * function never reads or writes either store.
 *
 * A turn commits its Tier-2 record only when its generator returns, so a
 * process that dies mid-turn leaves Tier-1 records with no folded turn. Those
 * records are not debris — replaying them is how a recovered conversation
 * still contains the turn whose tool call already changed the Space.
 *
 * Which is why coverage is computed per turn rather than from a high-water
 * mark. Taking "everything after the last folded turn" reads the same in the
 * ordinary case and quietly loses an interrupted turn as soon as a later one
 * folds past it: the Note stays on the canvas and the exchange that created
 * it vanishes from the thread.
 */
export function materializeHistory(
  persistedTurns: readonly PersistedTurn[],
  tailRecords: readonly EventLogRecord[],
): ObservedAgentTurn[] {
  if (tailRecords.length === 0) return persistedTurns.map(({ turn }) => turn);

  // An early interrupted turn makes the tail include later committed turns.
  // Merge their coverage once, then walk the seq-ordered records and ranges
  // together instead of searching every persisted turn for every record.
  const ranges: Array<{ seqStart: number; seqEnd: number }> = [];
  const sorted = persistedTurns
    .map(({ seqStart, seqEnd }) => ({ seqStart, seqEnd }))
    .filter(({ seqStart, seqEnd }) => seqStart <= seqEnd)
    .sort((a, b) => a.seqStart - b.seqStart);
  for (const range of sorted) {
    const last = ranges.at(-1);
    if (last && range.seqStart <= last.seqEnd + 1) {
      last.seqEnd = Math.max(last.seqEnd, range.seqEnd);
    } else {
      ranges.push(range);
    }
  }
  let rangeIndex = 0;
  const uncovered = tailRecords.filter(({ seq }) => {
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.seqEnd < seq) {
      rangeIndex += 1;
    }
    const range = ranges[rangeIndex];
    return range === undefined || seq < range.seqStart;
  });
  if (uncovered.length === 0) return persistedTurns.map(({ turn }) => turn);

  // One run per uncommitted turn: a `turn_start` opens a run, and records
  // before the first one belong to a turn whose boundary is already covered
  // or was never written.
  const runs: Array<{
    seq: number;
    start: EventLogRecord | undefined;
    records: EventLogRecord[];
  }> = [];
  for (const record of uncovered) {
    const isBoundary = 'kind' in record && record.kind === 'turn_start';
    if (isBoundary || runs.length === 0) {
      runs.push({
        seq: record.seq,
        start: isBoundary ? record : undefined,
        records: isBoundary ? [] : [record],
      });
      continue;
    }
    runs[runs.length - 1]!.records.push(record);
  }

  const materialized = runs.map((run) => {
    const folder = createTranscriptFolder();
    let meta: AgentTurnMeta | undefined;
    for (const record of run.records) {
      if (!('event' in record)) continue;
      folder.fold(record.event);
      if (record.event.type === AGENT_STREAM_EVENTS.Done) {
        meta = record.event.data.meta;
      }
    }
    return {
      seq: run.seq,
      turn: {
        request:
          run.start && 'kind' in run.start && run.start.kind === 'turn_start'
            ? run.start.request
            : null,
        transcript: folder.result(),
        ...(meta ? { meta } : {}),
        isIncomplete: true,
      } satisfies ObservedAgentTurn,
    };
  });

  // Ordered by where each one sits in Tier 1, so a recovered turn reads in
  // the place it happened rather than appended after everything.
  return [
    ...persistedTurns.map(({ turn, seqStart }) => ({ seq: seqStart, turn })),
    ...materialized,
  ]
    .sort((a, b) => a.seq - b.seq)
    .map(({ turn }) => turn);
}
