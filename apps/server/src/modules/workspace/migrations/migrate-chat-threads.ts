// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Legacy chat-thread migration — pi-ai `Context` → structured turns.
 *
 * One-shot, idempotent, launch-only. Old threads were saved as a flat
 * `<threadId>.json` pi-ai `Context` (messages array, selection/skills
 * smuggled into `[SYSTEM …]` user rows). This rewrites each into the
 * envelope-based `<threadId>.turns.jsonl` so续聊不丢历史, then renames
 * the legacy `.json` to `.json.bak`. Once every workspace is migrated
 * this whole module + the route's read-only fallback can be deleted.
 *
 * Lossy by necessity: only `user.text` + selection ids/refs survive;
 * skills, attachments, neighbourhood, ACP overlay were never stored
 * in the old format. User/assistant ORDER is preserved exactly by
 * walking messages in sequence.
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  atomicWriteText,
  mkdirp,
  readJsonStrict,
  readJsonLinesStrict,
} from '../../../utils/fs.js';
import { getLogger } from '../../../utils/logger.js';
import { buildAgentNodePreview } from '../../agent/node-ref.js';

import type { LegacyChatTurnRecord as ChatTurnRecord } from './legacy/chat-turn-record.js';
import type { ChatEnvelope } from '../../agent/conversation/envelope.js';
import type { Context } from '@earendil-works/pi-ai';
import type { CanvasNodeType } from '@huabu/shared';

type PiMessage = Context['messages'][number];

const log = getLogger('migrate-chat-threads');

/**
 * Whether a parsed value carries the legacy Context's message array.
 *
 * Deliberately shallow. These files were written by *older* builds against
 * older pi-ai versions, so a row that does not match today's `Message` union
 * is the expected case, not a corruption signal — and
 * {@link legacyContextToTurns} already tolerates unrecognised rows (it copies
 * them into the open turn's transcript verbatim). Validating every row instead
 * would make one unfamiliar message discard the whole thread's history, which
 * is the opposite of what a migration is for.
 */
function isLegacyChatContext(value: unknown): value is Context {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray((value as { messages?: unknown }).messages);
}

/** Trailing tag carrying the explicitly-selected top-level ids. */
const SELECTED_IDS_RE = /\n?\[SYSTEM selectedNodeIds:(\[[^\]]*\])\]\s*$/;

