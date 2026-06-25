/**
 * One-shot flattening of question-node prompts from
 * `data.input.content` (legacy discriminated `QuestionInput` union) to
 * the flat `data.content` field, aligning question with every other
 * text-bearing node type (`note` / `text` / `web` / `pdf` / `office`).
 *
 * The legacy shape:
 *
 *     {
 *       type: 'question',
 *       input: { kind: 'text', content: 'why is the sky blue?' },
 *       ...
 *     }
 *
 * The new shape:
 *
 *     {
 *       type: 'question',
 *       content: 'why is the sky blue?',
 *       ...
 *     }
 *
 * Two-step rewrite per canvas:
 *
 *   1. Rewrite `canvas.json` — flatten `data.input.content` to
 *      `data.content` and drop `data.input` on every question node.
 *
 *   2. Backfill the markdown sidecar. Pre-migration, question prompts
 *      lived only in `canvas.json` (the autosave queue never mirrored
 *      them into `nodes/<label>.md`). Without this backfill the very
 *      next structure PUT would strip the un-stripped `data.content`
 *      from `canvas.json` via `stripNodesForCanvas` and the prompt
 *      would be lost. We look up the existing sidecar by frontmatter
 *      `id` (the same matching rule the runtime uses), write the body
 *      when the sidecar exists but is empty, and create a brand-new
 *      sidecar when there isn't one yet — the autosave will later
 *      rename it to the canonical label-based filename via
 *      `writeNode`'s standard rename path.
 *
 * Sentinel-gated on `<workspace>/.question-content-v1` so repeat boots
 * pay nothing. Idempotent per file: a `canvas.json` that already uses
 * the new shape is skipped silently.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, toFrontmatter } from './frontmatter.js';
import { atomicWriteJson, atomicWriteText, mkdirp, readJson } from './io.js';
import {
  createMigrationLogger,
  type MigrationLogger,
} from './migration-logger.js';
import { toSafeFilename } from './naming.js';

const defaultLogger: MigrationLogger =
  createMigrationLogger('question-content');

const SENTINEL = '.question-content-v1';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface MigratedQuestion {
  nodeId: string;
  label: string | null;
  content: string;
}

/**
 * Flatten `data.input` on every question node in `canvas.json`.
 * Returns the list of (nodeId, label, content) tuples to backfill into
 * sidecars, or `null` when the file was already in the new shape (no
 * write needed).
 */
function flattenCanvasJson(canvasJsonFile: string): MigratedQuestion[] | null {
  const json = readJson<{ state?: { nodes?: unknown[] } }>(canvasJsonFile);
  if (!json) return null;
  const nodes = json.state?.nodes;
  if (!Array.isArray(nodes)) return null;

  const migrated: MigratedQuestion[] = [];
  let touched = false;

  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as { data?: Record<string, unknown> };
    const data = n.data;
    if (!data || data['type'] !== 'question') continue;

    const input = data['input'] as
      | { kind?: string; content?: string }
      | undefined;
    if (input === undefined) continue;

    // Pull the content; fall back to empty string for malformed input.
    const content =
      input?.kind === 'text' && typeof input.content === 'string'
        ? input.content
        : '';

    // Preserve any existing `data.content` (search-branch builds may
    // have written it before the migration ran). Only fill from
    // `input.content` when the flat field is missing.
    if (typeof data['content'] !== 'string') {
      data['content'] = content;
    }
    delete data['input'];
    touched = true;

    const nodeId =
      typeof (node as { id?: unknown }).id === 'string'
        ? (node as { id: string }).id
        : null;
    if (!nodeId) continue;
    const label = typeof data['label'] === 'string' ? data['label'] : null;
    const resolvedContent =
      typeof data['content'] === 'string' ? data['content'] : '';
    migrated.push({ nodeId, label, content: resolvedContent });
  }

  if (!touched) return null;
  atomicWriteJson(canvasJsonFile, json);
  return migrated;
}

/**
 * Walk a canvas's `nodes/` dir and build a `nodeId -> filename` map by
 * parsing each sidecar's frontmatter `id`. Falls back to the
 * filename-without-extension when no `id` field is present, mirroring
 * `NameIndex.add` / `nodeFilenameOf`.
 */
function indexSidecars(nodesDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!isDir(nodesDir)) return out;
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
    // First-wins on duplicate ids (`readAllNodes` walks in readdir
    // order; we match that here so the same file is picked).
    if (!out.has(id)) out.set(id, file);
  }
  return out;
}

/**
 * Pick an unused filename under `nodesDir` for a new sidecar. Tries
 * `<base>.md` first, then `<base> (2).md`, `(3).md`, … until one is
 * free. Mirrors the suffix shape `CanvasStore.writeNode` uses so the
 * autosave queue can later collapse onto the same name without churn.
 */
function pickUniqueFilename(nodesDir: string, base: string): string {
  const safeBase = base.replace(/\.md$/, '');
  let candidate = `${safeBase}.md`;
  if (!existsSync(path.join(nodesDir, candidate))) return candidate;
  let i = 2;
  while (true) {
    candidate = `${safeBase} (${i}).md`;
    if (!existsSync(path.join(nodesDir, candidate))) return candidate;
    i++;
  }
}

