/**
 * Per-canvas storage facade.
 *
 * One `CanvasStore` instance maps to a single `<workspace>/<canvasId>/`
 * directory. All file I/O for that canvas — structure, node content,
 * artifacts, chat history, intent log, events, preferences — flows
 * through this class. The rest of the server depends on this facade
 * instead of the raw filesystem.
 */

import {
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  patchCanvasDirTitle,
  refreshCanvasDirIndex,
  registerCanvasDir,
  renameCanvasDirOnDisk,
  unregisterCanvasDir,
} from './canvas-dirs.js';
import { parseFrontmatter, toFrontmatter } from './frontmatter.js';
import {
  appendJsonArray,
  atomicWriteJson,
  atomicWriteText,
  mkdirp,
  readJson,
  readText,
  sanitizeId,
} from './io.js';
import { NameIndex } from './name-index.js';
import {
  applyProposedName,
  composeArtifactFilename,
  toSafeFilename,
  type NameSource,
} from './naming.js';
import {
  artifactManifestPath,
  artifactPath,
  artifactsDir,
  canvasJsonPath,
  canvasRoot,
  chatDir,
  chatPath,
  eventsPath,
  intentPath,
  memoryDir,
  nodeFilePath,
  nodesDir,
  prefsPath,
} from './paths.js';

import type { Context } from '@earendil-works/pi-ai';
import type { IntentEpisode } from '@sediment/shared';

interface NodeFileEntry {
  /** Stable node id (carried in frontmatter `id:`). */
  id: string;
  /** Filename inside `<canvas>/nodes/`, e.g. `My Note.md`. */
  filename: string;
}

interface ArtifactEntry {
  id: string;
  /** Stored filename inside `<canvas>/artifacts/`, e.g. `Yearly Report.pdf`. */
  filename: string;
  displayName: string;
  displayNameSource: NameSource;
  ext: string;
  mimeType: string | null;
  createdAt: number;
}

export type ArtifactRecord = ArtifactEntry;

// ─── Local types ────────────────────────────────────────────────────────────
// These mirror what will land in `@sediment/shared` in PR 8. Keeping them
// local for now lets PR 1 stand on its own without touching shared types.

/** On-disk shape of `<canvasId>/canvas.json`. */
export interface CanvasFile {
  canvasId: string;
  title: string | null;
  version: number;
  state: {
    nodes: unknown[];
    edges: unknown[];
    [key: string]: unknown;
  };
  createdAt: number;
  updatedAt: number;
}

/**
 * Canonical content of a single node (one `nodes/<nodeId>.md` file).
 *
 * The shape is a 1:1 mirror of the markdown file: `nodeId` comes from
 * the filename, `content` is the markdown body, and every other field
 * is a YAML frontmatter entry. Loaders/enrichers may attach arbitrary
 * extra fields (e.g. `summary`, `keywords`, `pageCount`) — they round-
 * trip through frontmatter via the index signature.
 */
export interface NodeContent {
  nodeId: string;
  /** CanvasNodeType — kept loose here to avoid the shared dependency. */
  type: string;
  title: string | null;
  /**
   * External URL or `artifacts/<file>` reference. Optional: only meaningful
   * for source-backed nodes (web/pdf/image/audio/video). Note/text/frame
   * nodes omit it entirely so it never lands in their frontmatter.
   */
  src?: string;
  /** Canonical markdown body. */
  content: string;
  /** Loader/enrich-supplied frontmatter fields. */
  [key: string]: unknown;
}

/** Lightweight projection of node content for listings. */
export interface NodeContentSummary {
  nodeId: string;
  type: string;
  title: string | null;
}

/** Append-only behavioural event for a canvas. */
export interface CanvasEvent {
  ts: number;
  kind: string;
  payload: unknown;
}

/** Per-canvas user preferences (frontmatter + markdown body). */
export interface UserPreferences {
  metadata: Record<string, unknown>;
  body: string;
}

// ─── Result shapes for rename-aware writes ─────────────────────────────────

/**
 * Result of a strict rename / write. Conflicts include the existing
 * holder's id + filename so the route layer can return a useful 409.
 */
