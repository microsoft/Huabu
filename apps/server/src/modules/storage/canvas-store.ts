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
  appendJsonArray,
  atomicWriteJson,
  atomicWriteText,
  mkdirp,
  readJson,
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

import type { Context } from '@mariozechner/pi-ai';
import type { IntentEpisode } from '@sediment/shared';

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

/** Canonical content of a single node (one `nodes/<nodeId>.md` file). */
export interface NodeContent {
  nodeId: string;
  /** CanvasNodeType — kept loose here to avoid the shared dependency. */
  type: string;
  title: string | null;
  /** External URL or `artifacts/<file>` reference. */
  src: string | null;
  /** Canonical markdown body. */
  content: string;
  /** Hash used to skip re-processing when content has not changed. */
  contentHash: string;
  /** Free-form metadata stored as JSON in the frontmatter. */
  metadata: Record<string, unknown>;
}

/** Lightweight projection of node content for listings. */
export interface NodeContentSummary {
  nodeId: string;
  type: string;
  title: string | null;
  contentHash: string;
}

/** Append-only behavioural event for a canvas. */
export interface CanvasEvent {
  ts: number;
  kind: string;
  payload: unknown;
}

/** Per-canvas user preferences (frontmatter + markdown body). */
export interface UserPreferences {
  metadata: Record<string, string | null>;
  body: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function nodeContentToMarkdown(c: NodeContent): string {
  const meta: Record<string, unknown> = {
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
  let metadata: Record<string, unknown> = {};
  if (meta['meta_json']) {
    try {
      metadata = JSON.parse(meta['meta_json']) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    nodeId,
    type: meta['type'] ?? 'note',
    title: meta['title'] ?? null,
    src: meta['src'] ?? null,
    content,
    contentHash: meta['content_hash'] ?? '',
    metadata,
  };
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
      out.push({
        nodeId,
        type: meta['type'] ?? 'note',
        title: meta['title'] ?? null,
        contentHash: meta['content_hash'] ?? '',
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
    if (!existsSync(root)) return false;
    rmSync(root, { recursive: true, force: true });
    return true;
  }
}
