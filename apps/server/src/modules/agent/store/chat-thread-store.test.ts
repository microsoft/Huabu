/**
 * Tests for the structured chat thread store.
 *
 *   ✓ round-trips a thread record through disk
 *   ✓ returns null when canvasId is missing
 *   ✓ returns null when the file does not exist
 *   ✓ returns null (not throw) on corrupt JSON
 *   ✓ ignores a wrong / legacy version rather than mis-reading it
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHAT_THREAD_RECORD_VERSION,
  emptyThreadRecord,
  loadThreadRecord,
  saveThreadRecord,
  type ChatThreadRecord,
} from './chat-thread-store.js';
import { chatTurnsPath } from '../../storage/paths.js';
import { setWorkspacePath } from '../../workspace.js';

import type { ChatEnvelope } from '../context/envelope.js';

let tmp: string;
const canvasId = 'cv-test';
const threadId = 'tr-test';

function sampleEnvelope(): ChatEnvelope {
  return {
    preamble: {},
    user: { text: 'hello', attachments: [] },
    skills: { invokedIds: [], resolved: [] },
    focus: {
      selection: {
        refs: [],
        topLevelIds: [],
        imageAttachments: [],
        snapshotAttachments: [],
      },
    },
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

describe('emptyThreadRecord', () => {
  it('returns the canonical empty shape', () => {
    expect(emptyThreadRecord()).toEqual({
      version: CHAT_THREAD_RECORD_VERSION,
      turns: [],
    });
  });
});

describe('loadThreadRecord / saveThreadRecord', () => {
  it('round-trips a thread record through disk', () => {
    const record: ChatThreadRecord = {
      version: CHAT_THREAD_RECORD_VERSION,
      turns: [
        {
          envelope: sampleEnvelope(),
          transcript: [{ role: 'user', content: 'hi there', timestamp: 1000 }],
        },
      ],
    };
    saveThreadRecord(threadId, record, canvasId);
    expect(loadThreadRecord(threadId, canvasId)).toEqual(record);
  });

  it('returns null when canvasId is missing', () => {
    expect(loadThreadRecord(threadId, undefined)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    expect(loadThreadRecord('does-not-exist', canvasId)).toBeNull();
  });

  it('returns null on corrupt JSON rather than throwing', () => {
    saveThreadRecord(threadId, emptyThreadRecord(), canvasId);
    writeFileSync(chatTurnsPath(canvasId, threadId), '{ not :: json');
    expect(loadThreadRecord(threadId, canvasId)).toBeNull();
  });

  it('ignores a legacy / wrong version rather than mis-reading it', () => {
    saveThreadRecord(threadId, emptyThreadRecord(), canvasId);
    writeFileSync(
      chatTurnsPath(canvasId, threadId),
      JSON.stringify({ version: 1, messages: [] }),
    );
    expect(loadThreadRecord(threadId, canvasId)).toBeNull();
  });
});