export type RenameResult =
  | { ok: true; filename: string }
  | {
      ok: false;
      reason: 'conflict';
      conflictWith: { id: string; filename: string };
    }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'fs-error'; message: string };

export type RenameSelfResult =
  | { ok: true; dirName: string }
  | { ok: false; reason: 'conflict'; conflictWith: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'fs-error'; message: string };

export interface WriteArtifactInput {
  /** Stable artifact id (e.g. `art_xY9z2`). Doubles as the URL key stem. */
  id: string;
  /** User-facing display name (without extension), or null to fall back. */
  displayName?: string | null;
  /** Origin of `displayName`. Defaults to `'original'`. */
  source?: NameSource;
  /** File extension including the dot, e.g. `.pdf`. */
  ext: string;
  /** MIME type to remember for downloads / agent context. */
  mimeType?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Frontmatter keys that older canvases wrote but the current schema no
 * longer recognizes. They are stripped on read so they never round-trip
 * back into a freshly-written file.
 *
 * @deprecated Kept only as a defensive filter for legacy `nodes/*.md`
 * files; remove once `migrate.ts` has rewritten every workspace.
 *  - `content_hash`: previously used to dedupe extraction work; now we
 *    compare canonical content directly in `persist.ts`.
 *  - `meta_json`:    previously a JSON-stringified bag containing
 *    `summary` / `keywords` / etc.; those fields are now stored as
 *    flat top-level YAML keys.
 */
const LEGACY_FRONTMATTER_KEYS = ['content_hash', 'meta_json'] as const;

function nodeContentToMarkdown(c: NodeContent): string {
  // `nodeId` is carried in frontmatter `id:` (NameIndex needs it to map
  // labels back to stable ids); `content` is the markdown body.
  // Everything else lives in the frontmatter as native YAML.
  const { nodeId, content, ...rest } = c;
  const frontmatter: Record<string, unknown> = { id: nodeId, ...rest };
  // Drop any legacy keys a caller may still be passing through; we never
  // want to reintroduce them once a workspace has been migrated.
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete frontmatter[key];
  }
  // Drop nullish frontmatter entries so optional fields (e.g. `src` on
  // note/text/frame nodes) never serialize to `key: null`. Callers are
  // free to pass `undefined` to mean "omit".
  for (const key of Object.keys(frontmatter)) {
    const v = frontmatter[key];
    if (v === null || v === undefined) {
      delete frontmatter[key];
    }
  }
  return `${toFrontmatter(frontmatter)}\n${content}`;
}

function markdownToNodeContent(nodeId: string, raw: string): NodeContent {
  const { meta, content } = parseFrontmatter(raw);
  // Strip legacy frontmatter keys so they don't leak into pipeline state
  // (and therefore back into freshly-written files via cache-hit / persist
  // paths). Older `nodes/*.md` files written before the flat-frontmatter
  // refactor may still carry these.
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete meta[key];
  }
  const out: NodeContent = {
    ...meta,
    nodeId,
    type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
    title: typeof meta['title'] === 'string' ? meta['title'] : null,
    content,
  };
  // Normalize `src`: it must be a string when present, otherwise omitted.
  // Older / hand-edited node files may carry `src: null` or other non-string
  // scalars, which would otherwise leak into pipeline state and cause
  // cache-miss / comparison bugs against the declared `string | undefined`.
  if (typeof out.src !== 'string') {
    delete out.src;
  }
  return out;
}

/**
 * Derive the on-disk filename for a node from its label.
 *
 * Frame nodes (and any other label-less / placeholder nodes) fall back
 * to the stable node id so two different nodes never collide on a
 * generated default name.
 */
function nodeFilenameFor(nodeId: string, label: string | null): string {
  const stem = toSafeFilename(label, nodeId);
  return `${stem}.md`;
}

// ─── CanvasStore ────────────────────────────────────────────────────────────

export class CanvasStore {
  readonly canvasId: string;
  /**
   * Lazily-built `nodeId ↔ filename` index for `<canvas>/nodes/`. Read
   * via {@link nodeIndex}; never accessed directly.
   */
  private nodes: NameIndex<NodeFileEntry> | null = null;
  /**
   * Lazily-built `artifactId ↔ stored filename` index, backed by
   * `<canvas>/artifacts.json`. Read via {@link artifactIndex}.
   */
  private artifacts: NameIndex<ArtifactEntry> | null = null;

