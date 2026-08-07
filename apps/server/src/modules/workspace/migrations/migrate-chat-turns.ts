/**
 * Legacy chat-turn migration (M6.9 row 2) — the second hop of the chat
 * history migration chain.
 *
 * The first hop (`migrateLegacyChatThreads`) converts the oldest pi-ai
 * `Context` `.json` files into the envelope-based
 * `<canvasDir>/.history/chat/<threadId>.turns.jsonl` log. This hop folds
 * that legacy per-turn log forward into the new Agenetes two-tier log's
 * Tier-2 store at `<canvasDir>/.history/chat_v2/<threadId>.turns.jsonl`
 * (the folded `AgentTurn`s `history()` reads back), then renames each
 * consumed legacy log to `.turns.jsonl.bak`.
 *
 * ### Tier-2 only
 *
 * `history()` reads ONLY the Tier-2 folded turns (`turn-store.ts`); the
 * Tier-1 `.events.jsonl` is the live delta log a running turn appends and
 * is never reconstructed for a historical turn. So this migrator emits only
 * Tier-2 records. Each folded turn pins an EMPTY Tier-1 range
 * (`seqStart > seqEnd`, i.e. `1 > 0`): it folded no live events, and a live
 * tail resuming the thread starts from the very first event.
 *
 * ### Idempotent, launch-only
 *
 * Skips any thread whose `chat_v2` log already exists, and renames each
 * source log to `.bak` on success, so a re-run never double-writes. One bad
 * thread never aborts the batch. The frozen {@link LegacyChatTurnRecord}
 * descriptor (never the live chat-store types) is the only dependency on
 * the old shape.
 */

import { existsSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import { FileTurnStore } from '@agenetes/agenetes';

import { isLegacyChatTurnRecord } from './legacy/chat-turn-record.js';
import { legacyChatTurnToAgentTurn } from './legacy/fold-legacy-turn.js';
import { readJsonLines } from '../../../utils/fs.js';

import type { PersistedTurn } from '@agenetes/agenetes';
import type { Namespace } from '@agenetes/protocol';

const LEGACY_SUFFIX = '.turns.jsonl';

/**
 * Migrate one legacy `<threadId>.turns.jsonl` into the thread's `chat_v2`
 * Tier-2 log. Returns true when migrated. No-op (returns false) when the
 * target already exists or the source has no valid turns.
 */
export function migrateLegacyTurnFile(
  turnStore: FileTurnStore,
  namespace: Namespace,
  threadId: string,
  legacyPath: string,
): boolean {
  const target = path.join(
    namespace.storage!.root,
    'chat_v2',
    `${threadId}${LEGACY_SUFFIX}`,
  );
  if (existsSync(target)) return false; // already migrated

  const records = readJsonLines<unknown>(legacyPath).filter(
    isLegacyChatTurnRecord,
  );
  if (records.length === 0) {
    // Nothing to fold, but still retire the source so it is not re-scanned.
    renameSync(legacyPath, `${legacyPath}.bak`);
    return false;
  }

  for (const record of records) {
    const persisted: PersistedTurn = {
      turn: legacyChatTurnToAgentTurn(record),
      // Empty Tier-1 range: a migrated turn folded no live events.
      seqStart: 1,
      seqEnd: 0,
    };
    turnStore.append(namespace, threadId, persisted);
  }
  renameSync(legacyPath, `${legacyPath}.bak`);
  return true;
}

/**
 * Walk every canvas's `.history/chat/` and migrate legacy
 * `<threadId>.turns.jsonl` logs into the `chat_v2` Tier-2 store. The
 * per-canvas namespace uses the on-disk `<canvasDir>/.history` directly as
 * `storage.root`, so the migrated `chat_v2/` files land exactly where the
 * live reader (`canvasAcpNamespace(canvasId)`, whose root is the same
 * `.history`) looks — sidestepping any canvasId↔directory-name encoding.
 */
export function migrateLegacyChatTurns(workspace: string): void {
  let canvasDirs: string[];
  try {
    canvasDirs = readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  const turnStore = new FileTurnStore();

  for (const name of canvasDirs) {
    const historyRoot = path.join(workspace, name, '.history');
    const chatDir = path.join(historyRoot, 'chat');
    if (!existsSync(chatDir)) continue;
    const namespace: Namespace = { name, storage: { root: historyRoot } };

    let files: string[];
    try {
      files = readdirSync(chatDir);
    } catch {
      continue;
    }
    for (const file of files) {
      // Only legacy per-turn logs; skip the in-progress `.active.json`
      // sidecar, already-retired `.bak` files, and anything else.
      if (!file.endsWith(LEGACY_SUFFIX)) continue;
      const threadId = file.slice(0, -LEGACY_SUFFIX.length);
      try {
        migrateLegacyTurnFile(
          turnStore,
          namespace,
          threadId,
          path.join(chatDir, file),
        );
      } catch {
        // tolerant: one bad thread never aborts the batch
      }
    }
  }
}
