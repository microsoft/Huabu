/**
 * Per-canvas storage facade. One instance per `<canvasDir>/`.
 */

import {
  createWriteStream,
  existsSync,
  readdirSync,
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
  appendJsonLine,
  appendJsonLines,
  atomicWriteJson,
  atomicWriteText,
  mkdirp,
  readJson,
  readJsonLines,
  readText,
  sanitizeId,
} from './io.js';
import { NameIndex } from './name-index.js';
import { toSafeFilename } from './naming.js';
import {
  artifactPath,
  artifactsDir,
  canvasJsonPath,
  canvasRoot,
  chatDir,
  chatPath,
  eventsPath,
  intentPath,
  nodeFilePath,
  nodesDir,
} from './paths.js';

import type { Context } from '@earendil-works/pi-ai';
import type {
  CanvasEventRecord,
  IntentEpisode,
  RecentAction,
} from '@sediment/shared';

interface NodeFileEntry {
  id: string;
  filename: string;
}

/** On-disk artifact descriptor. Filename is always `<id><ext>`. */
export interface ArtifactRecord {
  id: string;
  ext: string;
  filename: string;
  mimeType: string | null;
}

/** On-disk shape of `<canvasDir>/canvas.json`. */
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

/** Canonical content of a single node markdown file. */
export interface NodeContent {
  nodeId: string;
  type: string;
  /**
   * Display label shown on the canvas (`data.label` at runtime). Persisted
   * as `label:` in the markdown frontmatter.
   */
  label: string | null;
  /**
   * External URL or `artifacts/<file>` reference. Optional: only meaningful
   * for source-backed nodes (web/pdf/image/audio/video). Note/text/frame
   * nodes omit it entirely so it never lands in their frontmatter.
   */
  src?: string;
  /** Canonical markdown body. */
  content: string;
  /** Loader/enrich-supplied frontmatter fields (summary, keywords, …). */
  [key: string]: unknown;
}

export interface NodeContentSummary {
  nodeId: string;
  type: string;
  label: string | null;
}

/** Append-only behavioural event for a canvas (re-export of shared schema). */
export type CanvasEvent = CanvasEventRecord;

export type RenameResult =
  | {
      ok: true;
      /** Filesystem-safe filename (`safe(label) [(N)].md`). */
      filename: string;
      /**
       * The label as actually persisted to the markdown frontmatter — the
       * caller-provided label with any dedupe suffix (e.g. ` (2)`) appended
       * but with all original punctuation / non-ASCII characters preserved.
       * Mirror this back into `data.label` on the canvas so the runtime
       * label matches the frontmatter (which is the source of truth).
       */
      label: string | null;
    }
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
  /** Stable artifact id. Doubles as the URL key stem. */
  id: string;
  /** File extension including the dot, e.g. `.pdf`. */
  ext: string;
  mimeType?: string | null;
}

/**
 * Frontmatter keys that older canvases wrote but the current schema no
 * longer recognizes. They are stripped on read so they never round-trip
 * back into a freshly-written file.
 *
 * @deprecated Defensive filter for legacy `nodes/*.md` files.
 *  - `content_hash`: previously used to dedupe extraction work; we now
 *    compare canonical content directly in `persist.ts`.
 *  - `meta_json`:    previously a JSON-stringified bag of summary /
 *    keywords / etc.; those fields are now stored as flat top-level
 *    YAML keys.
 */
const LEGACY_FRONTMATTER_KEYS = ['content_hash', 'meta_json'] as const;

function nodeContentToMarkdown(c: NodeContent): string {
  // `nodeId` is the stable identifier; we explicitly inject it as the
  // frontmatter `id:` field so the on-disk filename (which is derived
  // from the user-facing label and may collide / be deduped) can always
  // be mapped back to the canonical id by `nodeIndex()`. `content` is
  // the markdown body. Everything else lives in the frontmatter as
  // native YAML.
  const { nodeId, content, ...frontmatter } = c;
  const fm: Record<string, unknown> = { id: nodeId, ...frontmatter };
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete fm[key];
  }
  // Drop nullish frontmatter entries so optional fields (e.g. `src` on
  // note/text/frame nodes) never serialize to `key: null`.
  for (const key of Object.keys(fm)) {
    const v = fm[key];
    if (v === null || v === undefined) {
      delete fm[key];
    }
  }
  return `${toFrontmatter(fm)}\n${content}`;
}