  constructor(canvasId: string) {
    this.canvasId = sanitizeId(canvasId, 'canvasId');
  }

  // ── Canvas structure ─────────────────────────────────────────────────────

  /**
   * Read this canvas's `canvas.json`.
   *
   * The directory name is the source of truth for the canvas title — if
   * the user renamed the directory in Finder we adopt the new name and
   * persist it back into `canvas.json` so the in-memory title and the
   * on-disk layout stay aligned.
   *
   * If the cached directory entry no longer exists on disk (the user
   * renamed or moved the folder), force a workspace re-scan and try
   * again before giving up. Returning `null` is reserved for the
   * genuinely-deleted case, where the GET handler emits a 404.
   */
  read(): CanvasFile | null {
    let file = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
    if (!file) {
      // Cached dir name may be stale. Re-scan once and retry.
      refreshCanvasDirIndex();
      file = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
      if (!file) return null;
    }

    // Sync the dir name into the canvas title. The filesystem wins — if
    // the user dragged the folder to "My Cool Canvas" in Finder, the
    // app should reflect that on the next load.
    const dirName = path.basename(canvasRoot(this.canvasId));
    if (dirName && file.title !== dirName) {
      const next: CanvasFile = {
        ...file,
        title: dirName,
        updatedAt: Date.now(),
      };
      try {
        atomicWriteJson(canvasJsonPath(this.canvasId), next);
        patchCanvasDirTitle(this.canvasId, dirName);
        return next;
      } catch {
        // If the writeback fails (read-only fs, race, ...), still return
        // the in-memory synced view; next save will retry.
        return { ...file, title: dirName };
      }
    }

    return file;
  }

  write(canvas: CanvasFile): void {
    if (canvas.canvasId !== this.canvasId) {
      throw new Error(
        `CanvasStore(${this.canvasId}) refusing to write canvas with id "${canvas.canvasId}"`,
      );
    }
    atomicWriteJson(canvasJsonPath(this.canvasId), canvas);
  }

  readVersion(): number | null {
    return this.read()?.version ?? null;
  }

  /**
   * Rename the on-disk directory backing this canvas to match `newTitle`.
   *
   * Strict: returns `{ ok: false, reason: 'conflict' }` when another
   * canvas already owns the sanitised directory slot. Callers (the PUT
   * handler) translate that into a 409. Auto-dedup is intentionally
   * NOT done here — that's the system's job at create time, not when
   * the user has explicitly typed a new name.
   *
   * Returns the new directory name on success.
   */
  renameSelf(newTitle: string | null): RenameSelfResult {
    const desired = toSafeFilename(newTitle, this.canvasId);

    // Make sure this canvas is in the dir index even if `read()` was
    // never called (e.g. brand-new canvas in this process).
    if (!existsSync(canvasRoot(this.canvasId))) {
      return { ok: false, reason: 'not-found' };
    }

    const result = renameCanvasDirOnDisk(this.canvasId, desired);
    if (result.ok) {
      patchCanvasDirTitle(this.canvasId, newTitle);
      return { ok: true, dirName: result.dirName };
    }
    if (result.reason === 'not-found') {
      // Index missed the entry — register against the current dir and retry.
      const current = path.basename(canvasRoot(this.canvasId));
      registerCanvasDir(this.canvasId, current, newTitle);
      return this.renameSelf(newTitle);
    }
    if (result.reason === 'conflict') {
      return {
        ok: false,
        reason: 'conflict',
        conflictWith: result.conflictWith,
      };
    }
    return { ok: false, reason: 'fs-error', message: result.message };
  }

  // ── Node content ─────────────────────────────────────────────────────────

