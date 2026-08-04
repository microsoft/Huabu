/**
 * Tests for the one-shot legacy chat-thread migration.
 *
 *   ✓ legacyContextToTurns: opens a turn per real user message, in order
 *   ✓ seeds selection ids/refs from the [Selected Nodes] block + tag
 *   ✓ folds [SYSTEM Error/Interrupted] rows into the open turn transcript
 *   ✓ migrateLegacyThreadFile: writes .turns.jsonl, renames .json → .bak
 *   ✓ idempotent — skips when a .turns.jsonl already exists
 *   ✓ migrateLegacyChatThreads: sweeps canvases, ignores active sidecars
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

import {
  legacyContextToTurns,
  migrateLegacyChatThreads,
  migrateLegacyThreadFile,
} from './migrate-chat-threads.js';
import { readJsonLines } from '../../../utils/fs.js';

import type { LegacyChatTurnRecord as ChatTurnRecord } from './legacy/chat-turn-record.js';
import type { Context } from '@earendil-works/pi-ai';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-migrate-chat-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A legacy Context with two real turns; first carries a selection. */
function legacyContext(): Context {
  return {
    systemPrompt: 'sys',
    tools: [],
    messages: [
      {
        role: 'user',
        content:
          '[SYSTEM Context]\n[Selected Nodes]\n[\n{"id":"n-1","type":"note","label":"Risks"}\n]',
        timestamp: 1,
      },
      {
        role: 'user',
        content: 'summarize this\n[SYSTEM selectedNodeIds:["n-1"]]',
        timestamp: 2,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 3,
      },
      { role: 'user', content: 'and again', timestamp: 4 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 5,
      },
    ],
  } as unknown as Context;
}

describe('legacyContextToTurns', () => {
  it('opens one turn per real user message, in order, user text last', () => {
    const turns = legacyContextToTurns(legacyContext());
    expect(turns.map((t) => t.envelope.user.text)).toEqual([
      'summarize this',
      'and again',
    ]);
  });

  it('seeds selection ids/refs from the [Selected Nodes] block + tag', () => {
    const [first] = legacyContextToTurns(legacyContext());
    expect(first.envelope.focus.selection.selectedIds).toEqual(['n-1']);
    expect(first.envelope.focus.selection.refs[0].id).toBe('n-1');
    expect(first.envelope.focus.selection.refs[0].type).toBe('note');
  });

  it('attaches the assistant reply to the matching turn transcript', () => {
    const turns = legacyContextToTurns(legacyContext());
    expect(turns[0].transcript).toHaveLength(1);
    expect(turns[1].transcript).toHaveLength(1);
  });

  it('folds [SYSTEM Error/Interrupted] rows into the open turn', () => {
    const ctx = {
      systemPrompt: '',
      tools: [],
      messages: [
        { role: 'user', content: 'go', timestamp: 1 },
        { role: 'user', content: '[SYSTEM Error] boom', timestamp: 2 },
        { role: 'user', content: '[SYSTEM Interrupted]', timestamp: 3 },
      ],
    } as unknown as Context;
    const [turn] = legacyContextToTurns(ctx);
    expect(turn.transcript).toHaveLength(2);
  });
});

describe('migrateLegacyThreadFile', () => {
  it('writes .turns.jsonl and renames the legacy .json to .bak', () => {
    const jsonPath = join(tmp, 'tr.json');
    writeFileSync(jsonPath, JSON.stringify(legacyContext()));

    expect(migrateLegacyThreadFile(jsonPath)).toBe(true);
    const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
    expect(existsSync(turnsPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(`${jsonPath}.bak`)).toBe(true);
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toHaveLength(2);
  });

  it('is idempotent — skips when a .turns.jsonl already exists', () => {
    const jsonPath = join(tmp, 'tr.json');
    writeFileSync(jsonPath, JSON.stringify(legacyContext()));
    writeFileSync(jsonPath.replace(/\.json$/, '.turns.jsonl'), '');
    expect(migrateLegacyThreadFile(jsonPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(true); // untouched
  });
});

describe('migrateLegacyChatThreads', () => {
  it('sweeps every canvas chat dir but ignores active sidecars', () => {
    const chat = join(tmp, 'cv-1', '.history', 'chat');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, 'tr.json'), JSON.stringify(legacyContext()));
    writeFileSync(
      join(chat, 'tr.active.json'),
      JSON.stringify({ envelope: 1 }),
    );

    migrateLegacyChatThreads(tmp);

    expect(existsSync(join(chat, 'tr.turns.jsonl'))).toBe(true);
    expect(existsSync(join(chat, 'tr.json.bak'))).toBe(true);
    // The active sidecar is left untouched (not mistaken for a thread).
    expect(existsSync(join(chat, 'tr.active.json'))).toBe(true);
    expect(existsSync(join(chat, 'tr.active.json.bak'))).toBe(false);
  });
});