function markdownToNodeContent(nodeId: string, raw: string): NodeContent {
  const { meta, content } = parseFrontmatter(raw);
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete meta[key];
  }
  // Backward compat: pre-rename files wrote `title:`. Read either, but
  // strip `title` from the frontmatter bag so it never round-trips back.
  const labelMeta =
    typeof meta['label'] === 'string'
      ? meta['label']
      : typeof meta['title'] === 'string'
        ? meta['title']
        : null;
  delete meta['title'];
  delete meta['label'];
  // Drop the synthetic `id` we used to write into frontmatter — the canonical
  // id is the function argument (derived from filename / index).
  delete meta['id'];
  const out: NodeContent = {
    ...meta,
    nodeId,
    type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
    label: labelMeta,
    content,
  };
  // Normalize `src`: it must be a string when present, otherwise omitted.
  if (typeof out.src !== 'string') {
    delete out.src;
  }
  return out;
}

/**
 * Filename for a node's markdown. Frame and other label-less nodes
 * fall back to the stable id so two nodes never collide on a default.
 */
function nodeFilenameFor(nodeId: string, label: string | null): string {
  return `${toSafeFilename(label, nodeId)}.md`;
}

// ─── CanvasStore ────────────────────────────────────────────────────────────

export class CanvasStore {
  readonly canvasId: string;
  private nodes: NameIndex<NodeFileEntry> | null = null;

  constructor(canvasId: string) {
    this.canvasId = sanitizeId(canvasId, 'canvasId');
  }

  // ── Canvas structure ─────────────────────────────────────────────────────

