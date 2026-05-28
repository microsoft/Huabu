/**
 * Tests for the chat-parts sidecar store.
 *
 * Coverage:
 *
 *   ✓ emptySidecar shape
 *   ✓ read/write round-trip
 *   ✓ readChatParts → null when canvasId missing / file missing / corrupt
 *   ✓ appendPlanPart: append + replace at same (messageIndex, partIndex)
 *   ✓ upsertToolExt: append on new toolCallId, merge on repeat
 *   ✓ mergeToolExtension: append-only for content/locations,
 *     replace-semantics for status/toolKind/rawOutput/permission
 *   ✓ setToolPermission: no-op when no matching ext, else replaces
 *   ✓ recordMessageTimestamp: first-write-wins, sparse-pads
 *   ✓ writeChatParts no-op when canvasId missing
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendPlanPart,
  emptySidecar,
  hasChatParts,
  readChatParts,
  recordMessageTimestamp,
  setToolPermission,
  upsertToolExt,
  writeChatParts,
  type ChatPartsSidecar,
  type ToolAcpExtension,
} from './chat-parts-store.js';
import { chatPartsPath } from '../../storage/paths.js';
import { setWorkspacePath } from '../../workspace.js';

let tmp: string;
const canvasId = 'cv-test';
const threadId = 'tr-test';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-sidecar-'));
  setWorkspacePath(tmp);
  // Pre-create the canvas dir so chatPartsPath resolves to a valid
  // location (writeChatParts mkdirp's the chat subdir itself).
  mkdirSync(join(tmp, canvasId), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('emptySidecar', () => {
  it('returns the canonical empty shape', () => {
    expect(emptySidecar()).toEqual({
      schemaVersion: 1,
      parts: [],
      messageTimestamps: [],
    });
  });
});

describe('readChatParts / writeChatParts', () => {
  it('round-trips a sidecar through disk', () => {
    const sidecar = appendPlanPart(emptySidecar(), 1, [
      { content: 'step', status: 'pending', priority: 'high' },
    ]);
    writeChatParts(threadId, sidecar, canvasId);
    const loaded = readChatParts(threadId, canvasId);
    expect(loaded).toEqual(sidecar);
  });

  it('returns null when canvasId is missing', () => {
    expect(readChatParts(threadId, undefined)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    expect(readChatParts('does-not-exist', canvasId)).toBeNull();
  });

  it('returns null when the file is corrupt rather than throwing', () => {
    writeChatParts(threadId, emptySidecar(), canvasId);
    writeFileSync(chatPartsPath(canvasId, threadId), '{ this is :: not json');
    expect(readChatParts(threadId, canvasId)).toBeNull();
  });

  it('returns null when the file has a wrong shape', () => {
    // Ensure the chat dir exists by writing a valid file first, then
    // overwrite with a wrong-shape payload.
    writeChatParts(threadId, emptySidecar(), canvasId);
    writeFileSync(
      chatPartsPath(canvasId, threadId),
      JSON.stringify({ schemaVersion: 99 }),
    );
    expect(readChatParts(threadId, canvasId)).toBeNull();
  });

  it('writeChatParts is a no-op when canvasId is missing', () => {
    writeChatParts(threadId, emptySidecar(), undefined);
    expect(hasChatParts(threadId, canvasId)).toBe(false);
  });
});

describe('appendPlanPart', () => {
  it('appends a new plan part on first call', () => {
    const entries = [
      { content: 'a', status: 'pending' as const, priority: 'high' as const },
    ];
    const next = appendPlanPart(emptySidecar(), 0, entries);
    expect(next.parts).toHaveLength(1);
    expect(next.parts[0]).toMatchObject({ kind: 'plan', messageIndex: 0 });
  });

  it('replaces an existing plan at the same (messageIndex, partIndex)', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = appendPlanPart(s, 0, [
      { content: 'old', status: 'pending', priority: 'high' },
    ]);
    s = appendPlanPart(s, 0, [
      { content: 'new', status: 'in_progress', priority: 'high' },
    ]);
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toMatchObject({
      kind: 'plan',
      entries: [{ content: 'new', status: 'in_progress', priority: 'high' }],
    });
  });

  it('keeps separate plans across distinct messageIndexes', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = appendPlanPart(s, 0, [
      { content: 'a', status: 'pending', priority: 'high' },
    ]);
    s = appendPlanPart(s, 1, [
      { content: 'b', status: 'pending', priority: 'high' },
    ]);
    expect(s.parts).toHaveLength(2);
  });
});

describe('upsertToolExt', () => {
  it('appends a fresh entry for a new toolCallId', () => {
    const s = upsertToolExt(
      emptySidecar(),
      'tc-1',
      { toolKind: 'read', status: 'pending' },
      { messageIndex: 2 },
    );
    expect(s.parts).toHaveLength(1);
    expect(s.parts[0]).toMatchObject({
      kind: 'tool_acp_ext',
      messageIndex: 2,
      toolCallId: 'tc-1',
      extension: { toolKind: 'read', status: 'pending' },
    });
  });

  it('merges append-only fields (content/locations) on second call', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = upsertToolExt(
      s,
      'tc-1',
      {
        content: [{ type: 'content', content: { type: 'text', text: 'a' } }],
        locations: [{ path: '/x' }],
      } as ToolAcpExtension,
      { messageIndex: 0 },
    );
    s = upsertToolExt(
      s,
      'tc-1',
      {
        content: [{ type: 'content', content: { type: 'text', text: 'b' } }],
        locations: [{ path: '/y' }],
      } as ToolAcpExtension,
      { messageIndex: 0 },
    );
    expect(s.parts).toHaveLength(1);
    const ext = (s.parts[0] as { extension: ToolAcpExtension }).extension;
    expect(ext.content).toHaveLength(2);
    expect(ext.locations).toEqual([{ path: '/x' }, { path: '/y' }]);
  });

  it('replaces status/toolKind/rawOutput on update', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = upsertToolExt(
      s,
      'tc-1',
      { status: 'pending', toolKind: 'read' },
      { messageIndex: 0 },
    );
    s = upsertToolExt(
      s,
      'tc-1',
      { status: 'completed', rawOutput: { ok: true } },
      { messageIndex: 0 },
    );
    const ext = (s.parts[0] as { extension: ToolAcpExtension }).extension;
    expect(ext.status).toBe('completed');
    expect(ext.toolKind).toBe('read'); // preserved across update
    expect(ext.rawOutput).toEqual({ ok: true });
  });

  it('never changes messageIndex on subsequent updates', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = upsertToolExt(s, 'tc-1', { status: 'pending' }, { messageIndex: 5 });
    s = upsertToolExt(s, 'tc-1', { status: 'completed' }, { messageIndex: 99 });
    expect((s.parts[0] as { messageIndex: number }).messageIndex).toBe(5);
  });
});

describe('setToolPermission', () => {
  it('is a no-op when no matching tool_acp_ext exists', () => {
    const before = emptySidecar();
    const after = setToolPermission(before, 'no-such-tool', {
      optionId: 'opt-1',
      optionKind: 'allow_once',
      outcome: 'selected',
      source: 'auto-allow',
      decidedAt: 123,
    });
    expect(after).toBe(before);
  });

  it('replaces the permission on the matching entry', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = upsertToolExt(s, 'tc-1', { status: 'pending' }, { messageIndex: 0 });
    s = setToolPermission(s, 'tc-1', {
      optionId: 'opt-1',
      optionKind: 'allow_once',
      outcome: 'selected',
      source: 'auto-allow',
      decidedAt: 999,
    });
    const ext = (s.parts[0] as { extension: ToolAcpExtension }).extension;
    expect(ext.permission?.outcome).toBe('selected');
    expect(ext.permission?.decidedAt).toBe(999);
  });
});

describe('recordMessageTimestamp', () => {
  it('writes the timestamp on first call', () => {
    const s = recordMessageTimestamp(emptySidecar(), 0, 1000);
    expect(s.messageTimestamps).toEqual([1000]);
  });

  it('first-write-wins on subsequent calls', () => {
    let s: ChatPartsSidecar = emptySidecar();
    s = recordMessageTimestamp(s, 0, 1000);
    s = recordMessageTimestamp(s, 0, 9999);
    expect(s.messageTimestamps).toEqual([1000]);
  });

  it('sparse-pads with 0s when index is beyond current length', () => {
    const s = recordMessageTimestamp(emptySidecar(), 3, 4000);
    expect(s.messageTimestamps).toEqual([0, 0, 0, 4000]);
  });
});
