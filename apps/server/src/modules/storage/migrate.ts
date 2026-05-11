/**
 * One-shot migration from the legacy workspace layout to the
 * canvas-centric layout described in `docs/canvas-storage-refactor.md`.
 *
 * Legacy layout (per-workspace):
 *   <ws>/canvas/<id>.json
 *   <ws>/sources/<Title>.md            (frontmatter: id, type, src, content_hash, meta_json)
 *   <ws>/artifacts/<file>
 *   <ws>/.history/<id>/<thread>.json
 *   <ws>/.history/<id>/intent_record.json
 *
 * New layout (per canvas):
 *   <ws>/<id>/canvas.json
 *   <ws>/<id>/nodes/<nodeId>.md
 *   <ws>/<id>/artifacts/<file>
 *   <ws>/<id>/.history/chat/<thread>.json
 *   <ws>/<id>/.history/intent.json
 *
 * The migration is idempotent: per-canvas steps are skipped when the
 * target `<id>/canvas.json` already exists.  After every canvas has
 * been migrated, empty legacy top-level directories are removed.
 *
 * @deprecated Launch-only legacy migration. Remove this file once all
 * workspaces have been migrated to the canvas-centric layout.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { ARTIFACT_DATA_FIELDS } from '@sediment/shared';

import { CanvasStore } from './canvas-store.js';
import { parseFrontmatter } from './frontmatter.js';
import { atomicWriteJson, mkdirp } from './io.js';
import { readJson } from './io.js';
import { canvasJsonPath, canvasRoot } from './paths.js';

import type { CanvasFile, NodeContent } from './canvas-store.js';

const LEGACY_ARTIFACT_RE = /\/api\/artifact\/([^/?#]+)/;

interface MigrationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: MigrationLogger = {
  info: (m, meta) => console.log(`[migrate] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[migrate] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[migrate] ${m}`, meta ?? ''),
};

// ─── Detection ──────────────────────────────────────────────────────────────

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns true when the workspace looks like the legacy layout.
 *
 * @deprecated Launch-only legacy migration helper. Remove with this file once
 * all workspaces have been migrated to the canvas-centric layout.
 */
export function needsMigration(workspace: string): boolean {
  const legacy = ['canvas', 'sources', 'artifacts', '.history'].some((d) =>
    dirExists(path.join(workspace, d)),
  );
  if (!legacy) return false;

  // If a canvas folder is present in the legacy layout, run the migration.
  const legacyCanvasDir = path.join(workspace, 'canvas');
  if (!dirExists(legacyCanvasDir)) return true;

  const ids = readdirSync(legacyCanvasDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
  if (ids.length === 0) return true;

  // Skip when every legacy canvas already has a new-layout counterpart.
  return ids.some((id) => !existsSync(path.join(workspace, id, 'canvas.json')));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface SourceRecord {
  sourceId: string;
  type: string;
  title: string | null;
  src: string | null;
  content: string;
  metadata: Record<string, unknown>;
}

/** Walk `sources/` and build a `sourceId -> SourceRecord` index. */
function buildSourceIndex(sourcesDir: string): Map<string, SourceRecord> {
  const index = new Map<string, SourceRecord>();
  if (!dirExists(sourcesDir)) return index;

  const stack: string[] = [sourcesDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.endsWith('.md')) continue;

      try {
        const raw = readFileSync(full, 'utf-8');
        const { meta, content } = parseFrontmatter(raw);
        const metaIdRaw = meta['id'];
        const sourceId =
          (typeof metaIdRaw === 'string' ? metaIdRaw : null) ??
          path
            .relative(sourcesDir, full)
            .replace(/\\/g, '/')
            .replace(/\.md$/, '');
        if (!sourceId) continue;
        const title = path.basename(full, '.md');
        let metadata: Record<string, unknown> = {};
        const metaJsonRaw = meta['meta_json'];
        if (typeof metaJsonRaw === 'string' && metaJsonRaw) {
          try {
            metadata = JSON.parse(metaJsonRaw) as Record<string, unknown>;
          } catch {
            metadata = {};
          }
        }
        index.set(sourceId, {
          sourceId,
          type: typeof meta['type'] === 'string' ? meta['type'] : 'note',
          title,
          src: typeof meta['src'] === 'string' ? meta['src'] : null,
          content,
          metadata,
        });
      } catch {
        // skip unreadable
      }
    }
  }
  return index;
}

