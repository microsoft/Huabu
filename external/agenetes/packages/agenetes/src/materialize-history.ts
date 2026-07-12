import { AGENT_STREAM_EVENTS } from '@agenetes/protocol';

import { createTranscriptFolder } from './fold.js';

import type { EventLogRecord } from './event-log.js';
import type { PersistedTurn } from './turn-store.js';
import type { AgentTurnMeta, ObservedAgentTurn } from '@agenetes/protocol';

/**
 * Build the read-time history snapshot from committed Tier-2 turns and the
 * uncovered Tier-1 suffix. The inputs are already snapshots; this function
 * never reads or writes either store.
 */
export function materializeHistory(
  persistedTurns: readonly PersistedTurn[],
  tailRecords: readonly EventLogRecord[],
): ObservedAgentTurn[] {
  const turns: ObservedAgentTurn[] = persistedTurns.map(({ turn }) => turn);
  if (tailRecords.length === 0) return turns;

  let startIndex = -1;
  for (let index = tailRecords.length - 1; index >= 0; index -= 1) {
    const record = tailRecords[index]!;
    if ('kind' in record && record.kind === 'turn_start') {
      startIndex = index;
      break;
    }
  }
  const start = startIndex >= 0 ? tailRecords[startIndex] : undefined;
  const records =
    startIndex >= 0 ? tailRecords.slice(startIndex + 1) : tailRecords;
  const folder = createTranscriptFolder();
  let meta: AgentTurnMeta | undefined;

  for (const record of records) {
    if (!('event' in record)) continue;
    folder.fold(record.event);
    if (record.event.type === AGENT_STREAM_EVENTS.Done) {
      meta = record.event.data.meta;
    }
  }

  turns.push({
    request:
      start && 'kind' in start && start.kind === 'turn_start'
        ? start.request
        : null,
    transcript: folder.result(),
    ...(meta ? { meta } : {}),
    isIncomplete: true,
  });
  return turns;
}