  /**
   * Read this canvas's `canvas.json`. When the on-disk directory name
   * cannot be derived from the persisted title via {@link toSafeFilename}
   * we treat that as a Finder-side rename and adopt `dirName` as the new
   * title (persisted back into `canvas.json`). The common case where
   * `dirName === safe(title)` (e.g. title contains `?` / `:` / `/` that
   * was sanitised at create time) is left alone — overwriting there
   * would silently strip the user's typed characters from the title.
   */
  read(): CanvasFile | null {
    let file = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
    if (!file) {
      refreshCanvasDirIndex();
      file = readJson<CanvasFile>(canvasJsonPath(this.canvasId));
      if (!file) return null;
    }

    const dirName = path.basename(canvasRoot(this.canvasId));
    const expectedDir = toSafeFilename(file.title, this.canvasId);
    if (dirName && dirName !== expectedDir) {
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
   * Strict directory rename. Returns a structured conflict instead of
   * throwing so the route layer can map it to a 409.
   */
  renameSelf(newTitle: string | null): RenameSelfResult {
    const desired = toSafeFilename(newTitle, this.canvasId);
    if (!existsSync(canvasRoot(this.canvasId))) {
      return { ok: false, reason: 'not-found' };
    }

    const result = renameCanvasDirOnDisk(this.canvasId, desired);
    if (result.ok) {
      patchCanvasDirTitle(this.canvasId, newTitle);
      return { ok: true, dirName: result.dirName };
    }
    if (result.reason === 'not-found') {
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
        const rawId = meta['id'];
        const id =
          typeof rawId === 'string' && rawId
            ? rawId
            : file.replace(/\.md$/, '');
        idx.add({ id, filename: file });
      }
    }
    this.nodes = idx;
    return idx;
  }

  invalidateNodeIndex(): void {
    this.nodes = null;
  }

  private nodeFilenameOf(nodeId: string): string {
    const entry = this.nodeIndex().get(nodeId);
    return entry?.filename ?? `${sanitizeId(nodeId, 'nodeId')}.md`;
  }

  readNode(nodeId: string): NodeContent | null {
    const filename = this.nodeFilenameOf(nodeId);
    const fullPath = nodeFilePath(this.canvasId, filename);
    let raw = readText(fullPath);
    if (raw === null) {
      this.invalidateNodeIndex();
      const retryFilename = this.nodeFilenameOf(nodeId);
      if (retryFilename !== filename) {
        raw = readText(nodeFilePath(this.canvasId, retryFilename));
      }
      if (raw === null) return null;
    }
    return markdownToNodeContent(nodeId, raw);
  }

  /**
   * Predict whether a strict {@link writeNode} for `nodeId` with `label`
   * would collide with another node on disk. Pure: never touches the
   * filesystem or mutates state. Returns `desired` (the filename that
   * would land on disk) plus a non-null `conflict` when the slot is
   * already owned by a different node.
   *
   * Used by the route layer to pre-validate a batch PUT and 409 before
   * any partial writes happen.
   */
  checkNodeRename(
    nodeId: string,
    label: string | null,
  ): { desired: string; conflict: { id: string; filename: string } | null } {
    const idx = this.nodeIndex();
    const existing = idx.get(nodeId);
    const desired = nodeFilenameFor(nodeId, label);
    if (existing && existing.filename === desired) {
      return { desired, conflict: null };
    }
    const conflict = idx.findByName(desired);
    if (!conflict || conflict.id === nodeId) {
      return { desired, conflict: null };
    }
    return {
      desired,
      conflict: { id: conflict.id, filename: conflict.filename },
    };
  }

  /**
   * Write a node's markdown. Strict mode refuses sibling-label
   * collisions; lazy mode auto-dedupes with `(2)` / `(3)` suffixes.
   */
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
    // Empty / nullish label → fall back to whatever filename is already on
    // disk for this nodeId (don't churn it into `<nodeId>.md`). Only on a
    // genuine first write do we let `nodeFilenameFor` pick the nodeId
    // fallback. This protects the file name from being clobbered by an
    // intermediate save whose `data.label` is briefly empty (e.g. canvas
    // autosave racing with the LLM enrich result).
    const trimmedLabel =
      typeof content.label === 'string' && content.label.trim().length > 0
        ? content.label
        : null;
    const desired =
      trimmedLabel === null && existing
        ? existing.filename
        : nodeFilenameFor(nodeId, trimmedLabel);

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
      try {
        unlinkSync(nodeFilePath(this.canvasId, existing.filename));
      } catch {
        // best effort; index update below keeps things consistent
      }
      idx.rename(nodeId, target);
    } else if (!existing) {
      idx.add({ id: nodeId, filename: target });
    }

    // Compute the dedupe suffix (e.g. ` (2)`) by diffing the desired
    // safe-filename stem against the actual on-disk stem and apply it to
    // the *original* label. The frontmatter `label:` keeps all
    // user-typed punctuation / non-ASCII characters; only the filename
    // gets the sanitised + suffixed form. This way every reader sees
    // `Hello: World? (2)` rather than the safe `Hello_ World_ (2)`.
    const desiredStem = desired.replace(/\.md$/, '');
    const targetStem = target.replace(/\.md$/, '');
    const suffix =
      targetStem.length > desiredStem.length &&
      targetStem.startsWith(desiredStem)
        ? targetStem.slice(desiredStem.length)
        : '';
    const finalLabel =
      suffix && trimmedLabel ? `${trimmedLabel}${suffix}` : trimmedLabel;
    const finalContent: NodeContent =
      suffix && trimmedLabel ? { ...content, label: finalLabel } : content;