/** Try to delete a directory if it is empty. Returns true on success. */
function rmIfEmpty(dir: string): boolean {
  if (!dirExists(dir)) return false;
  try {
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

interface NodeShape {
  id?: string;
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

interface EdgeShape {
  source?: string;
  target?: string;
  [key: string]: unknown;
}

interface OldCanvasShape {
  canvasId?: string;
  title?: string | null;
  version?: number;
  state?: {
    nodes?: NodeShape[];
    edges?: EdgeShape[];
    [key: string]: unknown;
  };
  createdAt?: number;
  updatedAt?: number;
}

// ─── Per-canvas migration ───────────────────────────────────────────────────

function migrateOneCanvas(
  workspace: string,
  canvasId: string,
  legacyJsonPath: string,
  sourceIndex: Map<string, SourceRecord>,
  logger: MigrationLogger,
): void {
  if (existsSync(canvasJsonPath(canvasId))) {
    logger.info(`canvas already migrated, skipping`, { canvasId });
    return;
  }

  const raw = readFileSync(legacyJsonPath, 'utf-8');
  const old = JSON.parse(raw) as OldCanvasShape;

  mkdirp(canvasRoot(canvasId));
  const store = new CanvasStore(canvasId);

  const nodes: NodeShape[] = old.state?.nodes ?? [];
  const edges: EdgeShape[] = old.state?.edges ?? [];

  // Pass 1 — capture sourceId -> nodeId mapping for origin rewrites.
  const sourceToNode = new Map<string, string>();
  for (const node of nodes) {
    const nodeId = typeof node.id === 'string' ? node.id : null;
    const sid = node.data?.['sourceId'];
    if (nodeId && typeof sid === 'string' && sid) {
      sourceToNode.set(sid, nodeId);
    }
  }

  // Pass 2 — write node markdown, copy artifacts, rewrite node.data.
  const newNodes: NodeShape[] = [];
  for (const node of nodes) {
    const nodeId = typeof node.id === 'string' ? node.id : null;
    if (!nodeId) {
      newNodes.push(node);
      continue;
    }
    const data: Record<string, unknown> = { ...(node.data ?? {}) };

    // (a) Persist node markdown when a knowledge source backed it.
    const sourceId =
      typeof data['sourceId'] === 'string' ? (data['sourceId'] as string) : '';
    const src = sourceId ? sourceIndex.get(sourceId) : undefined;
    if (src) {
      const nodeContent: NodeContent = {
        ...(src.metadata ?? {}),
        nodeId,
        type: typeof node.type === 'string' ? node.type : src.type,
        label: src.title,
        src: src.src ?? undefined,
        content: src.content,
      };
      try {
        store.writeNode(nodeId, nodeContent);
      } catch (err) {
        logger.warn('failed to write node markdown', {
          canvasId,
          nodeId,
          err: String(err),
        });
      }
    } else if (typeof data['content'] === 'string' && data['content']) {
      // No knowledge source but inline content present — preserve it.
      const nodeContent: NodeContent = {
        nodeId,
        type: typeof node.type === 'string' ? node.type : 'note',
        label:
          typeof data['label'] === 'string' ? (data['label'] as string) : null,
        src:
          typeof data['src'] === 'string' ? (data['src'] as string) : undefined,
        content: data['content'] as string,
      };
      try {
        store.writeNode(nodeId, nodeContent);
      } catch (err) {
        logger.warn('failed to write inline node markdown', {
          canvasId,
          nodeId,
          err: String(err),
        });
      }
    }

    delete data['sourceId'];
    delete data['contentSnapshot'];
    delete data['content'];

    // (b) Rewrite artifact references and copy bytes into the canvas.
    for (const field of ARTIFACT_DATA_FIELDS) {
      const value = data[field];
      if (typeof value !== 'string') continue;
      const match = LEGACY_ARTIFACT_RE.exec(value);
      if (!match) continue;
      const filename = path.basename(match[1]);
      const oldPath = path.join(workspace, 'artifacts', filename);
      const newPath = path.join(workspace, canvasId, 'artifacts', filename);
      if (existsSync(oldPath) && !existsSync(newPath)) {
        try {
          mkdirSync(path.dirname(newPath), { recursive: true });
          copyFileSync(oldPath, newPath);
        } catch (err) {
          logger.warn('failed to copy artifact', {
            canvasId,
            filename,
            err: String(err),
          });
        }
      }
      data[field] = `/api/canvas/${canvasId}/artifact/${filename}`;
    }

    // (c) Rewrite origin.sourceId -> origin.excerptFromNodeId.
    const origin = data['origin'];
    if (origin && typeof origin === 'object') {
      const originRecord = origin as Record<string, unknown>;
      const originSid = originRecord['sourceId'];
      if (typeof originSid === 'string') {
        const targetNodeId = sourceToNode.get(originSid);
        delete originRecord['sourceId'];
        if (targetNodeId) {
          originRecord['excerptFromNodeId'] = targetNodeId;
        } else {
          logger.warn('origin.sourceId could not be resolved to a node', {
            canvasId,
            nodeId,
            sourceId: originSid,
          });
        }
        data['origin'] = originRecord;
      }
    }

    newNodes.push({ ...node, data });
  }

  // Write the new canvas.json.
  const now = Date.now();
  const canvasFile: CanvasFile = {
    canvasId,
    title: old.title ?? null,
    version: old.version ?? 0,
    state: {
      ...(old.state ?? {}),
      nodes: newNodes,
      edges,
    },
    createdAt: old.createdAt ?? now,
    updatedAt: old.updatedAt ?? now,
  };
  atomicWriteJson(canvasJsonPath(canvasId), canvasFile);

  // Move chat / intent history.
  const legacyHistoryDir = path.join(workspace, '.history', canvasId);
  if (dirExists(legacyHistoryDir)) {
    const chatTarget = path.join(workspace, canvasId, '.history', 'chat');
    mkdirp(chatTarget);
    for (const file of readdirSync(legacyHistoryDir)) {
      const from = path.join(legacyHistoryDir, file);
      if (file === 'intent_record.json') {
        const to = path.join(workspace, canvasId, '.history', 'intent.json');
        try {
          renameSync(from, to);
        } catch (err) {
          // Cross-device fallback: copy + unlink.
          try {
            const data = readFileSync(from);
            writeFileSync(to, data);
          } catch (err2) {
            logger.warn('failed to move intent file', {
              canvasId,
              err: String(err2 ?? err),
            });
          }
        }
        continue;
      }
      if (!file.endsWith('.json')) continue;
      const to = path.join(chatTarget, file);
      try {
        renameSync(from, to);
      } catch (err) {
        try {
          const data = readFileSync(from);
          writeFileSync(to, data);
        } catch (err2) {
          logger.warn('failed to move chat thread', {
            canvasId,
            file,
            err: String(err2 ?? err),
          });
        }
      }
    }
    rmIfEmpty(legacyHistoryDir);
  }

  logger.info('migrated canvas', { canvasId });
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Run the migration when the workspace is in the legacy layout.
 * Safe to call multiple times — it short-circuits when no work is left.
 *
 * @deprecated Launch-only legacy migration entry point. Remove once all
 * workspaces have been migrated to the canvas-centric layout.
 */
export function runMigrationIfNeeded(
  workspace: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!needsMigration(workspace)) return;

  logger.info('starting workspace migration', { workspace });
  const sourceIndex = buildSourceIndex(path.join(workspace, 'sources'));

  const legacyCanvasDir = path.join(workspace, 'canvas');
  if (dirExists(legacyCanvasDir)) {
    for (const file of readdirSync(legacyCanvasDir)) {
      if (!file.endsWith('.json')) continue;
      const canvasId = file.replace(/\.json$/, '');
      try {
        migrateOneCanvas(
          workspace,
          canvasId,
          path.join(legacyCanvasDir, file),
          sourceIndex,
          logger,
        );
      } catch (err) {
        logger.error('failed to migrate canvas', {
          canvasId,
          err: String(err),
        });
        throw err;
      }
    }
  }

  // Best-effort cleanup of legacy top-level directories.
  // Only delete when fully empty so user-dropped files survive.
  for (const sub of ['canvas', 'sources', 'artifacts']) {
    const dir = path.join(workspace, sub);
    if (rmIfEmpty(dir)) {
      logger.info(`removed empty legacy dir`, { dir });
    } else if (dirExists(dir)) {
      logger.warn(`legacy dir kept (not empty)`, { dir });
    }
  }
  const legacyHistory = path.join(workspace, '.history');
  if (dirExists(legacyHistory) && readdirSync(legacyHistory).length === 0) {
    rmdirSync(legacyHistory);
    logger.info('removed empty .history dir');
  }

  logger.info('workspace migration complete');
}

// ─── Flat-YAML metadata migration ──────────────────────────────────────────
//
// Historic node files stored their metadata bag as a JSON-stringified blob
// under a single `meta_json:` frontmatter key. The new layout writes those
// fields flat as native YAML so external agents reading `nodes/*.md` see
// `summary:` / `keywords:` / `pageCount:` directly without a second decode.
//
// The migration is one-shot per workspace, gated by a sentinel file so
// subsequent boots don't re-scan every node. Idempotent: re-running with
// the sentinel deleted is safe.

const FLAT_YAML_SENTINEL = '.flat-yaml-v1';

/**
 * One-shot scan: returns each canvas's `(dirName, canvasId)`. We can't
 * assume `dirName === canvasId` anymore — the V3 label-based naming
 * pass renames directories to safe(title), which can contain spaces and
 * non-ASCII characters that fail `sanitizeId`. The stable id only lives
 * inside `canvas.json`.
 */
function listCanvasDirs(
  workspace: string,
): Array<{ dirName: string; canvasId: string }> {
  if (!dirExists(workspace)) return [];
  const out: Array<{ dirName: string; canvasId: string }> = [];
  for (const entry of readdirSync(workspace)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(workspace, entry);
    if (!dirExists(full)) continue;
    const jsonPath = path.join(full, 'canvas.json');
    if (!existsSync(jsonPath)) continue;
    const json = readJson<{ canvasId?: string }>(jsonPath);
    if (!json?.canvasId) continue;
    out.push({ dirName: entry, canvasId: json.canvasId });
  }
  return out;
}

/**
 * Rewrite every `<workspace>/<canvasId>/nodes/*.md` so the legacy
 * `meta_json:` JSON blob becomes flat YAML fields. Skips the workspace
 * once `<workspace>/.flat-yaml-v1` exists.
 *
 * Safe to call on every server boot.
 */
export function flattenLegacyMetaJson(
  workspace: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!dirExists(workspace)) return;
  const sentinel = path.join(workspace, FLAT_YAML_SENTINEL);
  if (existsSync(sentinel)) return;

  const canvases = listCanvasDirs(workspace);
  let rewritten = 0;
  let scanned = 0;

  for (const { dirName, canvasId } of canvases) {
    const dir = path.join(workspace, dirName, 'nodes');
    if (!dirExists(dir)) continue;
    const store = new CanvasStore(canvasId);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      scanned++;
      // Declared outside the `try` so the catch handler can still log it.
      // V3 label-based files are named `safe(title).md`, so the filename
      // stem is no longer a valid id; the stable id lives in the
      // frontmatter and is read below. Fall back to the stem for V2.
      let nodeId = file.replace(/\.md$/, '');
      try {
        // Read directly via parseFrontmatter so we can detect the legacy
        // key explicitly. `store.readNode` already strips it from the
        // metadata bag, which would prevent us from noticing.
        const raw = readFileSync(path.join(dir, file), 'utf-8');
        const { meta } = parseFrontmatter(raw);
        const metaJsonRaw = meta['meta_json'];
        if (typeof metaJsonRaw !== 'string' || metaJsonRaw.length === 0) {
          continue;
        }
        const rawId = meta['id'];
        if (typeof rawId === 'string' && rawId) nodeId = rawId;
        const node = store.readNode(nodeId);
        if (!node) continue;
        // `readNode` ignores `meta_json`, so merge the legacy blob into
        // the node's frontmatter fields before writing back. Existing
        // flat keys win in case of overlap.
        let legacy: Record<string, unknown> = {};
        try {
          legacy = JSON.parse(metaJsonRaw) as Record<string, unknown>;
        } catch (err) {
          logger.warn('failed to parse legacy meta_json', {
            canvasId,
            nodeId,
            err: String(err),
          });
          continue;
        }
        store.writeNode(nodeId, { ...legacy, ...node });
        rewritten++;
      } catch (err) {
        logger.warn('failed to flatten node frontmatter', {
          canvasId,
          nodeId,
          err: String(err),
        });
      }
    }
  }

  try {
    writeFileSync(sentinel, `migrated ${rewritten}/${scanned} nodes\n`);
  } catch (err) {
    logger.warn('failed to write flat-yaml sentinel', {
      sentinel,
      err: String(err),
    });
  }

  if (rewritten > 0) {
    logger.info('flattened legacy meta_json frontmatter', {
      workspace,
      rewritten,
      scanned,
    });
  }
}
