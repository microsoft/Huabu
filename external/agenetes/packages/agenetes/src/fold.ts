// The generic Tier-1 → Tier-2 fold (README I9.8).
//
// `AgentStreamEvent` is the *delta* view of a turn (Tier-1); `FoldedMessage`
// is its accumulated *folded* twin (Tier-2). Folding is the symmetric twin
// of a driver translating its native wire protocol INTO the event stream:
// once every backend yields the shared event vocabulary, the fold that
// collapses those deltas into messages is DRIVER-AGNOSTIC and lives here,
// ONCE — the log never reads a driver's `run()` return value, so a driver's
// `TResult` is free (it need not equal `FoldedMessage[]`).
//
// The fold carries each event's `data` VERBATIM (a shallow spread, never a
// schema `parse`) so host-extension fields ride through untouched — e.g. the
// built-in driver's `tool_call.data.internalToolName`, which the base
// protocol schema does not declare but the host reads back when rendering
// history. Stripping via a strict `parse` here would silently drop them.

import { AGENT_STREAM_EVENTS } from '@agenetes/protocol';

import type { AgentStreamEvent, FoldedMessage } from '@agenetes/protocol';

/** One folded `tool_call` message (narrowed off the union). */
type FoldedToolCall = Extract<FoldedMessage, { type: 'tool_call' }>;

/**
 * Defensively accumulate a re-emitted thinking snapshot. Some agents
 * (observed: Copilot CLI intent text) re-send the same `agent_thought_chunk`
 * snapshot instead of a true delta, so a naive `+=` yields `"PlanPlan"`.
 * Spec-conformant agents send disjoint deltas, so the incoming text never
 * legitimately equals the trailing accumulated text — making a suffix match
 * a safe dedupe. The translator yields the RAW chunk (the live stream sees
 * it as-is), so the fold is where the durable transcript de-overlaps.
 */
function mergeThinking(existing: string, incoming: string): string {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (existing.endsWith(incoming)) return existing;
  return existing + incoming;
}

/** Merge every DEFINED field of an update (except the key) into a target. */
function mergeDefined(
  target: Record<string, unknown>,
  update: Record<string, unknown>,
  exceptKey: string,
): void {
  for (const [k, v] of Object.entries(update)) {
    if (k !== exceptKey && v !== undefined) target[k] = v;
  }
}

/**
 * An incremental transcript folder: feed it a turn's Tier-1 events in
 * emission order via {@link fold}, then read the accumulated
 * `FoldedMessage[]` via {@link result}. Deltas collapse into their folded
 * form (concatenated text / thinking; each `tool_call` merged with its
 * `tool_call_update`s to final state; the latest full-replacement `plan`;
 * error rows). Envelope / control frames (`meta` / `done` / `end` /
 * `permission_request` / the `*_update` state frames) are NOT transcript
 * content and fold to nothing (see `turn.ts`).
 */
export interface TranscriptFolder {
  fold(event: AgentStreamEvent): void;
  result(): FoldedMessage[];
}

/** Create a fresh {@link TranscriptFolder}. */
export function createTranscriptFolder(): TranscriptFolder {
  const folded: FoldedMessage[] = [];
  const toolByCallId = new Map<string, FoldedToolCall>();
  // Plans use REPLACE-semantics (latest wins) and render turn-level, so we
  // stage the final entries and append one folded `plan` at `result()`.
  type PlanEntries = Extract<
    FoldedMessage,
    { type: 'plan' }
  >['data']['entries'];
  let planEntries: PlanEntries | null = null;

  return {
    fold(event: AgentStreamEvent): void {
      switch (event.type) {
        case AGENT_STREAM_EVENTS.TextDelta: {
          const last = folded[folded.length - 1];
          if (last?.type === 'text') {
            last.data.content += event.data.content;
          } else {
            folded.push({ type: 'text', data: { ...event.data } });
          }
          break;
        }
        case AGENT_STREAM_EVENTS.ThinkingDelta: {
          const last = folded[folded.length - 1];
          if (last?.type === 'thinking') {
            last.data.content = mergeThinking(
              last.data.content,
              event.data.content,
            );
          } else {
            folded.push({ type: 'thinking', data: { ...event.data } });
          }
          break;
        }
        case AGENT_STREAM_EVENTS.ToolCall: {
          // `rawOutput` is delivered later by a `tool_call_update`.
          const msg: FoldedToolCall = {
            type: 'tool_call',
            data: { ...event.data, rawOutput: undefined },
          };
          folded.push(msg);
          toolByCallId.set(event.data.toolCallId, msg);
          break;
        }
        case AGENT_STREAM_EVENTS.ToolCallUpdate: {
          const tc = toolByCallId.get(event.data.toolCallId);
          if (tc) {
            mergeDefined(
              tc.data as Record<string, unknown>,
              event.data as Record<string, unknown>,
              'toolCallId',
            );
          }
          break;
        }
        case AGENT_STREAM_EVENTS.Plan: {
          planEntries = event.data.entries;
          break;
        }
        case AGENT_STREAM_EVENTS.Error: {
          folded.push({ type: 'error', data: { ...event.data } });
          break;
        }
        default:
          // meta / done / end / permission_request / *_update — not content.
          break;
      }
    },
    result(): FoldedMessage[] {
      return planEntries
        ? [...folded, { type: 'plan', data: { entries: planEntries } }]
        : [...folded];
    },
  };
}
