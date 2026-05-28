/**
 * Chat-parts sidecar — rich-ACP overlay paired with each pi-ai
 * `Context` chat file.
 *
 * ### Why a sidecar (and not extending the pi-ai Context)?
 *
 * pi-ai's `Context.messages` is a CLOSED, append-only union of
 * `(UserMessage | AssistantMessage | ToolResultMessage)`. Each
 * variant has a fixed schema (`content` shape, `role`, etc.) that
 * pi-ai validates. We cannot smuggle ACP-specific fields like
 * `plan.entries`, `toolKind`, `permission.outcome` into those
 * messages without forking pi-ai or losing replay compatibility
 * across canvases.
 *
 * The sidecar keeps the pi-ai file 100 % pi-ai-compliant (so existing
 * `loadContext`/`saveContext` and pi-ai's own re-runners keep
 * working) and records every rich-ACP extension separately, keyed by
 * STABLE IDS (`toolCallId` for tool extras, wall-clock millis of the
 * owning assistant message for plans). A thread that never used ACP
 * simply has no `.parts.json` file — zero overhead.
 *
 * ### File layout
 *
 *   <canvasDir>/.history/chat/<threadId>.json        ← pi-ai Context (existing)
 *   <canvasDir>/.history/chat/<threadId>.parts.json  ← THIS module
 *
 * ### Schema versioning
 *
 * `schemaVersion: 2` is recorded on every file. The v1 → v2 upgrade
 * dropped positional `messageIndex`/`partIndex` keys in favour of
 * stable ids; legacy v1 files are read transparently via
 * {@link migrateV1ToV2} and rewritten as v2 on the next save.
 *
 * Bump only on a breaking shape change.
 *
 * ### Mutator semantics
 *
 * All mutator helpers (`setPlanForMessage`, `upsertToolExt`,
 * `setToolPermission`, `recordMessageTimestamp`) return a NEW sidecar
 * object — never mutate the input. Callers compose mutators in their
 * own update cycle (typically `read → mutate → write`). Atomicity is
 * the caller's responsibility; in practice the SSE handler in
 * `acp/service.ts` runs single-threaded per turn, so no locking is
 * needed.
 *
 * ### Trust boundary
 *
 * Sidecar files live on the local filesystem and are user-editable.
 * `readChatParts` validates via {@link isSidecarV1} / {@link isSidecarV2}
 * and returns `null` (treated as "no sidecar yet") rather than
 * throwing — a corrupt sidecar should not brick chat history.
 */

import { existsSync } from 'node:fs';

import { atomicWriteJson, mkdirp, readJson } from '../../storage/io.js';
import { chatDir, chatPartsPath } from '../../storage/paths.js';

import type {
  AcpPlanEntry,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
  ToolPermissionState,
} from '@sediment/shared';

// ─── ToolAcpExtension (shared by v1/v2) ───────────────────────────────

/**
 * The ACP-specific subset of a `tool_call` / `tool_call_update`
 * payload that does NOT round-trip through pi-ai's `ToolResultMessage`.
 *
 * The pi-ai message keeps the raw JSON output (so reruns work);
 * this struct preserves the semantic envelope (`toolKind`, lifecycle
 * `status`, source `locations`, structured `content` blocks) plus
 * any permission decision recorded by the auto-allow handler.
 *
 * Append-only fields (`locations`, `content`) merge with prior values
 * via {@link mergeToolExtension}. Replace-semantics fields (`status`,
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

// ─── v2 schema (current) ──────────────────────────────────────────────

/**
 * Full on-disk shape of a chat-parts sidecar.
 *
 * v2 keys every overlay by a stable id:
 *  - `toolExtras` — keyed by `toolCallId` (per-call uuid from the
 *    agent, survives re-orderings and replays).
 *  - `planByMessageTimestamp` — keyed by `String(messageTimestamp)`
 *    of the assistant message that emitted the plan. Plans are
 *    full-replacement on the wire, so a single entry per message
 *    is correct.
 *
 * `messageTimestamps` remains a sparse array indexed by pi-ai
 * `Context.messages` position. It is an auxiliary lookup used by the
 * history builder to find each assistant message's timestamp; v1
 * migration also relies on it (see {@link migrateV1ToV2}).
 */
