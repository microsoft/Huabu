/**
 * Structured chat thread store — the source of truth for chat history
 * in the envelope-persistence model.
 *
 * ### Why a new store?
 *
 * The legacy {@link import('./chat-store.js')} persists a pi-ai
 * `Context` (a flat `messages` array) directly, with the user's
 * selection / skills / attachments smuggled into the message string as
 * `[SYSTEM …]` tags and recovered on reload by reverse-parsing them.
 * That round-trip was the cause of several papercuts (hint loss on
 * reload, `[SYSTEM]` leakage, redundant tail tags).
 *
 * This store records, per turn, the structured {@link ChatEnvelope}
 * the user contributed plus the assistant/tool transcript the agent
 * produced. The pi-ai `Context.messages` the agent runs over is then
 * *derived* on each request by re-serialising the envelopes — so the
 * `[SYSTEM …]` encoding is never the on-disk source of truth.
 *
 * ### Append-only JSONL at turn granularity
 *
 * Finalized turns are appended one-per-line to `<thread>.turns.jsonl`.
 * A finalized turn is immutable and never rewritten, so persisting one
 * turn costs a single `appendFileSync` — write cost is O(turn), not
 * O(whole thread). The single in-progress turn is held separately in
 * `<thread>.active.json` (rewritten on each debounced streaming save so
 * a mid-generation reload still shows partial progress), then promoted
 * to a JSONL line and deleted when it finalizes.
 *
 * All mutability (streaming deltas, abort cleanup) is confined to the
 * active turn; the JSONL log is append-only and stable. This is why the
 * rich-ACP overlay (`toolExtras`, `plan`) can live *inside* the turn
 * record keyed by stable ids — no `.parts.json` sidecar, no
 * timestamp/position bridging.
 *
 * ### No migration (yet)
 *
 * Records live on distinct `.turns.jsonl` / `.active.json` paths.
 * Legacy `.json` pi-ai `Context` files are simply ignored: a thread
 * with no JSONL log reads as empty and starts fresh. A migration
 * adapter can be layered on later once the new structure is proven.
 *
 * ### File layout
 *
 *   <canvasDir>/.history/chat/<threadId>.json         ← legacy pi-ai Context
 *   <canvasDir>/.history/chat/<threadId>.turns.jsonl  ← finalized turns (THIS module)
 *   <canvasDir>/.history/chat/<threadId>.active.json  ← in-progress turn (THIS module)
 */

import { existsSync, rmSync } from 'node:fs';

import {
  appendJsonLine,
  atomicWriteJson,
  mkdirp,
  readJson,
  readJsonLines,
} from '../../storage/io.js';
import {
  chatActiveTurnPath,
  chatDir,
  chatTurnsPath,
} from '../../storage/paths.js';

import type { ChatEnvelope } from '../conversation/envelope.js';
import type { Context } from '@earendil-works/pi-ai';
import type {
  AcpPlanEntry,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
  ToolPermissionState,
} from '@sediment/shared';

/** A pi-ai message as stored on a {@link Context}. */
export type PiMessage = Context['messages'][number];

/**
 * The ACP-specific subset of a `tool_call` / `tool_call_update` payload
 * that does NOT round-trip through pi-ai's `ToolResultMessage`: the
 * semantic envelope (`toolKind`, lifecycle `status`, source `locations`,
 * structured `content`) plus any permission decision. Stored on the
 * turn record (keyed by `toolCallId`) so external-agent tool calls
 * re-render with their rich UI on reload.
 *
 * Append-only fields (`locations`, `content`) merge with prior values
 * via {@link mergeToolExtension}; replace-semantics fields (`status`,
 * `toolKind`, `permission`, `rawOutput`) overwrite.
 */
export interface ToolAcpExtension {
  toolKind?: AcpToolKind;
  status?: AcpToolCallStatus;
  locations?: AcpToolCallLocation[];
  content?: AcpToolCallContent[];
  rawOutput?: unknown;
  permission?: ToolPermissionState;
}

/**
 * Merge two {@link ToolAcpExtension} values. Append-only fields
 * (`locations`, `content`) concatenate; replace-semantics fields
 * overwrite when the new value is defined.
 */
export function mergeToolExtension(
  prev: ToolAcpExtension,
  next: ToolAcpExtension,
): ToolAcpExtension {
  return {
    toolKind: next.toolKind ?? prev.toolKind,
    status: next.status ?? prev.status,
    locations:
      next.locations !== undefined
        ? [...(prev.locations ?? []), ...next.locations]
        : prev.locations,
    content:
      next.content !== undefined
        ? [...(prev.content ?? []), ...next.content]
        : prev.content,
    rawOutput: next.rawOutput !== undefined ? next.rawOutput : prev.rawOutput,
    permission: next.permission ?? prev.permission,
  };
}

/**
 * Mutable per-turn ACP overlay accumulator. The external-agent dispatch
 * (`runAcpAgent`) mutates this in place as tool / plan events arrive;
 * the route folds it into the {@link ChatTurnRecord} when the turn is
 * persisted. Keyed by stable ids — no timestamps, no position arrays.
 */
