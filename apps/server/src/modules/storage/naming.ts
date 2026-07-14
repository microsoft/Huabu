/**
 * Filesystem-safe naming primitives. Pure functions; no I/O.
 *
 * Server-only: dedup helpers depend on `node:path`, and the
 * single-name `toSafeFilename` rule is also confined here so the web
 * bundle never has to apply it (it never sends `nodes/<file>.md`
 * paths to the server — the server enriches refs into `AgentNodeRef`
 * with the pre-computed filename before any prompt rendering).
 */

import path from 'node:path';

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|\x00-\x1F]/g;
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const MAX_FILENAME_LENGTH = 120;

/**
 * Turn a free-form display name into a filesystem-safe filename.
 *
 * Replaces only `\ / : * ? " < > |` and ASCII control characters with
 * `_`. Spaces, hyphens, dots, parentheses and other characters are
 * preserved verbatim — the LLM expects this because the rule is
 * documented in `apps/server/src/prompt/skills/space/SKILL.md`.
 */
export function toSafeFilename(
  name?: string | null,
  fallback = 'Untitled',
): string {
  const normalized = (name ?? '').normalize('NFC');
  let safe = normalized.replace(ILLEGAL_CHARS_RE, '_');
  safe = safe.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!safe) return fallback;
  if (WIN_RESERVED_RE.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_FILENAME_LENGTH)
    safe = safe.slice(0, MAX_FILENAME_LENGTH);
  return safe;
}

/** Case-insensitive + NFC-normalized comparison key. */
export function normalizeForCompare(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Append " (2)", " (3)", … on collision. Case-insensitive. */
export function dedupeName(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) taken.add(normalizeForCompare(name));
  if (!taken.has(normalizeForCompare(base))) return base;
  let i = 2;
  while (taken.has(normalizeForCompare(`${base} (${i})`))) i++;
  return `${base} (${i})`;
}

/** Like {@link dedupeName} but preserves the file extension. */
export function dedupeArtifactFilename(
  filename: string,
  existing: Iterable<string>,
): string {
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const stemTaken = new Set<string>();
  for (const name of existing) {
    const otherExt = path.extname(name);
    const otherStem = otherExt ? name.slice(0, -otherExt.length) : name;
    stemTaken.add(normalizeForCompare(otherStem));
  }
  if (!stemTaken.has(normalizeForCompare(stem))) return filename;
  let i = 2;
  while (stemTaken.has(normalizeForCompare(`${stem} (${i})`))) i++;
  return `${stem} (${i})${ext}`;
}
