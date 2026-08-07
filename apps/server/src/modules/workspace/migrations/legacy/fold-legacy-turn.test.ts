/**
 * Tests for the offline legacy turn fold (M6.9 row 2).
 *
 *   ✓ assistant text / thinking / toolCall blocks fold in emission order
 *   ✓ a built-in turn (no toolExtras) tags every tool_call with internalToolName
 *   ✓ a paired toolResult fills the tool_call's rawOutput (built-in path)
 *   ✓ an ACP turn (toolExtras present) stays generic + merges the overlay
 *     verbatim, and the overlay's rawOutput is never clobbered by a result row
 *   ✓ [SYSTEM Interrupted] → meta.stopReason = 'aborted'
 *   ✓ [SYSTEM Error] X → a folded error message carrying X
 *   ✓ a turn-level plan is appended once at the end
 *   ✓ the request wraps the envelope as the host huabu.chat variant
 */

import { describe, expect, it } from 'vitest';

import { legacyChatTurnToAgentTurn } from './fold-legacy-turn.js';
import { HUABU_CHAT_SUBMISSION_TYPE } from '../../../agent/agenetes/handle.js';

import type {
  LegacyChatEnvelope,
  LegacyChatTurnRecord,
  LegacyPiMessage,
} from './chat-turn-record.js';
import type { FoldedMessage } from '@agenetes/protocol';

function envelope(text = 'hello'): LegacyChatEnvelope {
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
  };
}

function record(
  transcript: unknown[],
  extra: Partial<LegacyChatTurnRecord> = {},
): LegacyChatTurnRecord {
  return {
    envelope: envelope(),
    transcript: transcript as LegacyPiMessage[],
    ...extra,
  };
}

function byType<T extends FoldedMessage['type']>(
  transcript: FoldedMessage[],
  type: T,
): Extract<FoldedMessage, { type: T }>[] {
  return transcript.filter(
    (m): m is Extract<FoldedMessage, { type: T }> => m.type === type,
  );
}

describe('legacyChatTurnToAgentTurn', () => {
  it('wraps the envelope as the host huabu.chat request', () => {
    const env = envelope('do the thing');
    const turn = legacyChatTurnToAgentTurn(record([], { envelope: env }));
    expect(turn.request).toEqual({
      type: HUABU_CHAT_SUBMISSION_TYPE,
      content: env,
    });
  });

  it('folds assistant text / thinking / toolCall blocks in order', () => {
    const turn = legacyChatTurnToAgentTurn(
      record([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think' },
            { type: 'text', text: 'here is the plan' },
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'search_nodes',
              arguments: { q: 'risk' },
            },
          ],
        },
      ]),
    );
    expect(turn.transcript.map((m) => m.type)).toEqual([
      'thinking',
      'text',
      'tool_call',
    ]);
    const [tc] = byType(turn.transcript, 'tool_call');
    expect(tc.data.toolCallId).toBe('call-1');
    expect(tc.data.title).toBe('search_nodes');
    expect(tc.data.rawInput).toEqual({ q: 'risk' });
  });

  it('tags a built-in turn tool_call with internalToolName and folds its result', () => {
    const turn = legacyChatTurnToAgentTurn(
      record([
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'read_file', arguments: {} },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'file body' }],
        },
      ]),
    );
    const [tc] = byType(turn.transcript, 'tool_call');
    expect((tc.data as { internalToolName?: string }).internalToolName).toBe(
      'read_file',
    );
    expect(tc.data.rawOutput).toBe('file body');
  });

  it('keeps an ACP turn generic and merges the overlay verbatim without clobbering rawOutput', () => {
    const turn = legacyChatTurnToAgentTurn(
      record(
        [
          {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: 'c9', name: 'edit', arguments: {} },
            ],
          },
          {
            role: 'toolResult',
            toolCallId: 'c9',
            content: [{ type: 'text', text: 'RESULT ROW (should be ignored)' }],
          },
        ],
        {
          toolExtras: {
            c9: {
              toolKind: 'edit',
              status: 'completed',
              rawOutput: 'overlay output',
              locations: [{ path: '/a.txt' }],
            } as never,
          },
        },
      ),
    );
    const [tc] = byType(turn.transcript, 'tool_call');
    // ACP turn: no internalToolName tag.
    expect(
      (tc.data as { internalToolName?: string }).internalToolName,
    ).toBeUndefined();
    // Overlay merged verbatim; the canonical overlay rawOutput wins.
    expect((tc.data as { toolKind?: string }).toolKind).toBe('edit');
    expect((tc.data as { status?: string }).status).toBe('completed');
    expect(tc.data.rawOutput).toBe('overlay output');
  });

  it('folds [SYSTEM Interrupted] into meta.stopReason = aborted', () => {
    const turn = legacyChatTurnToAgentTurn(
      record([{ role: 'user', content: '[SYSTEM Interrupted]' }]),
    );
    expect(turn.meta?.stopReason).toBe('aborted');
  });

  it('folds [SYSTEM Error] X into an error message carrying X', () => {
    const turn = legacyChatTurnToAgentTurn(
      record([{ role: 'user', content: '[SYSTEM Error] boom happened' }]),
    );
    const [err] = byType(turn.transcript, 'error');
    expect(err.data).toEqual({ error: 'boom happened' });
    expect(turn.meta).toBeUndefined();
  });

  it('appends a turn-level plan once at the end', () => {
    const turn = legacyChatTurnToAgentTurn(
      record([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], {
        plan: [{ content: 'step one', status: 'pending', priority: 'medium' }],
      }),
    );
    const plans = byType(turn.transcript, 'plan');
    expect(plans).toHaveLength(1);
    expect(turn.transcript[turn.transcript.length - 1].type).toBe('plan');
  });
});
