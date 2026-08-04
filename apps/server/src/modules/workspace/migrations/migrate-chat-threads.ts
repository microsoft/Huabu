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

import { appendJsonLine, mkdirp, readJson } from '../../../utils/fs.js';
import { buildAgentNodePreview } from '../../agent/node-ref.js';

import type { LegacyChatTurnRecord as ChatTurnRecord } from './legacy/chat-turn-record.js';
import type { ChatEnvelope } from '../../agent/conversation/envelope.js';
import type { Context } from '@earendil-works/pi-ai';
import type { CanvasNodeType } from '@sediment/shared';

type PiMessage = Context['messages'][number];

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

  for (const msg of ctx.messages) {
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

/** Migrate one thread file in place. Returns true when migrated. */
export function migrateLegacyThreadFile(jsonPath: string): boolean {
  const turnsPath = jsonPath.replace(/\.json$/, '.turns.jsonl');
  if (existsSync(turnsPath)) return false; // already on new format
  const ctx = readJson<Context>(jsonPath);
  if (!ctx || !Array.isArray(ctx.messages)) return false;
  const turns = legacyContextToTurns(ctx);
  for (const t of turns) appendJsonLine(turnsPath, t);
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
      try {
        migrateLegacyThreadFile(path.join(chatDir, file));
      } catch {
        // tolerant: one bad thread never aborts the batch
      }
    }
  }
}