  /**
   * Build (or return) the per-canvas node index. The index is populated
   * by scanning `nodes/*.md` and reading each frontmatter `id:` field;
   * legacy files without an `id:` fall back to using the filename stem
   * (which equals the legacy nodeId) so reads keep working until the
   * one-shot migration rewrites them.
   */
  private nodeIndex(): NameIndex<NodeFileEntry> {
    if (this.nodes) return this.nodes;
    const idx = new NameIndex<NodeFileEntry>();
    const dir = nodesDir(this.canvasId);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const raw = readText(path.join(dir, file));
        if (raw == null) continue;
        const { meta } = parseFrontmatter(raw);
        const id =
          typeof meta['id'] === 'string' && meta['id'].length > 0
            ? meta['id']
            : file.replace(/\.md$/, '');
        const result = idx.add({ id, filename: file });
        if (!result.ok) {
          // Two files claim the same logical id — keep the first
          // (deterministic) and ignore the rest. PR3 migration will
          // de-dupe these.
          continue;
        }
      }
    }
    this.nodes = idx;
    return idx;
  }

  /** Drop the cached node index; next access re-scans the directory. */
  invalidateNodeIndex(): void {
    this.nodes = null;
  }

  /**
   * Resolve a node id to its on-disk filename. Falls back to the legacy
   * `<nodeId>.md` shape so callers do not 404 before migration.
   */
  private nodeFilenameOf(nodeId: string): string {
    const entry = this.nodeIndex().get(nodeId);
    return entry?.filename ?? `${sanitizeId(nodeId, 'nodeId')}.md`;
  }

  readNode(nodeId: string): NodeContent | null {
    const filename = this.nodeFilenameOf(nodeId);
    const fullPath = nodeFilePath(this.canvasId, filename);
    let raw = readText(fullPath);
    if (raw === null) {
      // The cached index may be stale — the user could have renamed or
      // deleted the file in Finder. Re-scan once and retry.
      this.invalidateNodeIndex();
      const retryFilename = this.nodeFilenameOf(nodeId);
      if (retryFilename !== filename) {
        raw = readText(nodeFilePath(this.canvasId, retryFilename));
      }
      if (raw === null) return null;
    }
    return markdownToNodeContent(nodeId, raw);
  }

  writeNode(
    nodeId: string,
    content: NodeContent,
    opts: { strictRename?: boolean } = {},
  ): RenameResult {
    if (content.nodeId !== nodeId) {
      throw new Error(
        `nodeId mismatch: argument="${nodeId}" payload="${content.nodeId}"`,
      );
    }
    mkdirp(nodesDir(this.canvasId));

    const idx = this.nodeIndex();
    const existing = idx.get(nodeId);
    const desired = nodeFilenameFor(nodeId, content.title);

    // Decide the final on-disk filename.
    //  - When the desired slot is free (or already ours), use it as-is.
    //  - Otherwise: strict callers (user/agent rename) get a conflict
    //    result; non-strict callers (auto labels, AI preprocessing)
    //    fall back to a deduped " (n)" filename.
    let target = existing?.filename ?? desired;
    if (!existing || existing.filename !== desired) {
      const conflict = idx.findByName(desired);
      if (!conflict || conflict.id === nodeId) {
        target = desired;
      } else if (opts.strictRename) {
        return {
          ok: false,
          reason: 'conflict',
          conflictWith: { id: conflict.id, filename: conflict.filename },
        };
      } else {
        target = idx.suggestUnique(desired, true, nodeId);
      }
    }

    if (existing && existing.filename !== target) {
      // Renamed on disk: drop the stale file before writing the new one.
      try {
        unlinkSync(nodeFilePath(this.canvasId, existing.filename));
      } catch {
        // best effort; the index update below still keeps things consistent
      }
      idx.rename(nodeId, target);
    } else if (!existing) {
      idx.add({ id: nodeId, filename: target });
    }

    atomicWriteText(
      nodeFilePath(this.canvasId, target),
      nodeContentToMarkdown(content),
    );
    return { ok: true, filename: target };
  }

  deleteNode(nodeId: string): boolean {
    const idx = this.nodeIndex();
    const filename = idx.get(nodeId)?.filename ?? this.nodeFilenameOf(nodeId);
    const filePath = nodeFilePath(this.canvasId, filename);
    if (!existsSync(filePath)) {
      idx.remove(nodeId);
      return false;
    }
    try {
      unlinkSync(filePath);
      idx.remove(nodeId);
      return true;
    } catch {
      return false;
    }
  }

  listNodes(): NodeContentSummary[] {
    const dir = nodesDir(this.canvasId);
    if (!existsSync(dir)) return [];
    const out: NodeContentSummary[] = [];
    for (const entry of this.nodeIndex().list()) {
      const raw = readText(path.join(dir, entry.filename));
      if (raw == null) continue;
      const { meta } = parseFrontmatter(raw);
      out.push({
        nodeId: entry.id,
        type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
        title: typeof meta['title'] === 'string' ? meta['title'] : null,
      });
    }
    return out;
  }

  // ── Artifacts ────────────────────────────────────────────────────────────

  /** Absolute path of the canvas artifacts directory. */
  artifactsDir(): string {
    return artifactsDir(this.canvasId);
  }

  /** Absolute path for a stored artifact filename. */
  artifactPath(filename: string): string {
    return artifactPath(this.canvasId, filename);
  }

  /**
   * Build (or return) the per-canvas artifact index.
   *
   * The manifest at `<canvas>/artifacts.json` is the source of truth for
   * `id → { displayName, source, storedFilename, … }`. When the manifest
   * is missing or empty, every loose file in `artifacts/` is promoted to
   * a synthetic entry with its filename stem treated as both id and
   * display name (`source: 'auto'`). This keeps legacy URLs resolvable
   * while letting future migrations populate the manifest.
   */
  private artifactIndex(): NameIndex<ArtifactEntry> {
    if (this.artifacts) return this.artifacts;
    const idx = new NameIndex<ArtifactEntry>();

    const manifest = readJson<Record<string, Omit<ArtifactEntry, 'id'>>>(
      artifactManifestPath(this.canvasId),
    );
    if (manifest) {
      for (const [id, entry] of Object.entries(manifest)) {
        idx.add({ id, ...entry });
      }
    }

    // Promote any loose files we don't yet know about.
    const dir = artifactsDir(this.canvasId);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (idx.findByName(file)) continue;
        const ext = path.extname(file);
        const stem = ext ? file.slice(0, -ext.length) : file;
        idx.add({
          id: stem,
          filename: file,
          displayName: stem,
          displayNameSource: 'auto',
          ext,
          mimeType: null,
          createdAt: 0,
        });
      }
    }

    this.artifacts = idx;
    return idx;
  }

  /** Drop the cached artifact index; next access re-scans manifest + dir. */
  invalidateArtifactIndex(): void {
    this.artifacts = null;
  }

  /** Persist the in-memory artifact index back to `artifacts.json`. */
  private saveArtifactManifest(): void {
    if (!this.artifacts) return;
    const out: Record<string, Omit<ArtifactEntry, 'id'>> = {};
    for (const entry of this.artifacts.list()) {
      const { id, ...rest } = entry;
      out[id] = rest;
    }
    mkdirp(artifactsDir(this.canvasId));
    atomicWriteJson(artifactManifestPath(this.canvasId), out);
  }

  /**
   * Decide the on-disk filename for a new artifact. Auto-dedupes the
   * sanitised display name; never throws on conflict (artifacts are
   * always created by the system, not typed by the user).
   */
  private planArtifactFilename(input: WriteArtifactInput): {
    filename: string;
    displayName: string;
    source: NameSource;
  } {
    const idx = this.artifactIndex();
    const source = input.source ?? 'original';
    const displayName = (input.displayName ?? '').trim() || input.id;
    const stem = toSafeFilename(displayName, input.id);
    const desired = composeArtifactFilename(stem, input.ext);
    const target = idx.suggestUnique(desired, true, input.id);
    return { filename: target, displayName, source };
  }

  async writeArtifactStream(
    input: WriteArtifactInput,
    src: NodeJS.ReadableStream,
  ): Promise<ArtifactRecord> {
    mkdirp(artifactsDir(this.canvasId));
    const { filename, displayName, source } = this.planArtifactFilename(input);
    await pipeline(src, createWriteStream(this.artifactPath(filename)));
    return this.commitArtifact(input, filename, displayName, source);
  }

  async writeArtifactBuffer(
    input: WriteArtifactInput,
    data: Buffer,
  ): Promise<ArtifactRecord> {
    mkdirp(artifactsDir(this.canvasId));
    const { filename, displayName, source } = this.planArtifactFilename(input);
    await writeFile(this.artifactPath(filename), data);
    return this.commitArtifact(input, filename, displayName, source);
  }

  /** Update / add the manifest entry after the file landed on disk. */
  private commitArtifact(
    input: WriteArtifactInput,
    filename: string,
    displayName: string,
    source: NameSource,
  ): ArtifactRecord {
    const idx = this.artifactIndex();
    const entry: ArtifactEntry = {
      id: input.id,
      filename,
      displayName,
      displayNameSource: source,
      ext: input.ext,
      mimeType: input.mimeType ?? null,
      createdAt: Date.now(),
    };
    const existing = idx.get(input.id);
    if (existing && existing.filename !== filename) {
      // We renamed on disk; drop the old file.
      try {
        unlinkSync(this.artifactPath(existing.filename));
      } catch {
        // best effort
      }
      idx.rename(input.id, filename);
      idx.patch(input.id, entry);
    } else if (existing) {
      idx.patch(input.id, entry);
    } else {
      idx.add(entry);
    }
    this.saveArtifactManifest();
    return entry;
  }

  /**
   * Strict rename of an artifact's display name. Honours the
   * source-priority rules: an `auto` proposal cannot overwrite a `user`
   * or `agent` name. Returns the resolved record on success.
   */
  renameArtifact(
    artifactId: string,
    newDisplayName: string,
    source: NameSource,
  ): RenameResult {
    const idx = this.artifactIndex();
    const existing = idx.get(artifactId);
    if (!existing) return { ok: false, reason: 'not-found' };

    const nextState = applyProposedName(
      { name: newDisplayName, source },
      {
        displayName: existing.displayName,
        source: existing.displayNameSource,
      },
    );
    if (
      !nextState ||
      (nextState.displayName === existing.displayName &&
        nextState.source === existing.displayNameSource)
    ) {
      return { ok: true, filename: existing.filename };
    }

    const stem = toSafeFilename(nextState.displayName, existing.id);
    const desired = composeArtifactFilename(stem, existing.ext);
    if (desired !== existing.filename) {
      const conflict = idx.findByName(desired);
      if (conflict && conflict.id !== artifactId) {
        return {
          ok: false,
          reason: 'conflict',
          conflictWith: { id: conflict.id, filename: conflict.filename },
        };
      }
      try {
        const fromAbs = this.artifactPath(existing.filename);
        const toAbs = this.artifactPath(desired);
        if (existsSync(fromAbs)) renameSync(fromAbs, toAbs);
      } catch (err) {
        return {
          ok: false,
          reason: 'fs-error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      idx.rename(artifactId, desired);
    }
    idx.patch(artifactId, {
      displayName: nextState.displayName,
      displayNameSource: nextState.source,
    });
    this.saveArtifactManifest();
    return { ok: true, filename: desired };
  }

  /** Look up an artifact by id (does not touch the filesystem). */
  readArtifactById(artifactId: string): ArtifactRecord | null {
    return this.artifactIndex().get(artifactId) ?? null;
  }

  /**
   * Resolve a URL key (the `:filename` segment of
   * `/api/canvas/:canvasId/artifact/:filename`) back to a stored record.
   * The key is `<artifactId><ext>` for new uploads; legacy URLs that
   * already match a stored filename also resolve correctly.
   */
  resolveArtifactByKey(key: string): ArtifactRecord | null {
    const idx = this.artifactIndex();
    const direct = idx.findByName(key);
    if (direct) return direct;
    const ext = path.extname(key);
    const stem = ext ? key.slice(0, -ext.length) : key;
    return idx.get(stem) ?? null;
  }

  /**
   * Resolve a URL key to an absolute on-disk path of the stored artifact,
   * using the manifest so renames don't break existing URLs. Returns
   * `null` when the key has no matching record OR when the manifest's
   * recorded filename no longer exists on disk (e.g. the user deleted
   * or renamed the file outside the app).
   *
   * On a miss we invalidate the cached artifact index and retry once
   * so a Finder-side rename ( `Foo.pdf` → `Bar.pdf` while the manifest
   * still points at `Foo.pdf`) is detected as a deletion rather than a
   * stale-cache phantom hit.
   */
  resolveArtifactFilePath(key: string): string | null {
    const tryResolve = (): string | null => {
      const record = this.resolveArtifactByKey(key);
      if (!record) return null;
      const fullPath = this.artifactPath(record.filename);
      return existsSync(fullPath) ? fullPath : null;
    };

    const first = tryResolve();
    if (first) return first;
    this.invalidateArtifactIndex();
    return tryResolve();
  }

  async deleteArtifact(artifactId: string): Promise<boolean> {
    const idx = this.artifactIndex();
    const entry = idx.get(artifactId);
    if (!entry) return false;
    const filePath = this.artifactPath(entry.filename);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      return false;
    }
    idx.remove(artifactId);
    this.saveArtifactManifest();
    return true;
  }

  listArtifactRecords(): ArtifactRecord[] {
    return this.artifactIndex().list();
  }

  /** @deprecated Returns plain filenames; prefer {@link listArtifactRecords}. */
  listArtifacts(): string[] {
    return this.listArtifactRecords().map((r) => r.filename);
  }

  // ── Chat ─────────────────────────────────────────────────────────────────

  readChat(threadId: string): Context | null {
    return readJson<Context>(chatPath(this.canvasId, threadId));
  }

  writeChat(threadId: string, ctx: Context): void {
    mkdirp(chatDir(this.canvasId));
    atomicWriteJson(chatPath(this.canvasId, threadId), ctx);
  }

  loadLatestChat(): { threadId: string; context: Context } | null {
    const dir = chatDir(this.canvasId);
    if (!existsSync(dir)) return null;
    let latest: { file: string; mtime: number } | null = null;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const st = statSync(path.join(dir, file));
        if (!latest || st.mtimeMs > latest.mtime) {
          latest = { file, mtime: st.mtimeMs };
        }
      } catch {
        continue;
      }
    }
    if (!latest) return null;
    const threadId = latest.file.replace(/\.json$/, '');
    const context = readJson<Context>(path.join(dir, latest.file));
    if (!context) return null;
    return { threadId, context };
  }

  listChatThreads(): string[] {
    const dir = chatDir(this.canvasId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  // ── Intent ───────────────────────────────────────────────────────────────

  readIntents(): IntentEpisode[] {
    return readJson<IntentEpisode[]>(intentPath(this.canvasId)) ?? [];
  }

  upsertIntent(episode: IntentEpisode): void {
    const list = this.readIntents();
    const idx = list.findIndex((e) => e.id === episode.id);
    if (idx >= 0) {
      list[idx] = episode;
    } else {
      list.push(episode);
    }
    mkdirp(path.dirname(intentPath(this.canvasId)));
    atomicWriteJson(intentPath(this.canvasId), list);
  }

  // ── Events ───────────────────────────────────────────────────────────────

  appendEvent(kind: string, payload: unknown): void {
    mkdirp(path.dirname(eventsPath(this.canvasId)));
    appendJsonArray<CanvasEvent>(eventsPath(this.canvasId), {
      ts: Date.now(),
      kind,
      payload,
    });
  }

  readEvents(limit?: number): CanvasEvent[] {
    const all = readJson<CanvasEvent[]>(eventsPath(this.canvasId)) ?? [];
    if (limit == null) return all;
    return all.slice(-limit);
  }

  // ── Preferences ──────────────────────────────────────────────────────────

  readPreferences(): UserPreferences {
    const raw = readText(prefsPath(this.canvasId));
    if (raw == null) return { metadata: {}, body: '' };
    const { meta, content } = parseFrontmatter(raw);
    return { metadata: meta, body: content };
  }

  writePreferences(prefs: UserPreferences): void {
    mkdirp(memoryDir(this.canvasId));
    const fm = toFrontmatter(prefs.metadata);
    atomicWriteText(prefsPath(this.canvasId), `${fm}\n${prefs.body}`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Recursively delete the entire canvas directory. */
  destroy(): boolean {
    const root = canvasRoot(this.canvasId);
    if (!existsSync(root)) {
      unregisterCanvasDir(this.canvasId);
      this.invalidateNodeIndex();
      return false;
    }
    rmSync(root, { recursive: true, force: true });
    unregisterCanvasDir(this.canvasId);
    this.invalidateNodeIndex();
    return true;
  }
}