    atomicWriteText(
      nodeFilePath(this.canvasId, target),
      nodeContentToMarkdown(finalContent),
    );
    return { ok: true, filename: target, label: finalLabel };
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
      // @deprecated Backward compat: pre-rename files wrote `title:`.
      const label =
        typeof meta['label'] === 'string'
          ? meta['label']
          : typeof meta['title'] === 'string'
            ? meta['title']
            : null;
      out.push({
        nodeId: entry.id,
        type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
        label,
      });
    }
    return out;
  }

  // ── Artifacts ────────────────────────────────────────────────────────────
  //
  // Files live in `<canvasDir>/.artifacts/` named `<artifactId><ext>`.
  // The on-disk filename equals the URL key, so no manifest indirection
  // is needed — `data.src` on a node carries the URL directly and the
  // node's markdown carries it in frontmatter.

  artifactsDir(): string {
    return artifactsDir(this.canvasId);
  }

  artifactPath(filename: string): string {
    return artifactPath(this.canvasId, filename);
  }

  private buildRecord(filename: string): ArtifactRecord {
    const ext = path.extname(filename);
    const id = ext ? filename.slice(0, -ext.length) : filename;
    return { id, ext, filename, mimeType: null };
  }

  async writeArtifactStream(
    input: WriteArtifactInput,
    src: NodeJS.ReadableStream,
  ): Promise<ArtifactRecord> {
    mkdirp(artifactsDir(this.canvasId));
    const filename = `${input.id}${input.ext}`;
    await pipeline(src, createWriteStream(this.artifactPath(filename)));
    return {
      id: input.id,
      ext: input.ext,
      filename,
      mimeType: input.mimeType ?? null,
    };
  }

  async writeArtifactBuffer(
    input: WriteArtifactInput,
    data: Buffer,
  ): Promise<ArtifactRecord> {
    mkdirp(artifactsDir(this.canvasId));
    const filename = `${input.id}${input.ext}`;
    await writeFile(this.artifactPath(filename), data);
    return {
      id: input.id,
      ext: input.ext,
      filename,
      mimeType: input.mimeType ?? null,
    };
  }

  /** Resolve a URL key to an absolute path, or null when the file is gone. */
  resolveArtifactFilePath(key: string): string | null {
    const fullPath = this.artifactPath(path.basename(key));
    return existsSync(fullPath) ? fullPath : null;
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
      // Skip the rich-ACP sidecar (`<threadId>.parts.json`); it
      // pairs with a real pi-ai file and isn't a thread of its own.
      if (!file.endsWith('.json') || file.endsWith('.parts.json')) continue;
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
      .filter((f) => f.endsWith('.json') && !f.endsWith('.parts.json'))
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

  /**
   * Append one behavioural event as a single JSONL line.
   * One `write(2)` per call — line-atomic on POSIX.
   */
  appendEvent(payload: RecentAction): void {
    appendJsonLine<CanvasEvent>(eventsPath(this.canvasId), {
      ts: Date.now(),
      payload,
    });
  }

  /**
   * Bulk append used by the batch upload endpoint. Builds a single
   * buffer of N lines and issues exactly one `write(2)` so the whole
   * batch either lands or (on crash mid-write) the trailing partial
   * line is dropped by the reader. `ts` defaults to server time when
   * the caller omits it.
   */
  appendEvents(
    events: ReadonlyArray<{ payload: RecentAction; ts?: number }>,
  ): void {
    if (events.length === 0) return;
    const now = Date.now();
    const records: CanvasEvent[] = events.map((e) => ({
      ts: e.ts ?? now,
      payload: e.payload,
    }));
    appendJsonLines<CanvasEvent>(eventsPath(this.canvasId), records);
  }

  /**
   * Read events in chronological order. When `limit` is set, only the
   * most recent `limit` records are returned (tail read).
   */
  readEvents(limit?: number): CanvasEvent[] {
    return readJsonLines<CanvasEvent>(eventsPath(this.canvasId), limit);
  }

  // ── Preferences (removed) ────────────────────────────────────────────────
  //
  // Long-term user memory now lives at the workspace level
  // (`<workspace>/setting/.huabu.md`) and canvas-scoped canvas memory
  // lives at `<canvasDir>/.memory/canvas.md`. Both are owned by the
  // memory sub-agent, not the per-canvas store. See
  // `modules/agent/memory/` and the migration in
  // `modules/storage/migrate-memory.ts`.

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