export interface AcpTurnOverlay {
  toolExtras: Record<string, ToolAcpExtension>;
  plan?: AcpPlanEntry[];
}

/** Construct an empty {@link AcpTurnOverlay}. */
export function emptyAcpOverlay(): AcpTurnOverlay {
  return { toolExtras: {} };
}

/**
 * Upsert (merge) a tool extension into the overlay in place, keyed by
 * `toolCallId`.
 */
export function applyToolExt(
  overlay: AcpTurnOverlay,
  toolCallId: string,
  extension: ToolAcpExtension,
): void {
  const prev = overlay.toolExtras[toolCallId];
  overlay.toolExtras[toolCallId] = prev
    ? mergeToolExtension(prev, extension)
    : extension;
}

/**
 * One turn: the user's structured input envelope, the assistant/tool
 * transcript the agent produced in response, and an optional rich-ACP
 * overlay for external-agent turns.
 *
 * `transcript` holds only the messages the agent appended this turn
 * (assistant text, tool calls/results, and any `[SYSTEM Error]` /
 * `[SYSTEM Interrupted]` status rows) — NOT the re-serialisable user
 * messages, which are rebuilt from `envelope` on load. Message *order*
 * is encoded by the array; nothing relies on timestamps for ordering.
 *
 * `toolExtras` / `plan` are the ACP overlay that pi-ai's closed message
 * union cannot carry. They are keyed by STABLE ids — `toolExtras` by
 * the per-call `toolCallId` (joined onto the matching transcript tool
 * call at render time), `plan` is the turn's final full-replacement
 * plan. Absent for internal (pi-agent-core) turns.
 */
export interface ChatTurnRecord {
  envelope: ChatEnvelope;
  transcript: PiMessage[];
  /** ACP tool extensions, keyed by `toolCallId`. */
  toolExtras?: Record<string, ToolAcpExtension>;
  /** The turn's final ACP plan (full-replacement on the wire). */
  plan?: AcpPlanEntry[];
}

function isTurnRecord(value: unknown): value is ChatTurnRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Partial<ChatTurnRecord>;
  return (
    typeof rec.envelope === 'object' &&
    rec.envelope !== null &&
    Array.isArray(rec.transcript)
  );
}

/**
 * Load all turns for a thread: the finalized JSONL log plus the single
 * in-progress turn (if a streaming save or a crash left one). Returns an
 * empty array when the canvas id is missing or no JSONL log exists
 * (legacy `.json` Context files are intentionally not read here).
 */
export function loadTurns(
  threadId: string,
  canvasId?: string,
): ChatTurnRecord[] {
  if (!canvasId) return [];
  const turns = readJsonLines<ChatTurnRecord>(
    chatTurnsPath(canvasId, threadId),
  ).filter(isTurnRecord);
  const active = readActiveTurn(threadId, canvasId);
  if (active) turns.push(active);
  return turns;
}

/**
 * Append a finalized turn to the JSONL log. No-op when `canvasId` is
 * missing. Callers should {@link clearActiveTurn} after a successful
 * append so the active sidecar does not double-count the turn.
 */
export function appendTurn(
  threadId: string,
  turn: ChatTurnRecord,
  canvasId?: string,
): void {
  if (!canvasId) return;
  mkdirp(chatDir(canvasId));
  appendJsonLine(chatTurnsPath(canvasId, threadId), turn);
}

/** Read the in-progress turn, or `null` when none / invalid. */
export function readActiveTurn(
  threadId: string,
  canvasId?: string,
): ChatTurnRecord | null {
  if (!canvasId) return null;
  const turn = readJson<unknown>(chatActiveTurnPath(canvasId, threadId));
  return isTurnRecord(turn) ? turn : null;
}

/**
 * Write (overwrite) the in-progress turn. Called on each debounced
 * streaming save so a mid-generation reload still shows partial
 * progress. No-op when `canvasId` is missing.
 */
export function writeActiveTurn(
  threadId: string,
  turn: ChatTurnRecord,
  canvasId?: string,
): void {
  if (!canvasId) return;
  mkdirp(chatDir(canvasId));
  atomicWriteJson(chatActiveTurnPath(canvasId, threadId), turn);
}

/** Delete the in-progress turn sidecar, if present. */
export function clearActiveTurn(threadId: string, canvasId?: string): void {
  if (!canvasId) return;
  const p = chatActiveTurnPath(canvasId, threadId);
  if (existsSync(p)) rmSync(p, { force: true });
}

/**
 * Finalize the in-progress turn: append it to the JSONL log and clear
 * the sidecar. No-op when there is no active turn. Used both on normal
 * turn completion and to commit a crash-leftover active turn before a
 * new turn begins.
 */
export function finalizeActiveTurn(threadId: string, canvasId?: string): void {
  if (!canvasId) return;
  const active = readActiveTurn(threadId, canvasId);
  if (!active) return;
  appendTurn(threadId, active, canvasId);
  clearActiveTurn(threadId, canvasId);
}
