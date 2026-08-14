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

import {
  workspaceMemoryPath,
  canvasMemoryPath,
} from '../../workspace/paths.js';

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
 * Read the per-canvas canvas memory body.
 *
 * Same null-on-empty contract as {@link readWorkspaceMemory}.
 */
export function readCanvasMemory(canvasId: string): string | null {
  return readNonEmpty(canvasMemoryPath(canvasId));
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
