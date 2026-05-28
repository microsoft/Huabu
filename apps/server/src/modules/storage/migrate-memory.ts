/**
 * One-shot migration: `<canvasDir>/memory/preferences.md`
 *                  → `<canvasDir>/.memory/canvas.md`
 *
 * The memory module redesign collapses two artifacts:
 *   - the old legacy `memory/preferences.md` (per-canvas user-visible
 *     preferences, never wired into a prompt) and
 *   - the new `.memory/canvas.md` (per-canvas working memory, hidden,
 *     written by the memory sub-agent and read back as a preamble).
 *
 * They serve different roles, but the existing files are typically
 * empty or contain a few lines a user typed by hand expecting them to
 * be picked up. We migrate non-empty bodies forward so nothing is lost,
 * and we delete the (now-misleading) legacy directory either way so
 * the agent's read tools don't accidentally surface stale `memory/`
 * paths.
 *
 * Idempotent. Sentinel-gated on `<workspace>/.memory-v1` so repeat
 * boots only pay the migration cost once.
 *
 * Run from {@link import('../workspace.js').setWorkspacePath} and
 * {@link import('../workspace.js').initWorkspaceFromEnv}, like the
 * other workspace migrations.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SENTINEL = '.memory-v1';

interface MigrationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const defaultLogger: MigrationLogger = {
  info: (msg, meta) => console.log(`[migrate-memory] ${msg}`, meta ?? {}),
  warn: (msg, meta) => console.warn(`[migrate-memory] ${msg}`, meta ?? {}),
};

/**
 * Migrate every canvas under `workspaceRoot` from the legacy
 * `memory/preferences.md` layout to the new `.memory/canvas.md` layout.
 *
 * For each canvas:
 *   - if `memory/preferences.md` has a non-empty body (after stripping
 *     any YAML frontmatter), it is written verbatim to
 *     `.memory/canvas.md` — but only if `.memory/canvas.md` does not
 *     already exist (which would imply a partial prior migration);
 *   - the legacy `memory/` directory is removed in any case.
 *
 * Skipped silently when the sentinel file is already present, when the
 * workspace path is missing, or when a canvas has neither layout.
 */
export function migrateLegacyMemory(
  workspaceRoot: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return;
  const sentinel = path.join(workspaceRoot, SENTINEL);
  if (existsSync(sentinel)) return;

  let entries: string[];
  try {
    entries = readdirSync(workspaceRoot);
  } catch (err) {
    logger.warn('failed to read workspace root, skipping', {
      err: (err as Error).message,
    });
    return;
  }

  let migrated = 0;
  let cleaned = 0;
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (name === 'setting') continue;

    const canvasDir = path.join(workspaceRoot, name);
    let stat;
    try {
      stat = statSync(canvasDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    // Only treat directories that look like canvas directories
    // (have `canvas.json`). Anything else is unrelated user data.
    if (!existsSync(path.join(canvasDir, 'canvas.json'))) continue;

    const oldDir = path.join(canvasDir, 'memory');
    const oldFile = path.join(oldDir, 'preferences.md');
    const newDir = path.join(canvasDir, '.memory');
    const newFile = path.join(newDir, 'canvas.md');

    if (existsSync(oldFile)) {
      try {
        const raw = readFileSync(oldFile, 'utf8');
        const body = stripFrontmatter(raw).trim();
        if (body.length > 0 && !existsSync(newFile)) {
          mkdirSync(newDir, { recursive: true });
          writeFileSync(newFile, `${body}\n`, 'utf8');
          migrated++;
          logger.info('migrated working memory', { canvas: name });
        }
      } catch (err) {
        logger.warn('failed reading legacy preferences.md, leaving in place', {
          canvas: name,
          err: (err as Error).message,
        });
        continue;
      }
    }

    if (existsSync(oldDir)) {
      try {
        rmSync(oldDir, { recursive: true, force: true });
        cleaned++;
      } catch (err) {
        logger.warn('failed to remove legacy memory/ dir', {
          canvas: name,
          err: (err as Error).message,
        });
      }
    }
  }

  // Drop the sentinel last so a crash mid-migration re-runs the pass
  // (re-runs are idempotent thanks to the per-file `existsSync` guards
  // above).
  try {
    writeFileSync(sentinel, `${new Date().toISOString()}\n`, 'utf8');
  } catch (err) {
    logger.warn('failed to write sentinel', {
      err: (err as Error).message,
    });
  }

  if (migrated > 0 || cleaned > 0) {
    logger.info('done', { migrated, cleaned });
  }
}

/**
 * Strip a leading `---\n…\n---\n` YAML frontmatter block, if present.
 *
 * The legacy `preferences.md` writer (`writePreferences` in
 * `canvas-store.ts`) emitted a frontmatter block with arbitrary
 * key-value pairs in front of the body. For the new working memory
 * file we only want the prose body — frontmatter metadata is not part
 * of the working-memory contract. A real YAML parser is overkill here;
 * a simple `---` / `---` envelope strip is all that is needed.
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return raw;
  // Find the closing fence. Allow it on its own line.
  const closeRe = /\n---[\r\n]/;
  const m = closeRe.exec(raw);
  if (!m) return raw;
  return raw.slice(m.index + m[0].length);
}
