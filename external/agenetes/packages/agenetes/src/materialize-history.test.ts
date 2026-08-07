import { describe, expect, it } from 'vitest';

import { materializeHistory } from './materialize-history.js';

import type { EventLogRecord } from './event-log.js';
import type { PersistedTurn } from './turn-store.js';

const completed: PersistedTurn = {
  turn: {
    request: { type: 'user_text', content: 'complete request' },
    transcript: [{ type: 'text', data: { content: 'complete response' } }],
  },
  seqStart: 1,
  seqEnd: 3,
};

describe('materializeHistory', () => {
  it('appends an incomplete turn from a turn start and event prefix', () => {
    const tail: EventLogRecord[] = [
      {
        seq: 4,
        ts: 1,
        kind: 'turn_start',
        request: { type: 'user_text', content: 'current request' },
      },
      {
        seq: 5,
        ts: 2,
        event: { type: 'text_delta', data: { content: 'partial' } },
      },
      {
        seq: 6,
        ts: 3,
        event: {
          type: 'done',
          data: {
            message: 'partial',
            meta: { stopReason: 'end_turn' },
          },
        },
      },
    ];

    expect(materializeHistory([completed], tail)).toEqual([
      completed.turn,
      {
        request: { type: 'user_text', content: 'current request' },
        transcript: [{ type: 'text', data: { content: 'partial' } }],
        meta: { stopReason: 'end_turn' },
        isIncomplete: true,
      },
    ]);
  });

  it('projects a request-only turn before the first event arrives', () => {
    expect(
      materializeHistory(
        [],
        [
          {
            seq: 1,
            ts: 1,
            kind: 'turn_start',
            request: { type: 'user_text', content: 'waiting' },
          },
        ],
      ),
    ).toEqual([
      {
        request: { type: 'user_text', content: 'waiting' },
        transcript: [],
        isIncomplete: true,
      },
    ]);
  });

  it('tolerates a legacy event-only tail with a null request', () => {
    expect(
      materializeHistory(
        [],
        [
          {
            seq: 1,
            ts: 1,
            event: { type: 'text_delta', data: { content: 'legacy' } },
          },
        ],
      ),
    ).toEqual([
      {
        request: null,
        transcript: [{ type: 'text', data: { content: 'legacy' } }],
        isIncomplete: true,
      },
    ]);
  });
});