/**
 * Ensure each migrated question has its prompt persisted to the
 * markdown sidecar body. Three cases:
 *
 *   1. Sidecar exists and already has a non-empty body — leave it
 *      alone (e.g. the search-branch build already mirrored it).
 *   2. Sidecar exists but body is empty — rewrite with the prompt as
 *      body, frontmatter untouched.
 *   3. No sidecar — create one with minimal frontmatter
 *      (`id` / `type` / `label`). The next autosave will rename it
 *      to the canonical label-based filename via
 *      {@link CanvasStore.writeNode}'s rename path.
 */
function backfillSidecars(
  nodesDir: string,
  migrated: readonly MigratedQuestion[],
  logger: MigrationLogger,
  canvasId: string,
): { rewritten: number; created: number } {
  if (migrated.length === 0) return { rewritten: 0, created: 0 };
  mkdirp(nodesDir);
  const index = indexSidecars(nodesDir);

  let rewritten = 0;
  let created = 0;

  for (const { nodeId, label, content } of migrated) {
    if (content.length === 0) continue;

    const existingFile = index.get(nodeId);
    if (existingFile) {
      const full = path.join(nodesDir, existingFile);
      let raw: string;
      try {
        raw = readFileSync(full, 'utf-8');
      } catch (err) {
        logger.warn('failed to read existing sidecar', {
          canvasId,
          file: existingFile,
          err: String(err),
        });
        continue;
      }
      const { meta, content: existingBody } = parseFrontmatter(raw);
      if (existingBody.trim().length > 0) continue;
      try {
        atomicWriteText(full, `${toFrontmatter(meta)}\n${content}`);
        rewritten++;
      } catch (err) {
        logger.warn('failed to rewrite sidecar body', {
          canvasId,
          file: existingFile,
          err: String(err),
        });
      }
      continue;
    }

    const baseName = toSafeFilename(label, nodeId);
    const filename = pickUniqueFilename(nodesDir, baseName);
    const meta: Record<string, unknown> = {
      id: nodeId,
      type: 'question',
    };
    if (label) meta['label'] = label;
    try {
      atomicWriteText(
        path.join(nodesDir, filename),
        `${toFrontmatter(meta)}\n${content}`,
      );
      // Avoid colliding with any subsequent migrated question that
      // happens to share the same desired stem (rare but possible
      // when two unlabelled question nodes share the same nodeId
      // fallback — defensive only).
      index.set(nodeId, filename);
      created++;
    } catch (err) {
      logger.warn('failed to create sidecar', {
        canvasId,
        filename,
        err: String(err),
      });
    }
  }

  return { rewritten, created };
}

/**
 * Walk every `<canvasId>/canvas.json` under `workspace` and flatten
 * each question node's `data.input.content` into `data.content`, then
 * mirror the prompt into its markdown sidecar so the next structure
 * PUT can't strip it via `stripNodesForCanvas`.
 *
 * Safe to call on every server boot — sentinel-gated and per-file
 * idempotent.
 */
export function migrateQuestionContent(
  workspace: string,
  logger: MigrationLogger = defaultLogger,
): void {
  if (!existsSync(workspace)) return;
  const sentinel = path.join(workspace, SENTINEL);
  if (existsSync(sentinel)) return;

  let canvasesScanned = 0;
  let canvasesMigrated = 0;
  let questionsFlattened = 0;
  let sidecarsRewritten = 0;
  let sidecarsCreated = 0;

  for (const dirName of readdirSync(workspace)) {
    if (dirName.startsWith('.')) continue;
    const canvasDir = path.join(workspace, dirName);
    if (!isDir(canvasDir)) continue;
    const canvasJsonFile = path.join(canvasDir, 'canvas.json');
    if (!existsSync(canvasJsonFile)) continue;
    canvasesScanned++;

    let migrated: MigratedQuestion[] | null;
    try {
      migrated = flattenCanvasJson(canvasJsonFile);
    } catch (err) {
      logger.warn('failed to flatten canvas.json', {
        canvasDir: dirName,
        err: String(err),
      });
      continue;
    }
    if (migrated === null) continue;

    canvasesMigrated++;
    questionsFlattened += migrated.length;

    const { rewritten, created } = backfillSidecars(
      path.join(canvasDir, 'nodes'),
      migrated,
      logger,
      dirName,
    );
    sidecarsRewritten += rewritten;
    sidecarsCreated += created;
  }

  try {
    writeFileSync(
      sentinel,
      `migrated ${questionsFlattened} question prompts in ${canvasesMigrated}/${canvasesScanned} canvases\n`,
      'utf-8',
    );
  } catch (err) {
    logger.warn('failed to write sentinel', { sentinel, err: String(err) });
  }

  if (canvasesMigrated > 0) {
    logger.info('flattened question prompts to data.content', {
      workspace,
      canvasesScanned,
      canvasesMigrated,
      questionsFlattened,
      sidecarsRewritten,
      sidecarsCreated,
    });
  }
}
