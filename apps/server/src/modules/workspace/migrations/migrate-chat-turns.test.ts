/**
 * Tests for the legacy chat-turn migration (M6.9 row 2).
 *
 *   ✓ folds each legacy `.history/chat/<tid>.turns.jsonl` line into the
 *     thread's `chat_v2/<tid>.turns.jsonl` Tier-2 log
 *   ✓ pins an empty Tier-1 range (seqStart 1 > seqEnd 0) on every turn
 *   ✓ renames the consumed source log to `.turns.jsonl.bak`
 *   ✓ idempotent — a second sweep neither re-writes nor throws
 *   ✓ tolerant — a canvas with no chat dir is skipped
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyChatTurns } from './migrate-chat-turns.js';
import { readJsonLines } from '../../../utils/fs.js';

import type { LegacyChatTurnRecord } from './legacy/chat-turn-record.js';
import type { PersistedTurn } from '@agenetes/agenetes';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-migrate-turns-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function legacyRecord(text: string): LegacyChatTurnRecord {
  return {
    envelope: {
      user: { text, attachments: [] },
      skills: { invokedIds: [], resolved: [] },
      focus: {
        selection: {
          refs: [],
          selectedIds: [],
          imageAttachments: [],
          snapshotAttachments: [],
        },
      },
    },
    transcript: [
      { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }] },
    ] as LegacyChatTurnRecord['transcript'],
  };
}

/** Seed `<canvas>/.history/chat/<tid>.turns.jsonl` with `records`. */
function seedLegacyLog(
  canvas: string,
  threadId: string,
  records: LegacyChatTurnRecord[],
): string {
  const chatDir = join(tmp, canvas, '.history', 'chat');
  mkdirSync(chatDir, { recursive: true });
  const p = join(chatDir, `${threadId}.turns.jsonl`);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

describe('migrateLegacyChatTurns', () => {
  it('folds legacy turns into chat_v2 and retires the source', () => {
    const src = seedLegacyLog('Canvas A', 'thread-1', [
      legacyRecord('one'),
      legacyRecord('two'),
    ]);

    migrateLegacyChatTurns(tmp);

    const target = join(
      tmp,
      'Canvas A',
      '.history',
      'chat_v2',
      'thread-1.turns.jsonl',
    );
    expect(existsSync(target)).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(`${src}.bak`)).toBe(true);

    const turns = readJsonLines<PersistedTurn>(target);
    expect(turns).toHaveLength(2);
    for (const t of turns) {
      // Empty Tier-1 range: a migrated turn folded no live events.
      expect(t.seqStart).toBe(1);
      expect(t.seqEnd).toBe(0);
      expect(t.turn.request).toMatchObject({ type: 'huabu.chat' });
    }
    expect(
      (turns[0].turn.transcript[0] as { data: { content: string } }).data
        .content,
    ).toBe('re: one');
  });

  it('is idempotent — a second sweep is a no-op', () => {
    seedLegacyLog('Canvas A', 'thread-1', [legacyRecord('one')]);
    migrateLegacyChatTurns(tmp);

    const target = join(
      tmp,
      'Canvas A',
      '.history',
      'chat_v2',
      'thread-1.turns.jsonl',
    );
    const before = readJsonLines<PersistedTurn>(target);

    // Re-run: no source log remains, target must be untouched.
    expect(() => migrateLegacyChatTurns(tmp)).not.toThrow();
    expect(readJsonLines<PersistedTurn>(target)).toHaveLength(before.length);
  });

  it('skips a canvas that has no legacy chat dir', () => {
    mkdirSync(join(tmp, 'Empty Canvas', '.history'), { recursive: true });
    expect(() => migrateLegacyChatTurns(tmp)).not.toThrow();
    expect(existsSync(join(tmp, 'Empty Canvas', '.history', 'chat_v2'))).toBe(
      false,
    );
  });
});
