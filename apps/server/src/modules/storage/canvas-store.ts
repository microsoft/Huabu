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
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

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
  nodeMdPath,
  nodesDir,
  prefsPath,
} from './paths.js';

import type { Context } from '@earendil-works/pi-ai';
import type {
  CanvasEventRecord,
  IntentEpisode,
  RecentAction,
} from '@sediment/shared';

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
  /** Loader/enrich-supplied frontmatter fields. */
  [key: string]: unknown;
}

/** Lightweight projection of node content for listings. */
export interface NodeContentSummary {
  nodeId: string;
  type: string;
  label: string | null;
}

/** Append-only behavioural event for a canvas (re-export of shared schema). */
export type CanvasEvent = CanvasEventRecord;

/** Per-canvas user preferences (frontmatter + markdown body). */
export interface UserPreferences {
  metadata: Record<string, unknown>;
  body: string;
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
  // `nodeId` is encoded in the filename; `content` is the markdown body.
  // Everything else lives in the frontmatter as native YAML.
  const { nodeId: _nodeId, content, ...frontmatter } = c;
  // Drop any legacy keys a caller may still be passing through; we never
  // want to reintroduce them once a workspace has been migrated.
  for (const key of LEGACY_FRONTMATTER_KEYS) {
    delete (frontmatter as Record<string, unknown>)[key];
  }
  // Drop nullish frontmatter entries so optional fields (e.g. `src` on
  // note/text/frame nodes) never serialize to `key: null`. Callers are
  // free to pass `undefined` to mean "omit".
  for (const key of Object.keys(frontmatter)) {
    const v = (frontmatter as Record<string, unknown>)[key];
    if (v === null || v === undefined) {
      delete (frontmatter as Record<string, unknown>)[key];
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
  const out: NodeContent = {
    ...meta,
    nodeId,
    type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
    label: labelMeta,
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

// ─── CanvasStore ────────────────────────────────────────────────────────────

export class CanvasStore {
  readonly canvasId: string;

  constructor(canvasId: string) {
    this.canvasId = sanitizeId(canvasId, 'canvasId');
  }

  // ── Canvas structure ─────────────────────────────────────────────────────

  read(): CanvasFile | null {
    return readJson<CanvasFile>(canvasJsonPath(this.canvasId));
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

  // ── Node content ─────────────────────────────────────────────────────────

  readNode(nodeId: string): NodeContent | null {
    const raw = readText(nodeMdPath(this.canvasId, nodeId));
    if (raw == null) return null;
    return markdownToNodeContent(nodeId, raw);
  }

  writeNode(nodeId: string, content: NodeContent): void {
    if (content.nodeId !== nodeId) {
      throw new Error(
        `nodeId mismatch: argument="${nodeId}" payload="${content.nodeId}"`,
      );
    }
    mkdirp(nodesDir(this.canvasId));
    atomicWriteText(
      nodeMdPath(this.canvasId, nodeId),
      nodeContentToMarkdown(content),
    );
  }

  deleteNode(nodeId: string): boolean {
    const filePath = nodeMdPath(this.canvasId, nodeId);
    if (!existsSync(filePath)) return false;
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  listNodes(): NodeContentSummary[] {
    const dir = nodesDir(this.canvasId);
    if (!existsSync(dir)) return [];
    const out: NodeContentSummary[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const nodeId = file.replace(/\.md$/, '');
      const raw = readText(path.join(dir, file));
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
        nodeId,
        type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
        label,
      });
    }
    return out;
  }

  // ── Artifacts ────────────────────────────────────────────────────────────

  artifactPath(filename: string): string {
    return artifactPath(this.canvasId, filename);
  }

  /** Absolute path of the canvas artifacts directory. */
  artifactsDir(): string {
    return artifactsDir(this.canvasId);
  }

  async writeArtifactStream(
    filename: string,
    src: NodeJS.ReadableStream,
  ): Promise<void> {
    mkdirp(artifactsDir(this.canvasId));
    await pipeline(src, createWriteStream(this.artifactPath(filename)));
  }

  async writeArtifactBuffer(filename: string, data: Buffer): Promise<void> {
    mkdirp(artifactsDir(this.canvasId));
    await writeFile(this.artifactPath(filename), data);
  }

  async deleteArtifact(filename: string): Promise<boolean> {
    const filePath = this.artifactPath(filename);
    if (!existsSync(filePath)) return false;
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  listArtifacts(): string[] {
    const dir = artifactsDir(this.canvasId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
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
    if (!existsSync(root)) return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  }
}