/** Read the flat text of a (possibly multipart) user message. */
function userText(msg: PiMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' && b !== null && b.type === 'text',
      )
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Parse the `[SYSTEM Context]\n[Selected Nodes …]\n[ … ]` JSON block. */
function parseSelectedNodes(
  text: string,
): { id: string; type: string; label?: string }[] {
  const start = text.indexOf('[\n');
  if (start === -1) return [];
  try {
    const arr = JSON.parse(text.slice(start)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((n) =>
      n &&
      typeof n === 'object' &&
      typeof (n as { id?: unknown }).id === 'string'
        ? [n as { id: string; type: string; label?: string }]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * Convert one legacy `Context` into a list of {@link ChatTurnRecord}.
 * A turn opens on each real (non-`[SYSTEM]`) user message; the prior
 * `[Selected Nodes …]` block + trailing `[SYSTEM selectedNodeIds:…]`
 * tag seed its selection; subsequent assistant/tool messages (and
 * `[SYSTEM Error/Interrupted]` rows) form its transcript.
 */
export function legacyContextToTurns(ctx: Context): ChatTurnRecord[] {
  const turns: ChatTurnRecord[] = [];
  let cur: ChatTurnRecord | null = null;
  let pendingSelection: { id: string; type: string; label?: string }[] = [];

  for (const row of ctx.messages as readonly unknown[]) {
    // The admission gate only checked that `messages` is an array, so a row
    // that is not an object at all reaches here. Skip it: one junk row must
    // not cost the thread its remaining turns.
    if (typeof row !== 'object' || row === null) continue;
    const msg = row as PiMessage;
    if (msg.role === 'user') {
      const text = userText(msg);
      const trimmed = text.trim();
      // System-injected context rows: capture selection, never a turn.
      if (trimmed.startsWith('[SYSTEM') || trimmed.startsWith('[Selected')) {
        const sel = parseSelectedNodes(text);
        if (sel.length > 0) pendingSelection = sel;
        if (cur && trimmed.startsWith('[SYSTEM Error]')) {
          cur.transcript.push(msg);
        } else if (cur && trimmed.startsWith('[SYSTEM Interrupted]')) {
          cur.transcript.push(msg);
        }
        continue;
      }
      // Real user message → new turn. Strip trailing selectedNodeIds tag.
      const cleanText = text.replace(SELECTED_IDS_RE, '').trim();
      const selectedIds = pendingSelection.map((n) => n.id);
      const refs = pendingSelection.map((n) =>
        buildAgentNodePreview({
          id: n.id,
          type: n.type as CanvasNodeType,
          label: n.label,
        }),
      );
      const envelope: ChatEnvelope = {
        user: { text: cleanText, attachments: [] },
        skills: { invokedIds: [], resolved: [] },
        focus: {
          selection: {
            refs,
            selectedIds,
            imageAttachments: [],
            snapshotAttachments: [],
          },
        },
      };
      cur = { envelope, transcript: [] };
      turns.push(cur);
      pendingSelection = [];
    } else if (cur) {
      // assistant / toolResult belong to the open turn's transcript.
      cur.transcript.push(msg);
    }
  }
  return turns;
}

function encodeTurns(turns: readonly ChatTurnRecord[]): string {
  if (turns.length === 0) return '';
  return `${turns.map((turn) => JSON.stringify(turn)).join('\n')}\n`;
}

/**
 * Suffix for a legacy Context that coexists with a turn log it does not
 * explain. Distinct from `.bak` so the two retirement reasons stay legible on
 * disk: `.bak` means "converted, superseded", this means "kept verbatim,
 * never converted".
 */
const UNRESOLVED_SUFFIX = '.unresolved';

/**
 * Migrate one thread file in place. Returns true when the legacy source was
 * retired.
 *
 * Three coexistence cases, all of which must terminate — a thread that keeps
 * both formats forever is a thread whose history never reaches `chat_v2`:
 *
 *   - The existing log is a prefix of the conversion (a launch that wrote some
 *     turns and then died before the rename): complete it atomically.
 *   - The conversion is a prefix of the existing log (a newer tail followed a
 *     complete conversion): leave the log alone.
 *   - Neither is a prefix of the other. The two logs are independent
 *     representations — the `.turns.jsonl` was written by the live app, not
 *     derived from this Context — so their combined ordering cannot be
 *     inferred, and guessing it would silently corrupt the transcript. The
 *     live log wins because it is the one the app has been appending to; the
 *     Context is preserved beside it under {@link UNRESOLVED_SUFFIX} and the
 *     divergence is logged. Its extra turns stay off the canvas, which is
 *     also what happened before this reconciliation existed — but the bytes
 *     remain, and the turn log is now free to fold into `chat_v2`.
 */
export function migrateLegacyThreadFile(jsonPath: string): boolean {
  const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
  const ctx = readJsonStrict<unknown>(jsonPath);
  if (!isLegacyChatContext(ctx)) return false;
  const turns = legacyContextToTurns(ctx);

  if (existsSync(turnsPath)) {
    const existing = readJsonLinesStrict<unknown>(turnsPath);
    const overlap = Math.min(existing.length, turns.length);
    let commonPrefix = 0;
    while (
      commonPrefix < overlap &&
      isDeepStrictEqual(existing[commonPrefix], turns[commonPrefix])
    ) {
      commonPrefix += 1;
    }
    if (commonPrefix < overlap) {
      const preserved = `${jsonPath}${UNRESOLVED_SUFFIX}`;
      log.warn(
        { jsonPath, turnsPath, preserved, divergedAtTurn: commonPrefix + 1 },
        'Legacy chat Context diverges from its turn log; preserving the ' +
          'Context unconverted and keeping the turn log as written',
      );
      renameSync(jsonPath, preserved);
      return true;
    }
    if (existing.length < turns.length) {
      atomicWriteText(turnsPath, encodeTurns(turns));
    }
  } else {
    atomicWriteText(turnsPath, encodeTurns(turns));
  }

  renameSync(jsonPath, `${jsonPath}.bak`);
  return true;
}

/**
 * Walk every canvas's `.history/chat/` and migrate legacy `.json`
 * threads. Skips `.parts.json` sidecars and anything already migrated.
 */
export function migrateLegacyChatThreads(workspace: string): void {
  let canvasDirs: string[];
  try {
    canvasDirs = readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(workspace, e.name));
  } catch {
    return;
  }
  for (const dir of canvasDirs) {
    const chatDir = path.join(dir, '.history', 'chat');
    if (!existsSync(chatDir)) continue;
    mkdirp(chatDir);
    for (const file of readdirSync(chatDir)) {
      // Only legacy pi-ai `Context` files: skip the new-format sidecars
      // (`.parts.json`, `.active.json`) so a re-run never mistakes an
      // in-progress turn for a thread to migrate.
      if (
        !file.endsWith('.json') ||
        file.endsWith('.parts.json') ||
        file.endsWith('.active.json')
      ) {
        continue;
      }
      const jsonPath = path.join(chatDir, file);
      try {
        migrateLegacyThreadFile(jsonPath);
      } catch (err) {
        // Tolerant per-file migration: one damaged thread never aborts the
        // batch. The Context stays on disk untouched, and hop 2 still folds
        // any turn log beside it, so the thread keeps whatever history it
        // already had in the new format. Logged because the alternative is a
        // thread that silently never migrates.
        log.warn(
          { err, jsonPath },
          'Legacy chat thread could not be migrated; leaving it in place',
        );
      }
    }
  }
}
