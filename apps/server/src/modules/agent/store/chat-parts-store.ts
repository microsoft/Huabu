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
 * working) and records every rich-ACP extension separately, indexed
 * by `messageIndex` so the future history reconstruction layer can
 * merge by position. A thread that never used ACP simply has no
 * `.parts.json` file — zero overhead.
 *
 * ### File layout
 *
 *   <canvasDir>/.history/chat/<threadId>.json        ← pi-ai Context (existing)
 *   <canvasDir>/.history/chat/<threadId>.parts.json  ← THIS module
 *
 * ### Schema versioning
 *
 * `schemaVersion: 1` is recorded on every file so future migrations
 * (e.g. compaction, field renames) can detect old files. Bump only
 * on a breaking shape change.
 *
 * ### Mutator semantics
 *
 * All mutator helpers (`appendPlanPart`, `upsertToolExt`,
 * `setToolPermission`) return a NEW sidecar object — never mutate
 * the input. Callers compose mutators in their own update cycle
 * (typically `read → mutate → write`). Atomicity is the caller's
 * responsibility; in practice the SSE handler in `acp/service.ts`
 * runs single-threaded per turn, so no locking is needed.
 *
 * ### Trust boundary
 *
 * Sidecar files live on the local filesystem and are user-editable.
 * `readChatParts` validates with `safeParseSidecar` and returns
 * `null` (treated as "no sidecar yet") rather than throwing — a
 * corrupt sidecar should not brick chat history.
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

// ─── Schema ───────────────────────────────────────────────────────────

/**
 * One entry in `ChatPartsSidecar.parts`. Two kinds today:
 *
 *   - `plan` — full plan replacement at a given assistant turn.
 *   - `tool_acp_ext` — ACP enrichment fields for a single tool call
 *     within an assistant turn. Indexed by `toolCallId` so subsequent
 *     `tool_call_update` notifications can find and merge into the
 *     same entry.
 *
 * `messageIndex` is the position in the pi-ai `Context.messages`
 * array (0-based). `partIndex` is the position within that
 * assistant message's parts (0-based) — pre-reserved for the future
 * multi-segment reconstruction layer. Today every writer uses
 * `partIndex: 0`; treat it as a stable intra-message ordering key.
 */
