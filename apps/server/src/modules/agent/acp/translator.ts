/**
 * Translate ACP `session/update` notifications into Sediment's internal
 * `AgentStreamEvent` shape so SSE consumers don't need to know about
 * the ACP wire format.
 *
 * ### Supported variants
 *
 *   - `agent_message_chunk`  → `text_delta`
 *   - `agent_thought_chunk`  → `thinking_delta`
 *   - `tool_call`            → `tool_call`
 *   - `tool_call_update`     → `tool_call_update`
 *   - `plan`                 → `plan`
 *
 * Out of scope (returns null, caller logs + drops):
 *   - `user_message_chunk` (we don't echo our own messages back)
 *   - `available_commands_update` (handled out-of-turn in `service.ts`)
 *   - `current_mode_update`, `config_option_update`, `session_info_update`,
 *     `usage_update` (no UI surface yet)
 *
 * ### Trust boundary
 *
 * The external agent process is OUTSIDE our trust boundary, so the
 * translator validates every payload with `ZAcpSessionUpdate.safeParse`
 * before narrowing on the discriminator. Type assertions earlier in
 * the stack (e.g. `client.ts` `as AcpSessionUpdate` on `params.update`)
 * are blind casts; this file is the actual validation gate.
 *
 * ### Observability
 *
 * Three module-scoped counters expose translator behaviour for tests
 * and dev dashboards (see {@link getTranslatorCounters}):
 *
 *   - `invalidPayloads` — `safeParse` rejected the wire shape.
 *   - `toolCallMissingKind` — `tool_call` arrived without ACP `kind`,
 *     meaning the agent did not classify the tool semantically. We
 *     still forward the event; the renderer falls back to "generic
 *     tool" presentation.
 *   - `unknownSessionUpdate` — discriminator not in our cases (a
 *     future spec variant).
 *
 * Counters are process-lifetime; reset on `resetTranslatorCounters()`
 * (test-only).
 */

import { ZAcpSessionUpdate } from '@sediment/shared';

import type {
  AcpSessionUpdate,
  AgentPlanEventData,
  AgentStreamEvent,
  AgentToolCallEventData,
  AgentToolCallUpdateEventData,
} from '@sediment/shared';

/** Minimal logger surface so this file does not depend on Fastify. */
export interface TranslatorLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

const noopLogger: TranslatorLogger = {
  info: () => undefined,
  warn: () => undefined,
};

interface TranslatorCounters {
  /** Payloads that failed `ZAcpSessionUpdate.safeParse`. */
  invalidPayloads: number;
  /** `tool_call` updates whose ACP `kind` field was undefined. */
  toolCallMissingKind: number;
  /** Discriminators we have no case for (probably future spec additions). */
  unknownSessionUpdate: number;
}

let counters: TranslatorCounters = {
  invalidPayloads: 0,
  toolCallMissingKind: 0,
  unknownSessionUpdate: 0,
};

/** Snapshot the current counters. Cheap; safe to call from request handlers. */
export function getTranslatorCounters(): Readonly<TranslatorCounters> {
  return { ...counters };
}

/** Reset counters. Test-only — production code should never call this. */
export function resetTranslatorCounters(): void {
  counters = {
    invalidPayloads: 0,
    toolCallMissingKind: 0,
    unknownSessionUpdate: 0,
  };
}

/**
 * ACP allows fields to be explicitly `null` to mean "unchanged"; our
 * event payloads use `undefined` for the same intent so consumers can
 * branch with a single `if (data.status !== undefined)` check.
 */
function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Map one ACP `session/update` notification to a Sediment
 * `AgentStreamEvent`. Returns `null` when:
 *
 *   - the payload failed schema validation (counted, warn-logged)
 *   - the discriminator is one we deliberately ignore (e.g.
 *     `user_message_chunk`)
 *   - the discriminator is unknown (counted, info-logged so we notice
 *     when an agent uses a new spec variant)
 *   - the content is empty (e.g. `agent_message_chunk` whose
 *     content block isn't `type:'text'`)
 *
 * `update` is typed as `unknown` because every caller (`client.ts`,
 * `service.ts`) obtains it via a blind cast on JSON-RPC params — this
 * function IS the validation gate.
 */
export function acpUpdateToStreamEvent(
  update: unknown,
  logger: TranslatorLogger = noopLogger,
): AgentStreamEvent | null {
  const parsed = ZAcpSessionUpdate.safeParse(update);
  if (!parsed.success) {
    counters.invalidPayloads += 1;
    logger.warn(
      { issues: parsed.error.issues, raw: update },
      '[acp-translator] session/update failed schema validation',
    );
    return null;
  }
  const u: AcpSessionUpdate = parsed.data;

  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      if (u.content.type !== 'text') return null;
      return { type: 'text_delta', data: { content: u.content.text } };
    }
    case 'agent_thought_chunk': {
      // Reasoning / scratchpad content. Some agents (Copilot, Claude
      // Code) stream thinking even when they don't emit final prose,
      // so dropping these would make tool-only turns look blank.
      if (u.content.type !== 'text') return null;
      return { type: 'thinking_delta', data: { content: u.content.text } };
    }
    case 'tool_call': {
      if (u.kind === undefined) counters.toolCallMissingKind += 1;
      const data: AgentToolCallEventData = {
        toolCallId: u.toolCallId,
        title: u.title,
        toolKind: u.kind,
        status: u.status,
        locations: u.locations,
        content: u.content,
        rawInput: u.rawInput,
        // External-agent turns never set internalToolName — that field
        // is reserved for the internal pi-ai bridge. Leaving it
        // undefined makes the renderer's escape-hatch check
        // (`if (internalToolName) …`) miss, falling through to the
        // generic ACP renderer.
      };
      return { type: 'tool_call', data };
    }
    case 'tool_call_update': {
      const data: AgentToolCallUpdateEventData = {
        toolCallId: u.toolCallId,
        status: nullToUndefined(u.status),
        title: nullToUndefined(u.title),
        content: nullToUndefined(u.content),
        locations: nullToUndefined(u.locations),
        rawOutput: u.rawOutput,
      };
      return { type: 'tool_call_update', data };
    }
    case 'plan': {
      const data: AgentPlanEventData = { entries: u.entries };
      return { type: 'plan', data };
    }
    // Out-of-turn variants we route elsewhere or simply ignore.
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
      return null;
    default: {
      counters.unknownSessionUpdate += 1;
      logger.info(
        { sessionUpdate: (u as { sessionUpdate?: unknown }).sessionUpdate },
        '[acp-translator] unrecognised sessionUpdate discriminator',
      );
      return null;
    }
  }
}
