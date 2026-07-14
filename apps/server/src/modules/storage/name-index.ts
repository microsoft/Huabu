/**
 * In-memory `id ↔ filename` index.
 *
 * The naming layer keeps display-name uniqueness and id stability as
 * separate concerns: identifiers live in entry payloads (or markdown
 * frontmatter / JSON manifests), filenames live on disk, and this index
 * keeps the two in sync without touching the filesystem itself.
 *
 * Three consumers share the implementation:
 *   - Home-level Space index (`<workspace>/<dir>/space.json`)
 *   - per-canvas node index         (`<canvas>/nodes/<file>.md`)
 *   - per-canvas artifact index     (`<canvas>/artifacts/<file>`)
 */

import {
  dedupeArtifactFilename,
  dedupeName,
  normalizeForCompare,
} from './naming.js';

export interface NameIndexEntry {
  /** Stable identifier — never written to disk as a filename. */
  id: string;
  /** Filesystem-safe display name. May include an extension. */
  filename: string;
}

export type NameIndexResult<E extends NameIndexEntry> =
  | { ok: true; entry: E }
  | { ok: false; reason: 'conflict'; conflictWith: E }
  | { ok: false; reason: 'not-found' };

/**
 * Generic index keyed by a stable `id`, with a secondary case-
 * insensitive lookup by `filename`. Mutating operations return a
 * structured result instead of throwing so callers can decide whether to
 * surface a 409 to the client, auto-dedupe, or retry.
 */
export class NameIndex<E extends NameIndexEntry> {
  private readonly byId = new Map<string, E>();
  private readonly byNorm = new Map<string, E>();

  constructor(entries: Iterable<E> = []) {
    this.reset(entries);
  }

  /** Replace the index contents (used on cold-start scans). */
  reset(entries: Iterable<E>): void {
    this.byId.clear();
    this.byNorm.clear();
    for (const entry of entries) this.put(entry);
  }

  size(): number {
    return this.byId.size;
  }

  list(): E[] {
    return [...this.byId.values()];
  }

  get(id: string): E | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Case-insensitive filename lookup. */
  findByName(filename: string): E | undefined {
    return this.byNorm.get(normalizeForCompare(filename));
  }

  /**
   * Insert a new entry. Returns a conflict result when another id already
   * occupies the requested filename.
   */
  add(entry: E): NameIndexResult<E> {
    const existing = this.byNorm.get(normalizeForCompare(entry.filename));
    if (existing && existing.id !== entry.id) {
      return { ok: false, reason: 'conflict', conflictWith: existing };
    }
    this.put(entry);
    return { ok: true, entry };
  }

  remove(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.byId.delete(id);
    this.byNorm.delete(normalizeForCompare(entry.filename));
    return true;
  }

  /**
   * Rename an existing entry to a new filename. Case-only changes (e.g.
   * "Foo" → "foo") are accepted and update the stored casing.
   */
  rename(id: string, newFilename: string): NameIndexResult<E> {
    const current = this.byId.get(id);
    if (!current) return { ok: false, reason: 'not-found' };

    const sameSlot =
      normalizeForCompare(current.filename) ===
      normalizeForCompare(newFilename);
    if (!sameSlot) {
      const conflict = this.byNorm.get(normalizeForCompare(newFilename));
      if (conflict && conflict.id !== id) {
        return { ok: false, reason: 'conflict', conflictWith: conflict };
      }
    }

    this.byNorm.delete(normalizeForCompare(current.filename));
    const updated = { ...current, filename: newFilename };
    this.byId.set(id, updated);
    this.byNorm.set(normalizeForCompare(newFilename), updated);
    return { ok: true, entry: updated };
  }

  /**
   * Patch arbitrary metadata on an existing entry (does not change
   * filename). Returns the updated entry.
   */
  patch(id: string, patch: Partial<Omit<E, 'id' | 'filename'>>): E | undefined {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const updated = { ...current, ...patch } as E;
    this.byId.set(id, updated);
    this.byNorm.set(normalizeForCompare(updated.filename), updated);
    return updated;
  }

  /**
   * Suggest a non-colliding filename based on `base`. Used by callers
   * that want auto-dedup behaviour (e.g. system / agent creating new
   * entries) instead of failing with a conflict.
   *
   * @param base       Desired filename. May include an extension.
   * @param hasExt     When true, dedupe before the file extension
   *                   (`Foo.pdf` → `Foo (2).pdf`); otherwise treat the
   *                   whole string as the basename.
   * @param ignoreId   When set, ignore this id when checking collisions
   *                   (useful while renaming an existing entry).
   */
  suggestUnique(base: string, hasExt = false, ignoreId?: string): string {
    const others: string[] = [];
    for (const entry of this.byId.values()) {
      if (ignoreId && entry.id === ignoreId) continue;
      others.push(entry.filename);
    }
    return hasExt
      ? dedupeArtifactFilename(base, others)
      : dedupeName(base, others);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private put(entry: E): void {
    this.byId.set(entry.id, entry);
    this.byNorm.set(normalizeForCompare(entry.filename), entry);
  }
}