export type SidecarPart =
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
 * via `mergeToolExtension`. Replace-semantics fields (`status`,
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

/** Full on-disk shape of a chat-parts sidecar. */
export interface ChatPartsSidecar {
  /** Bump on a breaking shape change. */
  schemaVersion: 1;
  /** Rich-ACP overlay entries, in insertion order. */
  parts: SidecarPart[];
  /**
   * Wall-clock millis of each `Context.messages[i]`'s arrival, in
   * parallel index with the pi-ai file. Optional helper that lets
   * the UI render timestamps without re-deriving them from message
   * content. Empty for back-compat (older sidecars without it).
   */
  messageTimestamps: number[];
}

/** Construct an empty sidecar. */
export function emptySidecar(): ChatPartsSidecar {
  return { schemaVersion: 1, parts: [], messageTimestamps: [] };
}

// ─── Validation ───────────────────────────────────────────────────────
//
// Lightweight structural check — full zod validation would force a
// dependency from server storage onto SDK zod schemas, and the
// sidecar is internal-only (we control all writers). A best-effort
// shape check is enough to guard against truncated / hand-edited
// files. Returns the typed value or null.

function isSidecar(value: unknown): value is ChatPartsSidecar {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ChatPartsSidecar>;
  if (v.schemaVersion !== 1) return false;
  if (!Array.isArray(v.parts)) return false;
  if (!Array.isArray(v.messageTimestamps)) return false;
  return true;
}

// ─── I/O ──────────────────────────────────────────────────────────────

/**
 * Read the sidecar for `threadId`. Returns `null` when:
 *   - `canvasId` is missing
 *   - the file does not exist (first ACP turn on a fresh thread)
 *   - the file is corrupt / wrong shape (do NOT throw — let the
 *     caller treat it as "empty sidecar")
 */
export function readChatParts(
  threadId: string,
  canvasId?: string,
): ChatPartsSidecar | null {
  if (!canvasId) return null;
  const raw = readJson<unknown>(chatPartsPath(canvasId, threadId));
  if (raw === null) return null;
  return isSidecar(raw) ? raw : null;
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
 * Append a `plan` part at `messageIndex`. Plans use full-replacement
 * semantics on the wire, so if a plan already exists at the same
 * (messageIndex, partIndex) we REPLACE its entries.
 */
export function appendPlanPart(
  sidecar: ChatPartsSidecar,
  messageIndex: number,
  entries: AcpPlanEntry[],
  partIndex = 0,
): ChatPartsSidecar {
  const idx = sidecar.parts.findIndex(
    (p) =>
      p.kind === 'plan' &&
      p.messageIndex === messageIndex &&
      p.partIndex === partIndex,
  );
  const next: SidecarPart = {
    kind: 'plan',
    messageIndex,
    partIndex,
    entries,
  };
  if (idx === -1) {
    return { ...sidecar, parts: [...sidecar.parts, next] };
  }
  const parts = [...sidecar.parts];
  parts[idx] = next;
  return { ...sidecar, parts };
}

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
 * Upsert a `tool_acp_ext` part for the given `toolCallId`. If an
 * entry already exists, the new `extension` is merged in
 * (see {@link mergeToolExtension}); otherwise a new part is appended
 * at the supplied `messageIndex` / `partIndex`.
 *
 * `messageIndex` is only used when creating a new entry; updates
 * never change the index of an existing one.
 */
export function upsertToolExt(
  sidecar: ChatPartsSidecar,
  toolCallId: string,
  extension: ToolAcpExtension,
  options: { messageIndex: number; partIndex?: number },
): ChatPartsSidecar {
  const idx = sidecar.parts.findIndex(
    (p) => p.kind === 'tool_acp_ext' && p.toolCallId === toolCallId,
  );
  if (idx === -1) {
    const part: SidecarPart = {
      kind: 'tool_acp_ext',
      messageIndex: options.messageIndex,
      partIndex: options.partIndex ?? 0,
      toolCallId,
      extension,
    };
    return { ...sidecar, parts: [...sidecar.parts, part] };
  }
  const existing = sidecar.parts[idx];
  if (existing.kind !== 'tool_acp_ext') return sidecar; // narrow for TS
  const parts = [...sidecar.parts];
  parts[idx] = {
    ...existing,
    extension: mergeToolExtension(existing.extension, extension),
  };
  return { ...sidecar, parts };
}

/**
 * Record the final permission decision for the given tool call.
 * Equivalent to `upsertToolExt(sidecar, toolCallId, { permission },
 * { messageIndex })` but stays a separate helper so the auto-allow /
 * UI-gate handler can call it without knowing the position of the
 * tool call within the message.
 *
 * Returns the sidecar unchanged when no matching `tool_acp_ext`
 * entry exists (the agent emitted a permission decision before the
 * `tool_call` event — should not happen per ACP spec, but defensive).
 */
export function setToolPermission(
  sidecar: ChatPartsSidecar,
  toolCallId: string,
  permission: ToolPermissionState,
): ChatPartsSidecar {
  const idx = sidecar.parts.findIndex(
    (p) => p.kind === 'tool_acp_ext' && p.toolCallId === toolCallId,
  );
  if (idx === -1) return sidecar;
  const existing = sidecar.parts[idx];
  if (existing.kind !== 'tool_acp_ext') return sidecar;
  const parts = [...sidecar.parts];
  parts[idx] = {
    ...existing,
    extension: { ...existing.extension, permission },
  };
  return { ...sidecar, parts };
}

/**
 * Append a wall-clock timestamp at `messageIndex`. Skip the write if
 * an entry already exists at that index (first-write-wins — message
 * arrival time, not last-edit time).
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
