// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Memory read helpers.
 *
 * Read-side companions to the writers in `./writers.ts`. The chat /
 * operate route uses these to assemble the memory preamble that
 * fronts every agent turn (see PR-E in `docs/architecture/agent-memory.md`).
 *
 * The functions are intentionally trivial — they exist so route code
 * can be free of `fs` imports + path knowledge, not because they hide
 * complex logic.
 */

import { existsSync, readFileSync } from 'node:fs';

import { space, SPACE_MEMORY_BLOB_NAME } from '../../storage/index.js';
import { workspaceMemoryPath } from '../../workspace/paths.js';

/**
 * Read the user memory body.
 *
 * Returns the raw markdown content (frontmatter is not used here —
 * workspace memory is bullet-list prose, no frontmatter). Returns
 * `null` when the file is missing, empty, or unreadable so the
 * caller can omit the preamble entirely instead of injecting a
 * zero-information `(empty)` line.
 */
export function readWorkspaceMemory(): string | null {
  return readNonEmpty(workspaceMemoryPath());
}

/**
 * Read the per-Space memory body.
 *
 * Same null-on-empty contract as {@link readWorkspaceMemory}. A blob under the
 * Space's own memory scope (proposal §6.4.3, disposition D) — unlike the
 * Workspace memory above, which is not scoped to a Space and stays a file.
 */
export async function readCanvasMemory(
  canvasId: string,
): Promise<string | null> {
  const bytes = await space(canvasId).memory.read(SPACE_MEMORY_BLOB_NAME);
  if (bytes === null) return null;
  const raw = bytes.toString('utf8');
  return raw.trim().length === 0 ? null : raw;
}

function readNonEmpty(file: string): string | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (raw.trim().length === 0) return null;
  return raw;
}
