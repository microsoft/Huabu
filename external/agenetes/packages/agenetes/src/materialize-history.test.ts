import { describe, expect, it } from 'vitest';

import {
  firstUncoveredSeq,
  materializeHistory,
} from './materialize-history.js';

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

  // A turn that died before committing is Tier-1 records with no folded turn.
  // Read as "everything after the last folded turn" it survives exactly one
  // recovery and then vanishes the moment a later turn folds past it — while
  // whatever its tool call did to the Space stays. Coverage is per turn so
  // that cannot happen, and the recovered turn reads where it happened.
  it('keeps an interrupted turn once a later turn has folded over it', () => {
    const later: PersistedTurn = {
      turn: {
        request: { type: 'user_text', content: 'second request' },
        transcript: [{ type: 'text', data: { content: 'second response' } }],
      },
      seqStart: 3,
      seqEnd: 4,
    };
    const orphaned: EventLogRecord[] = [
      {
        seq: 1,
        ts: 1,
        kind: 'turn_start',
        request: { type: 'user_text', content: 'interrupted' },
      },
      {
        seq: 2,
        ts: 2,
        event: { type: 'text_delta', data: { content: 'partial' } },
      },
    ];

    expect(firstUncoveredSeq([later])).toBe(1);
    expect(materializeHistory([later], orphaned)).toEqual([
      {
        request: { type: 'user_text', content: 'interrupted' },
        transcript: [{ type: 'text', data: { content: 'partial' } }],
        isIncomplete: true,
      },
      later.turn,
    ]);
  });

  it('handles overlapping, nested, and empty ranges without covering gaps', () => {
    const persisted = [
      { ...completed, seqStart: 7, seqEnd: 8 },
      { ...completed, seqStart: 2, seqEnd: 5 },
      { ...completed, seqStart: 3, seqEnd: 3 },
      { ...completed, seqStart: 4, seqEnd: 5 },
      { ...completed, seqStart: 6, seqEnd: 5 },
    ];
    const original = [...persisted];
    const records: EventLogRecord[] = Array.from({ length: 9 }, (_, i) => ({
      seq: i + 1,
      ts: i + 1,
      kind: 'turn_start',
      request: { type: 'user_text', content: `request ${i + 1}` },
    }));

    const history = materializeHistory(persisted, records);

    expect(history.filter((turn) => turn.isIncomplete)).toEqual(
      [1, 6, 9].map((seq) => ({
        request: { type: 'user_text', content: `request ${seq}` },
        transcript: [],
        isIncomplete: true,
      })),
    );
    expect(history).toHaveLength(persisted.length + 3);
    expect(persisted).toEqual(original);
  });

  it('does not rescan every persisted range for each record after an early gap', () => {
    const count = 1_000;
    let rangeReads = 0;
    const persisted: PersistedTurn[] = Array.from(
      { length: count },
      (_, i) => ({
        turn: completed.turn,
        get seqStart() {
          rangeReads += 1;
          return i * 2 + 3;
        },
        get seqEnd() {
          rangeReads += 1;
          return i * 2 + 4;
        },
      }),
    );
    const records: EventLogRecord[] = Array.from(
      { length: count * 2 + 2 },
      (_, i) => ({
        seq: i + 1,
        ts: i + 1,
        event: { type: 'text_delta', data: { content: 'text' } },
      }),
    );

    const history = materializeHistory(persisted, records);

    expect(history).toHaveLength(count + 1);
    expect(history[0]).toEqual({
      request: null,
      transcript: [{ type: 'text', data: { content: 'texttext' } }],
      isIncomplete: true,
    });
    // Count range access rather than wall-clock time to catch quadratic work
    // without making the regression depend on machine speed.
    expect(rangeReads).toBeLessThan(count * 20);
  });

  it('reads only the suffix when every turn committed', () => {
    // The ordinary case must not start reading the whole log: with contiguous
    // ranges the first uncovered seq is simply the next one.
    expect(firstUncoveredSeq([])).toBe(1);
    expect(firstUncoveredSeq([completed])).toBe(4);
    expect(
      firstUncoveredSeq([completed, { ...completed, seqStart: 4, seqEnd: 9 }]),
    ).toBe(10);
  });

  it('ignores records a folded turn already accounts for', () => {
    expect(
      materializeHistory(
        [completed],
        [
          {
            seq: 2,
            ts: 2,
            event: { type: 'text_delta', data: { content: 'covered' } },
          },
          {
            seq: 5,
            ts: 5,
            event: { type: 'text_delta', data: { content: 'tail' } },
          },
        ],
      ),
    ).toEqual([
      completed.turn,
      {
        request: null,
        transcript: [{ type: 'text', data: { content: 'tail' } }],
        isIncomplete: true,
      },
    ]);
  });
});