export interface ChatPartsSidecar {
  /** Bump on a breaking shape change. */
  schemaVersion: 2;
  /** ACP tool extensions, keyed by `toolCallId`. */
  toolExtras: Record<string, ToolAcpExtension>;
  /** Plan entries, keyed by `String(messageTimestamp)` of the owning assistant message. */
  planByMessageTimestamp: Record<string, AcpPlanEntry[]>;
  /**
   * Wall-clock millis of each `Context.messages[i]`'s arrival, in
   * parallel index with the pi-ai file. Sparse — gaps are `0`.
   * Used both for UI timestamps and as the lookup table that
   * resolves a `messageIndex` to a `messageTimestamp` (e.g. when
   * the history builder wants the plan associated with the
   * current assistant turn). Empty for back-compat (older sidecars
   * without it).
   */
  messageTimestamps: number[];
}

/** Construct an empty sidecar. */
export function emptySidecar(): ChatPartsSidecar {
  return {
    schemaVersion: 2,
    toolExtras: {},
    planByMessageTimestamp: {},
    messageTimestamps: [],
  };
}

// ─── v1 schema (read-only, for migration) ─────────────────────────────
//
// Kept inline (not exported) so old files on disk still parse. We
// do not write v1 again — `writeChatParts` always produces v2.

type SidecarPartV1 =
  | {
      kind: 'plan';
      messageIndex: number;
      partIndex: number;
      entries: AcpPlanEntry[];
    }
  | {
      kind: 'tool_acp_ext';
      messageIndex: number;
      partIndex: number;
      toolCallId: string;
      extension: ToolAcpExtension;
    };

interface ChatPartsSidecarV1 {
  schemaVersion: 1;
  parts: SidecarPartV1[];
  messageTimestamps: number[];
}

// ─── Validation ───────────────────────────────────────────────────────
//
// Lightweight structural checks — full zod validation would force a
// dependency from server storage onto SDK zod schemas, and the
// sidecar is internal-only (we control all writers). A best-effort
// shape check is enough to guard against truncated / hand-edited
// files.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isSidecarV2(value: unknown): value is ChatPartsSidecar {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 2) return false;
  if (!isPlainObject(value.toolExtras)) return false;
  if (!isPlainObject(value.planByMessageTimestamp)) return false;
  if (!Array.isArray(value.messageTimestamps)) return false;
  return true;
}

function isSidecarV1(value: unknown): value is ChatPartsSidecarV1 {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.parts)) return false;
  if (!Array.isArray(value.messageTimestamps)) return false;
  return true;
}

/**
 * Translate a v1 sidecar to v2 in-memory. Tool extensions port 1:1
 * via `toolCallId`. Plans require a `messageIndex → timestamp`
 * lookup through `messageTimestamps`; entries whose owning message
 * has no recorded timestamp (`0` / out-of-range) are dropped — they
 * would have no stable key in v2 and re-acquiring them isn't worth
 * a fragile fallback.
 */
function migrateV1ToV2(v1: ChatPartsSidecarV1): ChatPartsSidecar {
  const toolExtras: Record<string, ToolAcpExtension> = {};
  const planByMessageTimestamp: Record<string, AcpPlanEntry[]> = {};
  for (const part of v1.parts) {
    if (part.kind === 'tool_acp_ext') {
      // Last-write-wins on toolCallId collision — v1 used append
      // semantics with merge, but the final state on disk should
      // already reflect that merge, so a duplicate id signals a
      // corrupt file. Take the latest entry.
      toolExtras[part.toolCallId] = part.extension;
    } else if (part.kind === 'plan') {
      const ts = v1.messageTimestamps[part.messageIndex];
      if (typeof ts === 'number' && ts > 0) {
        planByMessageTimestamp[String(ts)] = part.entries;
      }
    }
  }
  return {
    schemaVersion: 2,
    toolExtras,
    planByMessageTimestamp,
    messageTimestamps: v1.messageTimestamps,
  };
}

// ─── I/O ──────────────────────────────────────────────────────────────

/**
 * Read the sidecar for `threadId`. Returns `null` when:
 *   - `canvasId` is missing
 *   - the file does not exist (first ACP turn on a fresh thread)
 *   - the file is corrupt / wrong shape (do NOT throw — let the
 *     caller treat it as "empty sidecar")
 *
 * v1 files are migrated to v2 in-memory; the upgrade is persisted
 * on the next `writeChatParts` call.
 */
