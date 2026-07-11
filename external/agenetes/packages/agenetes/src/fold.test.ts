// Unit tests for the generic Tier-1 → Tier-2 fold (README I9.8).

import { describe, expect, it } from 'vitest';

import { createTranscriptFolder } from './fold.js';

import type { AgentStreamEvent } from '@agenetes/protocol';

function foldAll(events: AgentStreamEvent[]) {
  const folder = createTranscriptFolder();
  for (const e of events) folder.fold(e);
  return folder.result();
}

describe('createTranscriptFolder', () => {
  it('coalesces consecutive text deltas into one folded text', () => {
    expect(
      foldAll([
        { type: 'text_delta', data: { content: 'Hel' } },
        { type: 'text_delta', data: { content: 'lo' } },
      ]),
    ).toEqual([{ type: 'text', data: { content: 'Hello' } }]);
  });

  it('de-overlaps re-emitted thinking snapshots (Copilot CLI quirk)', () => {
    expect(
      foldAll([
        { type: 'thinking_delta', data: { content: 'Plan' } },
        { type: 'thinking_delta', data: { content: 'Plan' } },
        { type: 'thinking_delta', data: { content: 'ning' } },
      ]),
    ).toEqual([{ type: 'thinking', data: { content: 'Planning' } }]);
  });

  it('merges a tool_call with its later tool_call_update to final state', () => {
    const folded = foldAll([
      {
        type: 'tool_call',
        data: { toolCallId: 't1', title: 'Reading', status: 'pending' },
      },
      {
        type: 'tool_call_update',
        data: { toolCallId: 't1', status: 'completed', rawOutput: 'ok' },
      },
    ]);
    expect(folded).toEqual([
      {
        type: 'tool_call',
        data: {
          toolCallId: 't1',
          title: 'Reading',
          status: 'completed',
          rawOutput: 'ok',
        },
      },
    ]);
  });

  it('carries host-extension fields (internalToolName) verbatim', () => {
    const folded = foldAll([
      {
        type: 'tool_call',
        data: {
          toolCallId: 't1',
          title: 'read',
          internalToolName: 'read',
        },
      } as AgentStreamEvent,
    ]);
    const data = (folded[0] as { data: Record<string, unknown> }).data;
    expect(data.internalToolName).toBe('read');
  });

  it('keeps only the latest plan (replace-semantics), appended at the end', () => {
    const folded = foldAll([
      { type: 'text_delta', data: { content: 'hi' } },
      {
        type: 'plan',
        data: { entries: [{ content: 'a', status: 'pending' }] },
      },
      {
        type: 'plan',
        data: { entries: [{ content: 'b', status: 'completed' }] },
      },
    ]);
    expect(folded).toEqual([
      { type: 'text', data: { content: 'hi' } },
      {
        type: 'plan',
        data: { entries: [{ content: 'b', status: 'completed' }] },
      },
    ]);
  });

  it('returns an idempotent snapshot when a plan is present', () => {
    const folder = createTranscriptFolder();
    folder.fold({
      type: 'plan',
      data: { entries: [{ content: 'a', status: 'pending' }] },
    });

    expect(folder.result()).toEqual(folder.result());
  });

  it('folds an error row and ignores envelope frames (done/end/meta)', () => {
    expect(
      foldAll([
        { type: 'meta', data: { threadId: 'x' } } as AgentStreamEvent,
        { type: 'text_delta', data: { content: 'partial' } },
        { type: 'error', data: { error: 'boom' } },
        { type: 'done', data: { message: 'partial' } } as AgentStreamEvent,
        { type: 'end', data: {} },
      ]),
    ).toEqual([
      { type: 'text', data: { content: 'partial' } },
      { type: 'error', data: { error: 'boom' } },
    ]);
  });
});
