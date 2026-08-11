// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Synchronous, on-disk workspace preparation.
 *
 * Runtime workspace switches execute this function in a disposable child
 * process so a slow virtual filesystem cannot block the Server event loop.
 * Startup and tests may still call it in-process through `setWorkspacePath`.
 */

import { mkdirSync } from 'node:fs';

import { recoverDiskTransactions } from './storage/backends/disk/transaction-journal.js';
import { ensureWorldCanvasOnDisk } from './workspace/disk/world-canvas.js';
import { migrateLegacyAcpSessions } from './workspace/migrations/migrate-acp-sessions.js';
import {
  migrateLegacyAgenetesThreads,
  repairExternalAgentPreambles,
} from './workspace/migrations/migrate-agenetes-threads.js';
import { migrateCanvasToSpace } from './workspace/migrations/migrate-canvas-to-space.js';
import { migrateLegacyChatThreads } from './workspace/migrations/migrate-chat-threads.js';
import { migrateLegacyChatTurns } from './workspace/migrations/migrate-chat-turns.js';
import { renderExternalAgentSystemPreamble } from '../prompt/external-agent/system-preamble.js';

/**
 * Prepare and migrate a resolved absolute workspace path on disk.
 *
 * Migration order is load-bearing — each step assumes the prior ones have run.
 * All migrations are idempotent (they leave a `.bak` on the source), so this is
 * safe to re-run on every activation.
 */
export function prepareWorkspaceOnDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  // A prepared journal describes the only safe before/after bytes. Resolve it
  // before a migration or the World initializer can observe partial state.
  recoverDiskTransactions(workspacePath);
  // Demo-stage rename: canvas.json -> space.json, .memory/canvas.md ->
  // .memory/space.md, setting/.huabu.md -> setting/user.md. Runs first so
  // later readers / migrations see the new names. DELETE-ME later.
  migrateCanvasToSpace(workspacePath);
  // Convert legacy pi-ai `Context` chat threads to structured turns
  // (`.turns.jsonl`); renames old `.json` to `.json.bak`.
  migrateLegacyChatThreads(workspacePath);
  // Second hop (M6.9 row 2): fold legacy `.history/chat/*.turns.jsonl` turns
  // into the Agenetes two-tier log (`chat_v2/`). MUST run AFTER the pi-ai
  // `.json` -> `.turns.jsonl` hop above.
  migrateLegacyChatTurns(workspacePath);
  // Convert the strict workload/state boundary before any writer opens the
  // namespace. Keeps the original v1 file as `.agenetes-v1.bak`.
  migrateLegacyAgenetesThreads(workspacePath);
  // M6.9 row 1: fold the removed `acp-sessions.json` (v3) recovery records
  // into `threads.json` `ThreadRecord`s.
  migrateLegacyAcpSessions(workspacePath);
  // Repair external Deployments persisted by pre-chat control routes without
  // the Huabu access bootstrap. The driver will deliver it on the next turn.
  repairExternalAgentPreambles(
    workspacePath,
    renderExternalAgentSystemPreamble(),
  );
  ensureWorldCanvasOnDisk(workspacePath);
}
