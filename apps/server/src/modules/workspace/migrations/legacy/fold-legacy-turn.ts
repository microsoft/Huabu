/**
 * Legacy turn fold — a stored {@link LegacyChatTurnRecord} → a folded
 * {@link AgentTurn} (README I9.8 / M6.9 row 2).
 *
 * The live Tier-1→Tier-2 fold (`createTranscriptFolder`) collapses an
 * agent's event STREAM into a folded transcript. This is its offline twin:
 * it folds an ALREADY-STORED legacy turn — a pi-ai `Message[]` transcript
 * plus the ACP overlay (`toolExtras`) the old chat store kept beside it —
 * into the same {@link FoldedMessage}[] shape the new two-tier log
 * (`chat_v2/`) holds. The output is exactly what `buildHistoryFromTurns`
 * and `rebuildContextMessages` read back, so a migrated thread renders and
 * replays identically to a natively-logged one.
 *
 * It is the precise reverse of `foldedTranscriptToPiMessages`
 * (build-prompt.ts):
 *   - assistant `text` / `thinking` / `toolCall` content blocks →
 *     folded `text` / `thinking` / `tool_call` messages (emission order);
 *   - a paired `toolResult` message → the matching `tool_call`'s
 *     `rawOutput` (unless the ACP overlay already supplied one);
 *   - `[SYSTEM Interrupted]` / `[SYSTEM Error]` user rows → the turn's
 *     `meta.stopReason = 'aborted'` / a folded `error` message;
 *   - a turn-level `plan` (rare in practice) → one folded `plan` appended
 *     at the end.
 *
 * The `toolExtras` ACP overlay (`toolKind` / `status` / `locations` /
 * `content` / `rawOutput`) is merged onto each `tool_call.data` verbatim,
 * mirroring how the live fold carries a driver's host-extension fields
 * through untouched. A turn that carries ANY overlay is an external (ACP)
 * turn, so its tool calls stay `generic`; a turn with no overlay is a
 * built-in turn, so each tool call is tagged with `internalToolName` (the
 * machine name) to drive the rich render variant.
 */

import { HUABU_CHAT_SUBMISSION_TYPE } from '../../../agent/agenetes/handle.js';

import type {
  LegacyChatTurnRecord,
  LegacyPiMessage,
} from './chat-turn-record.js';
import type {
  AgentTurn,
  AgentTurnMeta,
  FoldedMessage,
} from '@agenetes/protocol';

/**
 * The folded `tool_call` payload widened with the built-in host-extension
 * `internalToolName` — carried verbatim (the base protocol schema does not
 * declare it, exactly as the live fold does).
 */
type FoldedToolCallData = Extract<
  FoldedMessage,
  { type: 'tool_call' }
>['data'] & {
  internalToolName?: string;
};

/** Concatenate the text content of a (possibly multipart) pi-ai message. */
function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}

/** Extract a tool-result message's text payload, if any. */
function toolResultText(msg: LegacyPiMessage): string | undefined {
  const text = plainText((msg as { content?: unknown }).content);
  return text.length > 0 ? text : undefined;
}

/**
 * Fold one stored legacy chat turn into a folded {@link AgentTurn}: the
 * request wraps the persisted envelope as the host's `huabu.chat` variant
 * (`content` is opaque to L2), and the transcript is the folded twin of the
 * stored pi-ai transcript + ACP overlay.
 */
export function legacyChatTurnToAgentTurn(
  record: LegacyChatTurnRecord,
): AgentTurn {
  const transcript: FoldedMessage[] = [];
  const toolByCallId = new Map<string, FoldedToolCallData>();
  // A turn carrying the ACP overlay is an external (ACP) turn; one without
  // is a built-in turn. Built-in tool calls are tagged with the machine
  // name so history resolves the rich render variant.
  const isBuiltinTurn = record.toolExtras === undefined;
  let stopReason: string | undefined;

  for (const msg of record.transcript) {
    const role = (msg as { role?: unknown }).role;

    if (role === 'assistant') {
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          transcript.push({ type: 'text', data: { content: b.text } });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          transcript.push({ type: 'thinking', data: { content: b.thinking } });
        } else if (b.type === 'toolCall' && typeof b.id === 'string') {
          const id = b.id;
          const name = typeof b.name === 'string' ? b.name : 'tool';
          const overlay = record.toolExtras?.[id];
          const data: FoldedToolCallData = {
            toolCallId: id,
            title: name,
            ...(b.arguments !== undefined ? { rawInput: b.arguments } : {}),
            ...(isBuiltinTurn ? { internalToolName: name } : {}),
            ...(overlay?.toolKind !== undefined
              ? { toolKind: overlay.toolKind }
              : {}),
            ...(overlay?.status !== undefined
              ? { status: overlay.status }
              : {}),
            ...(overlay?.locations !== undefined
              ? { locations: overlay.locations }
              : {}),
            ...(overlay?.content !== undefined
              ? { content: overlay.content }
              : {}),
            ...(overlay?.rawOutput !== undefined
              ? { rawOutput: overlay.rawOutput }
              : {}),
          };
          toolByCallId.set(id, data);
          transcript.push({ type: 'tool_call', data } as FoldedMessage);
        }
      }
    } else if (role === 'toolResult') {
      const id = (msg as { toolCallId?: unknown }).toolCallId;
      if (typeof id !== 'string') continue;
      const tc = toolByCallId.get(id);
      // The ACP overlay's rawOutput is canonical; only fill from the paired
      // result message when the tool call has no output yet (built-in path).
      if (!tc || tc.rawOutput !== undefined) continue;
      const text = toolResultText(msg);
      if (text !== undefined) tc.rawOutput = text;
    } else if (role === 'user') {
      const trimmed = plainText((msg as { content?: unknown }).content).trim();
      if (trimmed.startsWith('[SYSTEM Interrupted]')) {
        stopReason = 'aborted';
      } else if (trimmed.startsWith('[SYSTEM Error]')) {
        const detail =
          trimmed.replace(/^\[SYSTEM Error\]\s*/, '').trim() || 'Agent error';
        transcript.push({ type: 'error', data: { error: detail } });
      }
    }
  }

  if (record.plan && record.plan.length > 0) {
    transcript.push({ type: 'plan', data: { entries: record.plan } });
  }

  const meta: AgentTurnMeta | undefined = stopReason
    ? { stopReason }
    : undefined;

  return {
    request: { type: HUABU_CHAT_SUBMISSION_TYPE, content: record.envelope },
    transcript,
    ...(meta ? { meta } : {}),
  };
}
