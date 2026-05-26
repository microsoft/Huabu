/**
 * One-shot rename migration.
 * @deprecated Launch-only legacy migration.
 *
 *   V2 → V3: stable-id directories / files renamed to label-derived names,
 *            node frontmatter gains `id:`.
 *   V3 → V4: `artifacts/` → `.artifacts/`, manifest dropped, files renamed
 *            back to `<artifactId><ext>`. image / video / frame nodes get
 *            a sibling `.md` if they don't already have one.
 *
 * Idempotent: every step short-circuits when its target state is reached.
 * Safe to run on every workspace open.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { refreshCanvasDirIndex } from './canvas-dirs.js';
import { parseFrontmatter, toFrontmatter } from './frontmatter.js';
import { readJson } from './io.js';
import {
  dedupeArtifactFilename,
  dedupeName,
  normalizeForCompare,
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
  currentDir: string;
  title: string | null;
}

interface NodeFileRecord {
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
    // Compare via normalizeForCompare (NFC + lowercase) so we don't try
    // to rename when the on-disk name only differs in Unicode form (NFD
    // vs NFC) or letter case — both of which the rest of the storage
    // layer treats as the same slot.
    if (normalizeForCompare(entry.currentDir) === normalizeForCompare(desired))
      continue;

    const siblings: string[] = [];
    for (const name of taken) {
      if (name !== entry.currentDir) siblings.push(name);
    }
    const target = dedupeName(desired, siblings);
    if (normalizeForCompare(target) === normalizeForCompare(entry.currentDir))
      continue;

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
    const rawId = meta['id'];
    const id = typeof rawId === 'string' && rawId ? rawId : stem;

    if (!meta['id']) {
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

    // Read the display label from either key. New-format files write
    // only `label:`, so checking `title:` alone treated them as
    // labelless and renamed `My Note.md` back to `<nodeId>.md` on the
    // next migration pass — corrupting filenames that were already
    // correct. Prefer the new key, fall back to the legacy one.
    const rawLabel = meta['label'];
    const rawTitle = meta['title'];
    const labelOrTitle =
      typeof rawLabel === 'string'
        ? rawLabel
        : typeof rawTitle === 'string'
          ? rawTitle
          : null;
    records.push({
      currentFile: file,
      id,
      title: labelOrTitle,
    });
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
 * Step 3 — switch to the `.artifacts/` layout:
 *   - move `artifacts/` → `.artifacts/`,
 *   - rename files via `artifacts.json` so each becomes `<id><ext>`,
 *   - delete the manifest.
 *
 * Loose files without a manifest entry are left alone — their existing
 * filename already equals the URL key under the new scheme.
 */
function migrateArtifactsLayout(
  canvasDir: string,
  canvasId: string,
  logger: MigrationLogger,
): void {
  const oldDir = path.join(canvasDir, 'artifacts');
  const newDir = path.join(canvasDir, '.artifacts');

  if (existsSync(oldDir) && !existsSync(newDir)) {
    try {
      renameSync(oldDir, newDir);
      logger.info('moved artifacts dir', { canvasId });
    } catch (err) {
      logger.warn('failed to move artifacts dir', {
        canvasId,
        err: String(err),
      });
      return;
    }
  }

  const manifestPath = path.join(canvasDir, 'artifacts.json');
  if (existsSync(manifestPath) && existsSync(newDir)) {
    interface ManifestEntry {
      filename?: string;
      ext?: string;
    }
    const manifest = readJson<Record<string, ManifestEntry>>(manifestPath);
    if (manifest) {
      for (const [id, entry] of Object.entries(manifest)) {
        const oldName = entry.filename;
        const ext = entry.ext ?? (oldName ? path.extname(oldName) : '');
        if (!oldName) continue;
        const newName = `${id}${ext}`;
        if (oldName === newName) continue;
        const fromAbs = path.join(newDir, oldName);
        const toAbs = path.join(newDir, newName);
        if (!existsSync(fromAbs) || existsSync(toAbs)) continue;
        try {
          renameSync(fromAbs, toAbs);
          logger.info('renamed artifact', {
            canvasId,
            from: oldName,
            to: newName,
          });
        } catch (err) {
          logger.warn('failed to rename artifact', {
            canvasId,
            from: oldName,
            to: newName,
            err: String(err),
          });
        }
      }
    }
    try {
      rmSync(manifestPath);
      logger.info('removed artifacts manifest', { canvasId });
    } catch (err) {
      logger.warn('failed to remove artifacts manifest', {
        canvasId,
        err: String(err),
      });
    }
  }
}

