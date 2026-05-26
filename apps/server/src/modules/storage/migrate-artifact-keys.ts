/**
 * One-shot rewrite of artifact references in node markdown sidecars.
 * @deprecated Launch-only legacy migration.
 * Before this migration, the front-end persisted artifact references as
 * full canvas-scoped URLs:
 *
 *     src: /api/canvas/<canvasId>/artifact/<artifactId><ext>
 *     coverUrl: /api/canvas/<canvasId>/artifact/<artifactId><ext>
 *
 * The path component is redundant: it's mechanically derivable from the
 * canvas the node lives in. After the migration, only the bare key
 * (`<artifactId><ext>`, equal to the on-disk filename) is stored:
 *
 *     src: <artifactId><ext>
 *     coverUrl: <artifactId><ext>
 *
 * Storing the bare key means renaming / moving the canvas directory
 * never invalidates persisted node data, and the artifact-cleanup pass
 * in `DELETE /canvas/:id/nodes/:nodeId` has an unambiguous key to look
 * up on disk.
 *
 * The migration walks every `nodes/<file>.md` in every canvas dir and
 * rewrites any `src:` / `coverUrl:` frontmatter values that still match
 * the legacy `/api/canvas/<id>/artifact/<key>` shape. Anything else
 * (data: URLs, external http(s) URLs, already-bare keys, empty values)
 * is left untouched.
 *
 * Idempotent. Sentinel-gated on `<workspace>/.bare-artifact-keys-v1` so
 * repeat boots only pay the rewrite cost once.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { ARTIFACT_DATA_FIELDS, ARTIFACT_URL_REGEX } from '@sediment/shared';

import { parseFrontmatter, toFrontmatter } from './frontmatter.js';
import { readJson } from './io.js';

interface MigrationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: MigrationLogger = {
  info: (m, meta) => console.log(`[migrate-artifact-keys] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[migrate-artifact-keys] ${m}`, meta ?? ''),
};

const SENTINEL = '.bare-artifact-keys-v1';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pull the bare artifact key out of a legacy full URL.
 *
 * Returns the bare key when `value` is a string matching
 * `/api/canvas/<id>/artifact/<key>` (absolute or relative). Returns
 * `null` for everything else — already-migrated bare keys, data URLs,
 * external URLs, and non-string values all fall through unchanged. The
 * caller treats `null` as "do not rewrite this field".
 */
function extractKeyFromLegacyUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('data:')) return null;
  const match = value.match(ARTIFACT_URL_REGEX);
  if (!match || !match[2]) return null;
  return path.basename(match[2]);
}

/**
 * Walk every `nodes/<file>.md` under every canvas dir in `workspace`
 * and rewrite legacy artifact URLs to bare keys.
 *
 * Safe to call on every server boot — sentinel-gated and per-file
 * idempotent.
 */
export function migrateBareArtifactKeys(
  workspace: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!existsSync(workspace)) return;
  const sentinel = path.join(workspace, SENTINEL);
  if (existsSync(sentinel)) return;

  let scanned = 0;
  let rewritten = 0;

  for (const dirName of readdirSync(workspace)) {
    if (dirName.startsWith('.')) continue;
    const canvasDir = path.join(workspace, dirName);
    if (!isDir(canvasDir)) continue;
    const json = readJson<{ canvasId?: string }>(
      path.join(canvasDir, 'canvas.json'),
    );
    if (!json?.canvasId) continue;
    const canvasId = json.canvasId;

    const nodesDir = path.join(canvasDir, 'nodes');
    if (!isDir(nodesDir)) continue;

    for (const file of readdirSync(nodesDir)) {
      if (!file.endsWith('.md')) continue;
      scanned++;
      const full = path.join(nodesDir, file);
      let raw: string;
      try {
        raw = readFileSync(full, 'utf-8');
      } catch (err) {
        logger.warn('failed to read node md', {
          canvasId,
          file,
          err: String(err),
        });
        continue;
      }

      const { meta, content } = parseFrontmatter(raw);
      let mutated = false;
      for (const field of ARTIFACT_DATA_FIELDS) {
        const key = extractKeyFromLegacyUrl(meta[field]);
        if (!key) continue;
        meta[field] = key;
        mutated = true;
      }

      if (!mutated) continue;

      try {
        writeFileSync(full, `${toFrontmatter(meta)}\n${content}`, 'utf-8');
        rewritten++;
      } catch (err) {
        logger.warn('failed to rewrite node md', {
          canvasId,
          file,
          err: String(err),
        });
      }
    }
  }

  try {
    writeFileSync(
      sentinel,
      `migrated ${rewritten}/${scanned} node files\n`,
      'utf-8',
    );
  } catch (err) {
    logger.warn('failed to write sentinel', { sentinel, err: String(err) });
  }

  if (rewritten > 0) {
    logger.info('rewrote artifact references to bare keys', {
      workspace,
      rewritten,
      scanned,
    });
  }
}