export function readChatParts(
  threadId: string,
  canvasId?: string,
): ChatPartsSidecar | null {
  if (!canvasId) return null;
  const raw = readJson<unknown>(chatPartsPath(canvasId, threadId));
  if (raw === null) return null;
  if (isSidecarV2(raw)) return raw;
  if (isSidecarV1(raw)) return migrateV1ToV2(raw);
  return null;
}

/**
 * Write `sidecar` atomically to the sidecar file. No-op when
 * `canvasId` is missing (mirrors `chat-store.ts` `saveContext`
 * semantics so ad-hoc / unbound threads stay zero-cost).
 */
export function writeChatParts(
  threadId: string,
  sidecar: ChatPartsSidecar,
  canvasId?: string,
): void {
  if (!canvasId) return;
  mkdirp(chatDir(canvasId));
  atomicWriteJson(chatPartsPath(canvasId, threadId), sidecar);
}

/** True if a sidecar file exists for this thread. Cheap stat-only check. */
export function hasChatParts(threadId: string, canvasId?: string): boolean {
  if (!canvasId) return false;
  return existsSync(chatPartsPath(canvasId, threadId));
}

// ─── Mutator helpers (pure) ───────────────────────────────────────────
//
// All helpers return a NEW sidecar value. No in-place mutation —
// simplifies reasoning when callers want optimistic update + retry
// on write conflicts.

/**
 * Merge two `ToolAcpExtension` values. Append-only fields
 * (`locations`, `content`) concatenate; replace-semantics fields
 * (`status`, `toolKind`, `rawOutput`, `permission`) overwrite when
 * the new value is defined.
 */
function mergeToolExtension(
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
 * Upsert a `ToolAcpExtension` for the given `toolCallId`. If an
 * entry already exists, the new extension is merged in
 * (see {@link mergeToolExtension}); otherwise a new entry is added.
 */
export function upsertToolExt(
  sidecar: ChatPartsSidecar,
  toolCallId: string,
  extension: ToolAcpExtension,
): ChatPartsSidecar {
  const prev = sidecar.toolExtras[toolCallId];
  const merged = prev ? mergeToolExtension(prev, extension) : extension;
  return {
    ...sidecar,
    toolExtras: { ...sidecar.toolExtras, [toolCallId]: merged },
  };
}

/**
 * Record the final permission decision for the given tool call.
 * Returns the sidecar unchanged when no matching extension exists
 * (the agent emitted a permission decision before the `tool_call`
 * event — should not happen per ACP spec, but defensive).
 */
export function setToolPermission(
  sidecar: ChatPartsSidecar,
  toolCallId: string,
  permission: ToolPermissionState,
): ChatPartsSidecar {
  const prev = sidecar.toolExtras[toolCallId];
  if (!prev) return sidecar;
  return {
    ...sidecar,
    toolExtras: {
      ...sidecar.toolExtras,
      [toolCallId]: { ...prev, permission },
    },
  };
}

/**
 * Set the plan entries for the assistant message whose arrival
 * timestamp is `messageTimestamp`. Plans use full-replacement
 * semantics on the wire, so the new entries always overwrite.
 *
 * The caller (acp/service.ts) is expected to call this only AFTER
 * the assistant push completes and `recordMessageTimestamp` has
 * stamped the sidecar, so `messageTimestamp` is the same value the
 * UI will see.
 */
export function setPlanForMessage(
  sidecar: ChatPartsSidecar,
  messageTimestamp: number,
  entries: AcpPlanEntry[],
): ChatPartsSidecar {
  const key = String(messageTimestamp);
  return {
    ...sidecar,
    planByMessageTimestamp: {
      ...sidecar.planByMessageTimestamp,
      [key]: entries,
    },
  };
}

/**
 * Record a wall-clock arrival timestamp at `messageIndex`. Skip the
 * write if an entry already exists at that index (first-write-wins —
 * message arrival time, not last-edit time).
 */
export function recordMessageTimestamp(
  sidecar: ChatPartsSidecar,
  messageIndex: number,
  timestamp: number,
): ChatPartsSidecar {
  if (sidecar.messageTimestamps[messageIndex] !== undefined) return sidecar;
  const messageTimestamps = sidecar.messageTimestamps.slice();
  // Pad sparsely if the index is beyond the current array length.
  while (messageTimestamps.length < messageIndex) {
    messageTimestamps.push(0);
  }
  messageTimestamps[messageIndex] = timestamp;
  return { ...sidecar, messageTimestamps };
}
