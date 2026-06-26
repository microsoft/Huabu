/**
 * Structured chat thread store — the source of truth for chat history
 * in the envelope-persistence model.
 *
 * ### Why a new store (and a new file)?
 *
 * The legacy {@link import('./chat-store.js')} persists a pi-ai
 * `Context` (a flat `messages` array) directly, with the user's
 * selection / skills / attachments smuggled into the message string as
 * `[SYSTEM …]` tags and recovered on reload by `stripMetadataTags`.
 * That round-trip is the cause of several papercuts (hint loss on
 * reload, `[SYSTEM]` leakage, redundant tail tags).
 *
 * This store records, per turn, the structured {@link ChatEnvelope}
 * the user contributed plus the assistant/tool transcript the agent
 * produced. The pi-ai `Context.messages` the agent runs over is then
 * *derived* on each request by re-serialising the envelopes — so the
 * `[SYSTEM …]` encoding is never the on-disk source of truth.
 *
 * ### No migration (yet)
 *
 * Records live on a distinct `.turns.json` path. Legacy `.json` pi-ai
 * `Context` files are simply ignored: a thread with no `.turns.json`
 * reads as empty and starts fresh. A migration adapter can be layered
 * on later once the new structure is proven.
 *
 * ### File layout
 *
 *   <canvasDir>/.history/chat/<threadId>.json        ← legacy pi-ai Context
 *   <canvasDir>/.history/chat/<threadId>.turns.json  ← THIS module
 *   <canvasDir>/.history/chat/<threadId>.parts.json  ← rich-ACP sidecar
 */

import { atomicWriteJson, mkdirp, readJson } from '../../storage/io.js';
import { chatDir, chatTurnsPath } from '../../storage/paths.js';

import type { ChatEnvelope } from '../context/envelope.js';
import type { Context } from '@earendil-works/pi-ai';

/** A pi-ai message as stored on a {@link Context}. */
export type PiMessage = Context['messages'][number];

/**
 * One turn: the user's structured input envelope plus the
 * assistant/tool transcript the agent produced in response.
 *
 * `transcript` holds only the messages the agent appended this turn
 * (assistant text, tool calls/results, and any `[SYSTEM Error]` /
 * `[SYSTEM Interrupted]` status rows) — NOT the re-serialisable user
 * messages, which are rebuilt from `envelope` on load.
 */
export interface ChatTurnRecord {
  envelope: ChatEnvelope;
  transcript: PiMessage[];
}

/** Current on-disk schema version for the structured thread record. */
export const CHAT_THREAD_RECORD_VERSION = 2 as const;

/** Versioned structured thread record. */
export interface ChatThreadRecord {
  version: typeof CHAT_THREAD_RECORD_VERSION;
  turns: ChatTurnRecord[];
}

function isThreadRecord(value: unknown): value is ChatThreadRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Partial<ChatThreadRecord>;
  return rec.version === CHAT_THREAD_RECORD_VERSION && Array.isArray(rec.turns);
}

/**
 * Load the structured thread record for a thread. Returns `null` when
 * the canvas id is missing, the file does not exist, or the file is
 * not a valid v2 record (legacy `.json` Context files are intentionally
 * not read here).
 */
export function loadThreadRecord(
  threadId: string,
  canvasId?: string,
): ChatThreadRecord | null {
  if (!canvasId) return null;
  const record = readJson<unknown>(chatTurnsPath(canvasId, threadId));
  return isThreadRecord(record) ? record : null;
}

/** Persist the structured thread record. No-op when `canvasId` is missing. */
export function saveThreadRecord(
  threadId: string,
  record: ChatThreadRecord,
  canvasId?: string,
): void {
  if (!canvasId) return;
  mkdirp(chatDir(canvasId));
  atomicWriteJson(chatTurnsPath(canvasId, threadId), record);
}

/** Construct an empty thread record. */
export function emptyThreadRecord(): ChatThreadRecord {
  return { version: CHAT_THREAD_RECORD_VERSION, turns: [] };
}
