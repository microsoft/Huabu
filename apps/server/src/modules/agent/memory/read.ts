/**
 * Memory read helpers.
 *
 * Read-side companions to the writers in `./writers.ts`. The chat /
 * operate route uses these to assemble the memory preamble that
 * fronts every agent turn (see PR-E in `docs/memory-module.md`).
 *
 * The functions are intentionally trivial — they exist so route code
 * can be free of `fs` imports + path knowledge, not because they hide
 * complex logic.
 */

import { existsSync, readFileSync } from 'node:fs';

import { longTermMemoryPath, workingMemoryPath } from '../../storage/paths.js';

/**
 * Read the long-term memory body (`<workspace>/setting/.huabu.md`).
 *
 * Returns the raw markdown content (frontmatter is not used here —
 * long-term memory is bullet-list prose, no frontmatter). Returns
 * `null` when the file is missing, empty, or unreadable so the
 * caller can omit the preamble entirely instead of injecting a
 * zero-information `(empty)` line.
 */
export function readLongTermMemory(): string | null {
  return readNonEmpty(longTermMemoryPath());
}

/**
 * Read the per-canvas working memory body.
 *
 * Same null-on-empty contract as {@link readLongTermMemory}.
 */
export function readWorkingMemory(canvasId: string): string | null {
  return readNonEmpty(workingMemoryPath(canvasId));
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
