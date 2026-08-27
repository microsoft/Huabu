// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Upgrade migration from Electron's deprecated `<userData>/workspace.json`.
 *
 * The plural Workspace registry is now the sole durable owner of membership,
 * active-path restoration, and recency ordering. Desktop still tells the
 * Server where the old file lived so an upgrade can import it, but only while
 * `workspaces.json` does not exist. Once any entry creates the new registry,
 * the legacy file is never consulted again.
 *
 * Importing only *registers* membership: each remembered path is checked for a
 * directory still on disk and adopted, which writes at most the Workspace
 * manifest that identity requires. It deliberately does not prepare anything.
 * A remembered path is a claim about the past, not a request to open a folder,
 * so preparing here would recreate directories the user has since deleted and
 * run the whole on-disk migration chain against Workspaces nobody asked for.
 * Preparation stays with the activation the user actually performs, which is
 * also what keeps this import off the fork-and-await path: the collection is
 * never held behind a preparation timeout per remembered folder.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { getLogger } from '../utils/logger.js';

const MAX_LEGACY_WORKSPACES = 6;
const log = getLogger('legacy-desktop-workspace-store');

export interface LegacyWorkspaceMigrationDependencies {
  hasWorkspaceRegistry: () => boolean;
  adoptWorkspaceDirectory: (workspacePath: string) => void;
  /**
   * The identity a directory already claims, or null when it claims none.
   *
   * Two remembered paths can name one copied Workspace, and only one of them
   * can be registered — adoption refuses the second. Asking first is what
   * lets the recent path win instead of whichever the loop reaches first.
   * Most legacy folders predate the manifest and claim nothing, so on a
   * typical upgrade this answers null for every entry.
   */
  workspaceIdentityOnDisk: (
    workspacePath: string,
  ) => { workspaceId: string } | null;
}

function legacyWorkspacePaths(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const store = raw as Record<string, unknown>;
  const candidates = [
    ...(typeof store.path === 'string' ? [store.path] : []),
    ...(Array.isArray(store.recent) ? store.recent : []),
  ];
  const paths: string[] = [];
  for (const candidate of candidates) {
    // Only absolute paths are meaningful here: the legacy store was written by
    // a different process with a different working directory, so a relative
    // entry names nothing this Server can resolve.
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    const workspacePath = path.resolve(candidate);
    if (!paths.includes(workspacePath)) paths.push(workspacePath);
    if (paths.length >= MAX_LEGACY_WORKSPACES) break;
  }
  return paths;
}

/** Whether a remembered path still names a directory worth registering. */
function isExistingDirectory(workspacePath: string): boolean {
  try {
    return statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}

export function migrateLegacyDesktopWorkspaceStore(
  filePath: string,
  dependencies: LegacyWorkspaceMigrationDependencies,
): void {
  if (dependencies.hasWorkspaceRegistry()) return;

  let paths: string[] = [];
  try {
    paths = legacyWorkspacePaths(
      JSON.parse(readFileSync(filePath, 'utf8')) as unknown,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      log.warn(
        { error, filePath },
        'Deprecated desktop Workspace store could not be read; continuing without legacy entries',
      );
    }
  }

  let migrated = 0;
  let skipped = 0;

  // Resolve what is importable in most-recent-first order, so that when two
  // remembered paths compete the recent one wins. Restoring someone into a
  // stale copy of their Workspace is worse than dropping the copy.
  const importable: string[] = [];
  const claimedIds = new Set<string>();
  for (const workspacePath of paths) {
    if (!isExistingDirectory(workspacePath)) {
      // The folder is gone or its volume is not mounted. Registering it would
      // resurrect an empty directory that reads as a real Workspace in the
      // picker, so drop the entry instead.
      skipped += 1;
      continue;
    }
    const claimed = dependencies.workspaceIdentityOnDisk(workspacePath);
    if (claimed) {
      if (claimedIds.has(claimed.workspaceId)) {
        skipped += 1;
        continue;
      }
      claimedIds.add(claimed.workspaceId);
    }
    importable.push(workspacePath);
  }

  // `adopt()` stamps the current time, so register oldest-to-newest to
  // reproduce the legacy file's most-recent-first order as timestamps.
  for (const workspacePath of importable.reverse()) {
    try {
      dependencies.adoptWorkspaceDirectory(workspacePath);
      migrated += 1;
    } catch (error) {
      skipped += 1;
      log.warn(
        { error, workspacePath },
        'Deprecated desktop Workspace entry could not be migrated',
      );
    }
  }

  if (paths.length > 0) {
    log.info(
      { filePath, migrated, skipped },
      'Processed deprecated desktop Workspace store',
    );
  }
}
