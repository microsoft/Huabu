// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the one-shot legacy chat-thread migration.
 *
 *   ✓ legacyContextToTurns: opens a turn per real user message, in order
 *   ✓ seeds selection ids/refs from the [Selected Nodes] block + tag
 *   ✓ folds [SYSTEM Error/Interrupted] rows into the open turn transcript
 *   ✓ migrateLegacyThreadFile: writes .turns.jsonl, renames .json → .bak
 *   ✓ repairs supported legacy/new-format coexistence without data loss
 *   ✓ migrateLegacyChatThreads: sweeps canvases, ignores active sidecars
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  tmp = mkdtempSync(join(tmpdir(), 'huabu-migrate-chat-'));
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

  it('atomically completes a coexisting log that is a legacy prefix', () => {
    const jsonPath = join(tmp, 'tr.json');
    const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
    const legacyTurns = legacyContextToTurns(legacyContext());
    writeFileSync(jsonPath, JSON.stringify(legacyContext()));
    writeFileSync(turnsPath, `${JSON.stringify(legacyTurns[0])}\n`);

    expect(migrateLegacyThreadFile(jsonPath)).toBe(true);
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toEqual(legacyTurns);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(`${jsonPath}.bak`)).toBe(true);
  });

  it('preserves a newer tail when the legacy conversion is its prefix', () => {
    const jsonPath = join(tmp, 'tr.json');
    const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
    const legacyTurns = legacyContextToTurns(legacyContext());
    const newerTurn: ChatTurnRecord = {
      ...legacyTurns[1],
      envelope: {
        ...legacyTurns[1].envelope,
        user: { ...legacyTurns[1].envelope.user, text: 'new-format tail' },
      },
    };
    writeFileSync(jsonPath, JSON.stringify(legacyContext()));
    writeFileSync(
      turnsPath,
      [...legacyTurns, newerTurn]
        .map((turn) => JSON.stringify(turn))
        .join('\n') + '\n',
    );

    expect(migrateLegacyThreadFile(jsonPath)).toBe(true);
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toEqual([
      ...legacyTurns,
      newerTurn,
    ]);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(`${jsonPath}.bak`)).toBe(true);
  });

  it('preserves a divergent Context and leaves the live log as written', () => {
    const jsonPath = join(tmp, 'tr.json');
    const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
    const [first] = legacyContextToTurns(legacyContext());
    const divergent: ChatTurnRecord = {
      ...first,
      envelope: {
        ...first.envelope,
        user: { ...first.envelope.user, text: 'different first turn' },
      },
    };
    writeFileSync(jsonPath, JSON.stringify(legacyContext()));
    writeFileSync(turnsPath, `${JSON.stringify(divergent)}\n`);

    expect(migrateLegacyThreadFile(jsonPath)).toBe(true);
    // The live log is the one the app appends to, so it is untouched — and
    // hop 2 is now free to fold it.
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toEqual([divergent]);
    // The Context survives verbatim under a suffix that says why.
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(`${jsonPath}.bak`)).toBe(false);
    expect(existsSync(`${jsonPath}.unresolved`)).toBe(true);
    expect(
      JSON.parse(readFileSync(`${jsonPath}.unresolved`, 'utf8')) as unknown,
    ).toEqual(legacyContext());
  });

  it('converts a thread whose Context holds an unrecognised row', () => {
    const jsonPath = join(tmp, 'tr.json');
    const ctx = legacyContext();
    // A row from an older pi-ai version, plus outright junk. Neither may cost
    // the thread the turns around them.
    const widened = {
      ...ctx,
      messages: [
        { role: 'system', content: 'you are helpful' },
        ...ctx.messages,
        null,
      ],
    };
    writeFileSync(jsonPath, JSON.stringify(widened));

    expect(migrateLegacyThreadFile(jsonPath)).toBe(true);
    const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toEqual(
      legacyContextToTurns(ctx),
    );
    expect(existsSync(`${jsonPath}.bak`)).toBe(true);
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

  it('terminates divergent coexistence instead of deferring it', () => {
    const chat = join(tmp, 'cv-1', '.history', 'chat');
    const jsonPath = join(chat, 'tr.json');
    const turnsPath = join(chat, 'tr.turns.jsonl');
    const [first] = legacyContextToTurns(legacyContext());
    const divergent: ChatTurnRecord = {
      ...first,
      envelope: {
        ...first.envelope,
        user: { ...first.envelope.user, text: 'different first turn' },
      },
    };
    mkdirSync(chat, { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(legacyContext()));
    writeFileSync(turnsPath, `${JSON.stringify(divergent)}\n`);

    expect(() => migrateLegacyChatThreads(tmp)).not.toThrow();
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(`${jsonPath}.unresolved`)).toBe(true);
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toEqual([divergent]);

    // Idempotent: the preserved Context is not a `.json` thread, so a second
    // sweep neither re-reads nor re-reports it.
    expect(() => migrateLegacyChatThreads(tmp)).not.toThrow();
    expect(existsSync(`${jsonPath}.unresolved`)).toBe(true);
    expect(readJsonLines<ChatTurnRecord>(turnsPath)).toEqual([divergent]);
  });

  it('leaves an unreadable Context in place without losing the batch', () => {
    const chat = join(tmp, 'cv-1', '.history', 'chat');
    mkdirSync(chat, { recursive: true });
    writeFileSync(join(chat, 'broken.json'), '{"messages":[{"role":"user"');
    writeFileSync(join(chat, 'good.json'), JSON.stringify(legacyContext()));

    expect(() => migrateLegacyChatThreads(tmp)).not.toThrow();
    // The damaged thread stays put, the healthy one beside it still migrates.
    expect(existsSync(join(chat, 'broken.json'))).toBe(true);
    expect(existsSync(join(chat, 'good.json.bak'))).toBe(true);
    expect(
      readJsonLines<ChatTurnRecord>(join(chat, 'good.turns.jsonl')),
    ).toHaveLength(2);
  });
});