/**
 * Step 4 — every metadata-only node (image / video / frame) in canvas.json
 * gets a `nodes/<safe(label)>.md` if one doesn't already exist. The body
 * is empty; the frontmatter carries `id`, `type`, `title`, `src`.
 */
function backfillMetadataOnlyNodeMd(
  canvasDir: string,
  canvasId: string,
  logger: MigrationLogger,
): void {
  const canvasJsonPath = path.join(canvasDir, 'canvas.json');
  if (!existsSync(canvasJsonPath)) return;

  interface CanvasJson {
    state?: { nodes?: Array<Record<string, unknown>> };
  }
  const json = readJson<CanvasJson>(canvasJsonPath);
  const nodes = json?.state?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return;

  const nodesDir = path.join(canvasDir, 'nodes');
  const existingByNodeId = new Map<string, string>();
  if (existsSync(nodesDir)) {
    for (const file of readdirSync(nodesDir)) {
      if (!file.endsWith('.md')) continue;
      let raw: string;
      try {
        raw = readFileSync(path.join(nodesDir, file), 'utf-8');
      } catch {
        continue;
      }
      const { meta } = parseFrontmatter(raw);
      const rawId = meta['id'];
      const id =
        typeof rawId === 'string' && rawId ? rawId : file.replace(/\.md$/, '');
      existingByNodeId.set(id, file);
    }
  }

  const usedFilenames = new Set<string>(existingByNodeId.values());
  let created = 0;

  for (const node of nodes) {
    const id = typeof node['id'] === 'string' ? node['id'] : '';
    const type = typeof node['type'] === 'string' ? node['type'] : '';
    if (!id || (type !== 'image' && type !== 'video' && type !== 'frame'))
      continue;
    if (existingByNodeId.has(id)) continue;

    const data = (node['data'] as Record<string, unknown>) ?? {};
    const title =
      typeof data['label'] === 'string' ? (data['label'] as string) : null;
    const src =
      typeof data['src'] === 'string' ? (data['src'] as string) : null;

    const stem = toSafeFilename(title, id);
    const desired = `${stem}.md`;
    const target = dedupeArtifactFilename(desired, usedFilenames);
    usedFilenames.add(target);

    // Frontmatter mirrors the canvas-store schema: `label:` (the
    // original, untransformed label), `src:` only when present, and no
    // legacy `content_hash` / `meta_json` keys (the canvas-store
    // strips them on read anyway).
    const fm = toFrontmatter({
      id,
      type,
      ...(title ? { label: title } : {}),
      ...(src ? { src } : {}),
    });
    try {
      mkdirSync(nodesDir, { recursive: true });
      writeFileSync(path.join(nodesDir, target), `${fm}\n`, 'utf-8');
      created++;
    } catch (err) {
      logger.warn('failed to backfill node md', {
        canvasId,
        nodeId: id,
        target,
        err: String(err),
      });
    }
  }

  if (created > 0) {
    logger.info('backfilled node md', { canvasId, created });
  }
}

/**
 * Apply the rename migration to the given workspace. Tolerant: malformed
 * canvases are skipped with a warning, individual failures don't abort
 * the batch, and re-runs are safe.
 */
export function migrateLabeledNames(
  workspace: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!existsSync(workspace)) return;

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
    const dir = path.join(workspace, entry.currentDir);
    renameNodeFiles(dir, entry.canvasId, logger);
    migrateArtifactsLayout(dir, entry.canvasId, logger);
    backfillMetadataOnlyNodeMd(dir, entry.canvasId, logger);
  }

  refreshCanvasDirIndex();
  logger.info('label-based naming migration complete', {
    workspace,
    canvasCount: entries.length,
  });
}
