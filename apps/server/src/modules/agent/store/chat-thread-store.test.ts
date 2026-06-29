/**
 * Tests for the structured chat thread store (JSONL, turn-granularity).
 *
 *   ✓ appends finalized turns and loads them back in order
 *   ✓ loadTurns returns [] when canvasId missing / no log
 *   ✓ skips malformed JSONL lines rather than throwing
 *   ✓ active turn is included by loadTurns and cleared on finalize
 *   ✓ finalizeActiveTurn promotes the active turn to the log
 *   ✓ preserves the ACP overlay (toolExtras / plan)
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
  appendTurn,
  clearActiveTurn,
  finalizeActiveTurn,
  loadTurns,
  readActiveTurn,
  writeActiveTurn,
  type ChatTurnRecord,
} from './chat-thread-store.js';
import { chatActiveTurnPath, chatTurnsPath } from '../../storage/paths.js';
import { setWorkspacePath } from '../../workspace.js';

import type { ChatEnvelope } from '../conversation/envelope.js';

let tmp: string;
const canvasId = 'cv-test';
const threadId = 'tr-test';

function sampleEnvelope(text = 'hello'): ChatEnvelope {
  return {
    preamble: {},
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
  };
}

function sampleTurn(text = 'hello'): ChatTurnRecord {
  return {
    envelope: sampleEnvelope(text),
    transcript: [{ role: 'user', content: `reply to ${text}`, timestamp: 1 }],
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-thread-store-'));
  setWorkspacePath(tmp);
  mkdirSync(join(tmp, canvasId), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('appendTurn / loadTurns', () => {
  it('appends finalized turns and loads them back in order', () => {
    appendTurn(threadId, sampleTurn('a'), canvasId);
    appendTurn(threadId, sampleTurn('b'), canvasId);
    const turns = loadTurns(threadId, canvasId);
    expect(turns.map((t) => t.envelope.user.text)).toEqual(['a', 'b']);
  });

  it('returns [] when canvasId is missing', () => {
    expect(loadTurns(threadId, undefined)).toEqual([]);
  });

  it('returns [] when no log exists', () => {
    expect(loadTurns('does-not-exist', canvasId)).toEqual([]);
  });

  it('skips malformed JSONL lines rather than throwing', () => {
    // Append once so the chat dir + log file exist, then overwrite with
    // a valid line followed by a corrupt one.
    appendTurn(threadId, sampleTurn('seed'), canvasId);
    writeFileSync(
      chatTurnsPath(canvasId, threadId),
      `${JSON.stringify(sampleTurn('a'))}\n{ not :: json\n`,
    );
    const turns = loadTurns(threadId, canvasId);
    expect(turns).toHaveLength(1);
  });

  it('preserves the ACP overlay (toolExtras / plan)', () => {
    const turn: ChatTurnRecord = {
      ...sampleTurn('acp'),
      toolExtras: { tc_1: { toolKind: 'read', status: 'completed' } },
      plan: [{ content: 'step', status: 'pending', priority: 'high' }],
    };
    appendTurn(threadId, turn, canvasId);
    const [loaded] = loadTurns(threadId, canvasId);
    expect(loaded.toolExtras).toEqual({
      tc_1: { toolKind: 'read', status: 'completed' },
    });
    expect(loaded.plan).toEqual([
      { content: 'step', status: 'pending', priority: 'high' },
    ]);
  });
});

describe('active turn', () => {
  it('is included by loadTurns and read back', () => {
    appendTurn(threadId, sampleTurn('a'), canvasId);
    writeActiveTurn(threadId, sampleTurn('open'), canvasId);
    const turns = loadTurns(threadId, canvasId);
    expect(turns.map((t) => t.envelope.user.text)).toEqual(['a', 'open']);
    expect(readActiveTurn(threadId, canvasId)?.envelope.user.text).toBe('open');
  });

  it('clearActiveTurn removes the sidecar', () => {
    writeActiveTurn(threadId, sampleTurn('open'), canvasId);
    expect(existsSync(chatActiveTurnPath(canvasId, threadId))).toBe(true);
    clearActiveTurn(threadId, canvasId);
    expect(existsSync(chatActiveTurnPath(canvasId, threadId))).toBe(false);
    expect(readActiveTurn(threadId, canvasId)).toBeNull();
  });

  it('finalizeActiveTurn promotes the active turn to the log', () => {
    appendTurn(threadId, sampleTurn('a'), canvasId);
    writeActiveTurn(threadId, sampleTurn('open'), canvasId);
    finalizeActiveTurn(threadId, canvasId);
    expect(existsSync(chatActiveTurnPath(canvasId, threadId))).toBe(false);
    const turns = loadTurns(threadId, canvasId);
    expect(turns.map((t) => t.envelope.user.text)).toEqual(['a', 'open']);
  });

  it('finalizeActiveTurn is a no-op when there is no active turn', () => {
    appendTurn(threadId, sampleTurn('a'), canvasId);
    finalizeActiveTurn(threadId, canvasId);
    expect(loadTurns(threadId, canvasId)).toHaveLength(1);
  });
});
