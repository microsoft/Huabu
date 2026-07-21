/**
 * Synchronous, on-disk workspace preparation.
 *
 * Runtime workspace switches execute this function in a disposable child
 * process so a slow virtual filesystem cannot block the Server event loop.
 * Startup and tests may still call it in-process through `setWorkspacePath`.
 */

import { mkdirSync } from 'node:fs';

import { migrateLegacyAcpSessions } from './storage/migrate-acp-sessions.js';
import { migrateLegacyAgenetesThreads } from './storage/migrate-agenetes-threads.js';
import { migrateCanvasToSpace } from './storage/migrate-canvas-to-space.js';
import { migrateLegacyChatThreads } from './storage/migrate-chat-threads.js';
import { migrateLegacyChatTurns } from './storage/migrate-chat-turns.js';

/** Prepare and migrate a resolved absolute workspace path on disk. */
export function prepareWorkspaceOnDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  migrateCanvasToSpace(workspacePath);
  migrateLegacyChatThreads(workspacePath);
  migrateLegacyChatTurns(workspacePath);
  migrateLegacyAgenetesThreads(workspacePath);
  migrateLegacyAcpSessions(workspacePath);
}