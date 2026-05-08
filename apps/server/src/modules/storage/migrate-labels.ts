/**
 * One-shot rename migration that converts the V2 layout (where canvas
 * directories and node markdown files were named after their stable
 * ids) to the V3 layout where every on-disk name is derived from a
 * user-facing label.
 *
 * Idempotent: each entry is checked against its desired name and only
 * renamed when it differs. Safe to call on every `setWorkspacePath`.
 *
 * What it does, in order:
 *
 *   1. For every `<workspace>/<dir>/canvas.json`, read the `canvasId`
 *      and `title`, then rename the directory to a sanitised version
 *      of the title (de-duplicated against siblings).
 *   2. For every node markdown file inside the renamed directory:
 *        - backfill `id: <legacy-filename-stem>` into the frontmatter
 *          when missing, so the per-canvas index can resolve nodes by
 *          their stable id;
 *        - rename the file to `safe(meta.title).md` (or `<id>.md`
 *          when there is no title yet, e.g. for frame nodes).
 *
 * Artifact filenames are intentionally untouched — that lives in PR 4
 * along with the per-canvas artifact manifest.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { parseFrontmatter, toFrontmatter } from './frontmatter.js';
import { atomicWriteJson, readJson } from './io.js';
import {
  dedupeArtifactFilename,
  dedupeName,
  toSafeFilename,
} from './naming.js';

interface MigrationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: MigrationLogger = {
  info: (m, meta) => console.log(`[migrate-labels] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[migrate-labels] ${m}`, meta ?? ''),
};

interface CanvasDirRecord {
  canvasId: string;
  /** Mutable: updated as the directory is renamed. */
  currentDir: string;
  title: string | null;
}

