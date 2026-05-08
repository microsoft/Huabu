/**
 * Naming primitives.
 *
 * One place that owns the rules for "how a user-visible label becomes a
 * filesystem-safe filename" and "which of several candidate names wins".
 *
 * The rest of the storage layer composes these pure functions; nothing
 * here touches the disk.
 */

import path from 'node:path';

// ─── Display-name source (priority high → low) ─────────────────────────────

/**
 * Where a display name came from. Higher-priority sources are never
 * silently overridden by lower-priority ones (e.g. AI cannot overwrite a
 * label the user typed).
 *
 * Priority: `user > agent > original > auto`.
 */
export type NameSource = 'user' | 'agent' | 'original' | 'auto';

const PRIORITY: Record<NameSource, number> = {
  user: 4,
  agent: 3,
  original: 2,
  auto: 1,
};

export interface NameState {
  displayName: string;
  source: NameSource;
}

/** True when `a` outranks `b` (strict). */
export function isStrongerSource(a: NameSource, b: NameSource): boolean {
  return PRIORITY[a] > PRIORITY[b];
}

/**
 * Pick the highest-priority non-empty entry from a bag of candidates.
 * Returns null when every candidate is missing/blank.
 */
export function pickInitialName(
  inputs: Partial<Record<NameSource, string | null | undefined>>,
): NameState | null {
  const order: NameSource[] = ['user', 'agent', 'original', 'auto'];
  for (const source of order) {
    const value = inputs[source];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { displayName: value.trim(), source };
    }
  }
  return null;
}

/**
 * Decide whether a freshly proposed name should replace the current one.
 *
 * - Blank proposals are ignored.
 * - A proposal with strictly lower priority than the current source is
 *   ignored (this is what stops AI auto-labels from clobbering a label
 *   the user typed).
 * - Otherwise the proposal wins.
 */
export function applyProposedName(
  proposal: { name?: string | null; source: NameSource },
  current?: NameState | null,
): NameState | null {
  const trimmed = typeof proposal.name === 'string' ? proposal.name.trim() : '';
  if (!trimmed) return current ?? null;
  if (current && isStrongerSource(current.source, proposal.source)) {
    return current;
  }
  return { displayName: trimmed, source: proposal.source };
}

// ─── Filesystem-safe filenames ─────────────────────────────────────────────

/** Characters disallowed by either Windows or POSIX filesystems. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|\x00-\x1F]/g;

/** Windows reserved device names (case-insensitive). */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Soft cap on filename length to leave headroom for path joins. */
export const MAX_FILENAME_LENGTH = 120;

/**
 * Turn a free-form display name into a filename safe for macOS, Windows
 * and Linux. The result preserves the user's intent as much as possible
 * (no transliteration, no aggressive lowercasing).
 *
 * @param name      Free-form display name. Null / empty falls back.
 * @param fallback  Filename to use when `name` produces an empty result.
 */
export function toSafeFilename(
  name?: string | null,
  fallback = 'Untitled',
): string {
  const normalized = (name ?? '').normalize('NFC');
  let safe = normalized.replace(ILLEGAL_CHARS_RE, '_');
  // Windows refuses leading/trailing dots and spaces.
  safe = safe.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!safe) return fallback;
  if (WIN_RESERVED_RE.test(safe)) safe = `_${safe}`;
  if (safe.length > MAX_FILENAME_LENGTH)
    safe = safe.slice(0, MAX_FILENAME_LENGTH);
  return safe;
}

/**
 * Compose a filename from a stem + extension, sanitising the stem first
 * and re-attaching the extension intact. The extension itself is also
 * sanitised but never affects the length cap of the stem.
 */
export function composeArtifactFilename(stem: string, ext: string): string {
  const safeStem = toSafeFilename(stem);
  const cleanExt = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  const safeExt = cleanExt.replace(ILLEGAL_CHARS_RE, '');
  return `${safeStem}${safeExt}`;
}

// ─── Comparison & de-duplication ───────────────────────────────────────────

/**
 * Normalise a filename for collision comparison. Case-insensitive +
 * NFC-normalised so "Foo" / "foo" / pre-composed vs decomposed are
 * treated as the same name (matches macOS/Windows default behaviour).
 */
export function normalizeForCompare(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Build a non-colliding filename by appending " (2)", " (3)", … when
 * the base already exists. Comparison is case-insensitive.
 *
 * For names that include an extension, callers should split the
 * extension off first (or use {@link dedupeArtifactFilename}).
 */
export function dedupeName(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const name of existing) taken.add(normalizeForCompare(name));
  if (!taken.has(normalizeForCompare(base))) return base;
  let i = 2;
  while (taken.has(normalizeForCompare(`${base} (${i})`))) i++;
  return `${base} (${i})`;
}

/**
 * Same as {@link dedupeName} but preserves a file extension. Useful for
 * artifact files whose name carries `.pdf` / `.png` etc.
 */
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
