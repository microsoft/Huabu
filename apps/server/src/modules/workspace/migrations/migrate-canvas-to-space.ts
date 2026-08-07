/**
 * Canvas→Space on-disk filename migration (demo-stage rename).
 *
 * The agent- and user-visible files that dropped the legacy `canvas` /
 * `.huabu` vocabulary are renamed in place:
 *
 *   <canvasDir>/canvas.json        ->  <canvasDir>/space.json
 *   <canvasDir>/.memory/canvas.md  ->  <canvasDir>/.memory/space.md
 *   <workspace>/setting/.huabu.md  ->  <workspace>/setting/user.md
 *
 * ### Launch-only, idempotent, tolerant
 *
 * Runs from the boot migration pass in `workspace.ts` **before** any reader
 * touches the new names. Each rename fires only when the legacy source
 * exists AND the new target does not, so a re-run is a no-op. One bad entry
 * never aborts the batch.
 *
 * ### Pure rename — no `.bak`
 *
 * Unlike the chat-log migrators (which fold forward and retire the source
 * to `.bak`), this is a straight `renameSync`: the file content is
 * unchanged, only its name moves. There is nothing to keep a copy of.
 *
 * ### Literal names on purpose
 *
 * Both the old and new names are hard-coded literals (not the
 * `SPACE_JSON_FILENAME` constant). This is a frozen historical hop —
 * `canvas.json → space.json` must hold even if the constant is later
 * renamed again, so a future rename ships its own migrator rather than
 * silently repointing this one.
 *
 * DELETE-ME once every demo Home has booted at least once on the new build.
 */

import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

import { getLogger } from '../../../utils/logger.js';

const log = getLogger('migrate-canvas-to-space');

/** Rename `from`→`to` only when the source exists and the target does not. */
function renameIfPending(from: string, to: string): void {
  try {
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to);
    }
  } catch (err) {
    log.warn({ err, from, to }, 'failed to migrate legacy filename');
  }
}

/**
 * Rename every legacy `canvas.json` / `.memory/canvas.md` under each Space
 * folder, plus the one Home-level `setting/.huabu.md`, to their Space/User
 * names. Safe to call on every workspace activation.
 */
export function migrateCanvasToSpace(workspace: string): void {
  // Home-level user memory: setting/.huabu.md -> setting/user.md
  renameIfPending(
    path.join(workspace, 'setting', '.huabu.md'),
    path.join(workspace, 'setting', 'user.md'),
  );

  let entries: string[];
  try {
    entries = readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  for (const name of entries) {
    // Skip hidden / setting dirs — only per-Space folders carry these files.
    if (name.startsWith('.') || name === 'setting') continue;
    const canvasDir = path.join(workspace, name);
    try {
      if (!statSync(canvasDir).isDirectory()) continue;
    } catch {
      continue;
    }

    // Topology: canvas.json -> space.json
    renameIfPending(
      path.join(canvasDir, 'canvas.json'),
      path.join(canvasDir, 'space.json'),
    );
    // Space memory body: .memory/canvas.md -> .memory/space.md
    renameIfPending(
      path.join(canvasDir, '.memory', 'canvas.md'),
      path.join(canvasDir, '.memory', 'space.md'),
    );
  }
}