interface NodeFileRecord {
  /** Mutable: updated as the file is renamed. */
  currentFile: string;
  id: string;
  title: string | null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Step 1 — rename canvas directories to `safe(title)`. */
function renameCanvasDirs(
  workspace: string,
  entries: CanvasDirRecord[],
  logger: MigrationLogger,
): void {
  const taken = new Set<string>();
  for (const e of entries) taken.add(e.currentDir);

  for (const entry of entries) {
    const desired = toSafeFilename(entry.title, entry.canvasId);
    if (entry.currentDir === desired) continue;

    // Collide-against everything except this entry itself.
    const siblings: string[] = [];
    for (const name of taken) {
      if (name !== entry.currentDir) siblings.push(name);
    }
    const target = dedupeName(desired, siblings);
    if (target === entry.currentDir) continue;

    const from = path.join(workspace, entry.currentDir);
    const to = path.join(workspace, target);
    try {
      renameSync(from, to);
      taken.delete(entry.currentDir);
      taken.add(target);
      logger.info('renamed canvas dir', {
        canvasId: entry.canvasId,
        from: entry.currentDir,
        to: target,
      });
      entry.currentDir = target;
    } catch (err) {
      logger.warn('failed to rename canvas dir', {
        canvasId: entry.canvasId,
        from: entry.currentDir,
        to: target,
        err: String(err),
      });
    }
  }
}

/** Step 2 — within one canvas, backfill frontmatter ids and rename nodes. */
function renameNodeFiles(
  canvasDir: string,
  canvasId: string,
  logger: MigrationLogger,
): void {
  const nodesDir = path.join(canvasDir, 'nodes');
  if (!existsSync(nodesDir)) return;

  const records: NodeFileRecord[] = [];
  for (const file of readdirSync(nodesDir)) {
    if (!file.endsWith('.md')) continue;
    const fullPath = path.join(nodesDir, file);
    let raw: string;
    try {
      raw = readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }
    const { meta, content } = parseFrontmatter(raw);
    const stem = file.replace(/\.md$/, '');
    const id = meta['id'] || stem;

    if (!meta['id']) {
      // Put id first so the file is self-describing on inspection.
      const reordered: Record<string, unknown> = { id };
      for (const [k, v] of Object.entries(meta)) reordered[k] = v;
      try {
        writeFileSync(
          fullPath,
          `${toFrontmatter(reordered)}\n${content}`,
          'utf-8',
        );
      } catch (err) {
        logger.warn('failed to backfill frontmatter id', {
          canvasId,
          file,
          err: String(err),
        });
      }
    }

    records.push({ currentFile: file, id, title: meta['title'] ?? null });
  }

  const taken = new Set<string>();
  for (const r of records) taken.add(r.currentFile);

  for (const record of records) {
    const stem = toSafeFilename(record.title, record.id);
    const desired = `${stem}.md`;
    if (record.currentFile === desired) continue;

    const siblings: string[] = [];
    for (const name of taken) {
      if (name !== record.currentFile) siblings.push(name);
    }
    const target = dedupeArtifactFilename(desired, siblings);
    if (target === record.currentFile) continue;

    const from = path.join(nodesDir, record.currentFile);
    const to = path.join(nodesDir, target);
    try {
      renameSync(from, to);
      taken.delete(record.currentFile);
      taken.add(target);
      logger.info('renamed node file', {
        canvasId,
        from: record.currentFile,
        to: target,
      });
      record.currentFile = target;
    } catch (err) {
      logger.warn('failed to rename node file', {
        canvasId,
        from: record.currentFile,
        to: target,
        err: String(err),
      });
    }
  }
}

/**
 * Step 3 — seed `<canvasDir>/artifacts.json` for any loose files in
 * `artifacts/`. Existing filenames are kept as-is so URLs survive; the
 * manifest entries simply teach `CanvasStore` how to resolve them.
 */
function seedArtifactManifest(
  canvasDir: string,
  canvasId: string,
  logger: MigrationLogger,
): void {
  const artifactsDir = path.join(canvasDir, 'artifacts');
  if (!existsSync(artifactsDir)) return;
  const manifestPath = path.join(canvasDir, 'artifacts.json');

  const existing =
    readJson<Record<string, Record<string, unknown>>>(manifestPath) ?? {};

  const knownFiles = new Set<string>();
  for (const entry of Object.values(existing)) {
    const name = entry['filename'];
    if (typeof name === 'string') knownFiles.add(name);
  }

  let added = 0;
  for (const file of readdirSync(artifactsDir)) {
    if (knownFiles.has(file)) continue;
    const ext = path.extname(file);
    const stem = ext ? file.slice(0, -ext.length) : file;
    existing[stem] = {
      filename: file,
      displayName: stem,
      displayNameSource: 'auto',
      ext,
      mimeType: null,
      createdAt: 0,
    };
    added++;
  }

  if (added > 0 || !existsSync(manifestPath)) {
    atomicWriteJson(manifestPath, existing);
    logger.info('seeded artifact manifest', { canvasId, added });
  }
}

/**
 * Apply the V2 → V3 rename migration to the given workspace.
 *
 * The function is intentionally tolerant: malformed canvases are
 * skipped with a warning, individual rename failures don't abort the
 * batch, and re-runs are safe.
 */
export function migrateLabeledNames(
  workspace: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!existsSync(workspace)) return;

  // Collect (canvasId, currentDir, title) for every well-formed canvas.
  const entries: CanvasDirRecord[] = [];
  for (const name of readdirSync(workspace)) {
    if (name.startsWith('.')) continue;
    const full = path.join(workspace, name);
    if (!isDir(full)) continue;
    const json = readJson<{ canvasId?: string; title?: string | null }>(
      path.join(full, 'canvas.json'),
    );
    if (!json?.canvasId) continue;
    entries.push({
      canvasId: json.canvasId,
      currentDir: name,
      title: json.title ?? null,
    });
  }

  if (entries.length === 0) {
    refreshCanvasDirIndex();
    return;
  }

  renameCanvasDirs(workspace, entries, logger);
  for (const entry of entries) {
    renameNodeFiles(
      path.join(workspace, entry.currentDir),
      entry.canvasId,
      logger,
    );
    seedArtifactManifest(
      path.join(workspace, entry.currentDir),
      entry.canvasId,
      logger,
    );
  }

  // Force a re-scan so subsequent index lookups reflect the new layout.
  refreshCanvasDirIndex();
  logger.info('label-based naming migration complete', {
    workspace,
    canvasCount: entries.length,
  });
}
