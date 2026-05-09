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
  memoryDir,
  nodeFilePath,
  nodesDir,
  prefsPath,
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
  title: string | null;
  /** External URL or `/api/canvas/<id>/artifact/<artifactId><ext>` reference. */
  src: string | null;
  content: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export interface NodeContentSummary {
  nodeId: string;
  type: string;
  title: string | null;
  contentHash: string;
}

/** Append-only behavioural event for a canvas (re-export of shared schema). */
export type CanvasEvent = CanvasEventRecord;

export interface UserPreferences {
  metadata: Record<string, string | null>;
  body: string;
}

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
  /** Stable artifact id. Doubles as the URL key stem. */
  id: string;
  /** File extension including the dot, e.g. `.pdf`. */
  ext: string;
  mimeType?: string | null;
}

function nodeContentToMarkdown(c: NodeContent): string {
  const meta: Record<string, unknown> = {
    id: c.nodeId,
    type: c.type,
    title: c.title ?? null,
    src: c.src ?? null,
    content_hash: c.contentHash,
    meta_json: c.metadata ? JSON.stringify(c.metadata) : null,
  };
  return `${toFrontmatter(meta)}\n${c.content}`;
}

function markdownToNodeContent(nodeId: string, raw: string): NodeContent {
  const { meta, content } = parseFrontmatter(raw);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  let metadata: Record<string, unknown> = {};
  const metaJson = str(meta['meta_json']);
  if (metaJson) {
    try {
      metadata = JSON.parse(metaJson) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    nodeId,
    type: str(meta['type']) ?? 'note',
    title: str(meta['title']),
    src: str(meta['src']),
    content,
    contentHash: str(meta['content_hash']) ?? '',
    metadata,
  };
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
    const desired = nodeFilenameFor(nodeId, content.title);

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
      const str = (v: unknown): string | null =>
        typeof v === 'string' ? v : null;
      out.push({
        nodeId: entry.id,
        type: str(meta['type']) ?? 'note',
        title: str(meta['title']),
        contentHash: str(meta['content_hash']) ?? '',
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

  /** Resolve a URL key (`<id><ext>`) to a record. Trivial — name == key. */
  resolveArtifactByKey(key: string): ArtifactRecord | null {
    return this.buildRecord(path.basename(key));
  }

  /** Resolve a URL key to an absolute path, or null when the file is gone. */
  resolveArtifactFilePath(key: string): string | null {
    const fullPath = this.artifactPath(path.basename(key));
    return existsSync(fullPath) ? fullPath : null;
  }

  async deleteArtifact(artifactId: string): Promise<boolean> {
    const dir = artifactsDir(this.canvasId);
    if (!existsSync(dir)) return false;
    let removed = false;
    for (const file of readdirSync(dir)) {
      const ext = path.extname(file);
      const stem = ext ? file.slice(0, -ext.length) : file;
      if (stem !== artifactId) continue;
      try {
        unlinkSync(path.join(dir, file));
        removed = true;
      } catch {
        // best effort
      }
    }
    return removed;
  }

  listArtifactRecords(): ArtifactRecord[] {
    const dir = artifactsDir(this.canvasId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((f) => this.buildRecord(f));
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

  // ── Preferences ──────────────────────────────────────────────────────────

  readPreferences(): UserPreferences {
    const raw = readText(prefsPath(this.canvasId));
    if (raw == null) return { metadata: {}, body: '' };
    const { meta, content } = parseFrontmatter(raw);
    const metadata: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(meta)) {
      metadata[k] = typeof v === 'string' ? v : null;
    }
    return { metadata, body: content };
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
