/**
 * Unit tests for the history projection (`buildHistoryFromTurns`).
 *
 * Locks the folded `AgentTurn` → `ChatHistoryItem[]` reconstruction that
 * the `/history` reload path depends on:
 *   - each turn's user bubble is rebuilt from the persisted envelope
 *     (`request.content`), not from a transcript row;
 *   - assistant text / thinking / tool fragments become ordered parts;
 *   - built-in tools resolve a rich render variant; ACP tools stay generic;
 *   - an aborted run surfaces an `interrupted` status row; a folded error
 *     surfaces an `error` status row;
 *   - a turn-level plan is appended after the assistant parts.
 */

import { describe, expect, it } from 'vitest';

import { buildHistoryFromTurns } from './history.js';
import { createChatSubmission } from '../../agenetes/handle.js';

import type { ChatEnvelope } from '../envelope.js';
import type { AgentTurn, FoldedMessage } from '@agenetes/protocol';
import type { ChatHistoryItem } from '@sediment/shared';

function makeEnvelope(text: string): ChatEnvelope {
  return {
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
  } as unknown as ChatEnvelope;
}

function makeTurn(
  text: string | null,
  transcript: FoldedMessage[],
  meta?: AgentTurn['meta'],
): AgentTurn {
  return {
    request: text === null ? null : createChatSubmission(makeEnvelope(text)),
    transcript,
    ...(meta ? { meta } : {}),
  };
}

function build(turns: AgentTurn[]): ChatHistoryItem[] {
  const messages: ChatHistoryItem[] = [];
  buildHistoryFromTurns(turns, messages);
  return messages;
}

describe('buildHistoryFromTurns', () => {
  it('rebuilds the user bubble from the envelope and assistant text from the transcript', () => {
    const out = build([
      makeTurn('hello there', [
        { type: 'text', data: { content: 'general kenobi' } },
      ]),
    ]);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'user', content: 'hello there' });
    expect(out[1].role).toBe('assistant');
    if (out[1].role !== 'assistant') throw new Error('unreachable');
    expect(out[1].parts).toContainEqual({
      kind: 'text',
      text: 'general kenobi',
    });
  });

  it('omits the user bubble for a resume turn with a null request', () => {
    const out = build([
      makeTurn(null, [{ type: 'text', data: { content: 'resumed reply' } }]),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
  });

  it('renders an ACP tool call as a generic tool part', () => {
    const out = build([
      makeTurn('do it', [
        {
          type: 'tool_call',
          data: {
            toolCallId: 'tc1',
            title: 'read_file',
            status: 'completed',
          },
        } as FoldedMessage,
      ]),
    ]);

    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant?.role).toBe('assistant');
    if (assistant?.role !== 'assistant') throw new Error('unreachable');
    const toolPart = assistant.parts.find((p) => p.kind === 'tool');
    expect(toolPart).toMatchObject({
      kind: 'tool',
      toolCallId: 'tc1',
      variant: 'generic',
    });
  });

  it.each(['space_commands', 'canvas_commands'])(
    'normalizes the %s history tool to the canonical Space renderer',
    (internalToolName) => {
      const out = build([
        makeTurn('change it', [
          {
            type: 'tool_call',
            data: {
              toolCallId: 'tc-space',
              title: internalToolName,
              internalToolName,
              status: 'completed',
              rawOutput: JSON.stringify({
                tool: internalToolName,
                status: 'success',
                data: { commands: [] },
              }),
            },
          } as FoldedMessage,
        ]),
      ]);

      const assistant = out.find((m) => m.role === 'assistant');
      if (assistant?.role !== 'assistant') throw new Error('unreachable');
      const toolPart = assistant.parts.find((p) => p.kind === 'tool');
      expect(toolPart).toMatchObject({
        variant: 'space_commands',
        data: { tool: 'space_commands', status: 'success' },
      });
    },
  );

  it('surfaces an interrupted status row for an aborted turn', () => {
    const out = build([
      makeTurn('stop me', [{ type: 'text', data: { content: 'partial' } }], {
        stopReason: 'aborted',
      }),
    ]);

    expect(out.at(-1)).toEqual({ role: 'status', status: 'interrupted' });
  });

  it('surfaces an error status row from a folded error fragment', () => {
    const out = build([
      makeTurn('boom', [
        { type: 'error', data: { error: 'kaboom' } } as FoldedMessage,
      ]),
    ]);

    expect(out.at(-1)).toEqual({
      role: 'status',
      status: 'error',
      detail: 'kaboom',
    });
  });

  it('appends a turn-level plan after the assistant parts', () => {
    const out = build([
      makeTurn('plan it', [
        { type: 'text', data: { content: 'working' } },
        {
          type: 'plan',
          data: { entries: [{ content: 'step 1', status: 'pending' }] },
        } as FoldedMessage,
      ]),
    ]);

    const assistant = out.find((m) => m.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('unreachable');
    expect(assistant.parts.at(-1)).toMatchObject({ kind: 'plan' });
  });
});
