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
 */

import { readFileSync } from 'node:fs';

import { getLogger } from '../utils/logger.js';

const MAX_LEGACY_WORKSPACES = 6;
const log = getLogger('legacy-desktop-workspace-store');

export interface LegacyWorkspaceMigrationDependencies {
  hasWorkspaceRegistry: () => boolean;
  prepareWorkspacePath: (workspacePath: string) => Promise<string>;
  adoptWorkspaceDirectory: (workspacePath: string) => void;
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
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    if (!paths.includes(candidate)) paths.push(candidate);
    if (paths.length >= MAX_LEGACY_WORKSPACES) break;
  }
  return paths;
}

export async function migrateLegacyDesktopWorkspaceStore(
  filePath: string,
  dependencies: LegacyWorkspaceMigrationDependencies,
): Promise<void> {
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

  // `adopt()` records the current time, so import oldest-to-newest to preserve
  // the legacy file's existing most-recent-first order.
  for (const workspacePath of [...paths].reverse()) {
    try {
      const preparedPath =
        await dependencies.prepareWorkspacePath(workspacePath);
      dependencies.adoptWorkspaceDirectory(preparedPath);
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
