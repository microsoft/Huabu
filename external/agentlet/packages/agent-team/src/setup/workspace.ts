/**
 * Workspace creation and file distribution.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getPromptTarget } from './harness.js';

/** Resolve the workspace directory path for a harness. */
export function resolveWorkspaceDir(
  packageDir: string,
  harness: string,
): string {
  return join(packageDir, 'workspaces', harness);
}

/** Create the workspace directory (idempotent). */
export function createWorkspace(workspaceDir: string): void {
  mkdirSync(workspaceDir, { recursive: true });
}

/** Check whether a workspace has been prepared. */
export function isWorkspaceReady(workspaceDir: string): boolean {
  return existsSync(workspaceDir);
}

/**
 * Distribute the system prompt to the workspace using the
 * harness-specific prompt convention.
 *
 * @param promptFile - relative path to the prompt file within packageDir
 */
export function distributePrompt(
  packageDir: string,
  workspaceDir: string,
  harness: string,
  promptFile: string,
): void {
  const promptSource = join(packageDir, promptFile);
  if (!existsSync(promptSource)) {
    return;
  }

  const target = getPromptTarget(harness);
  if (!target) {
    return;
  }

  const targetDir = join(workspaceDir, target.dir);
  mkdirSync(targetDir, { recursive: true });

  const content = readFileSync(promptSource, 'utf8');
  writeFileSync(join(targetDir, target.filename), content, 'utf8');
}

/**
 * Copy a file or directory from the package root into the workspace.
 * Paths are relative to packageDir and workspaceDir respectively.
 */
export function copyToWorkspace(
  packageDir: string,
  workspaceDir: string,
  relativePath: string,
): void {
  const src = join(packageDir, relativePath);
  const dest = join(workspaceDir, relativePath);
  if (!existsSync(src)) {
    throw new Error(`Source does not exist: ${src}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/**
 * Assert that `child` resolves to a path inside `parent`, guarding against
 * `..` traversal and absolute paths escaping the intended root.
 */
function assertInside(parent: string, child: string, label: string): void {
  const rel = relative(parent, child);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} must stay within ${parent} (got: ${child})`);
  }
}

/** Expand a leading `~` / `~/` in a path to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Copy a declared `require.copies` entry into the workspace, allowing the
 * destination path to differ from the source.
 *
 * The source may live anywhere on disk — relative paths are resolved against
 * the package root, absolute paths and a leading `~` are honored — so teams
 * can seed a workspace from e.g. a file in the user's home directory. The
 * destination, however, must resolve to a path inside the workspace (no `..`
 * traversal) so setup can never write outside the workspace it owns.
 *
 * @param from - source path (relative to packageDir, absolute, or `~`-prefixed)
 * @param to   - destination path relative to workspaceDir (must resolve inside it)
 */
export function copyEntryToWorkspace(
  packageDir: string,
  workspaceDir: string,
  from: string,
  to: string,
): void {
  const src = resolve(packageDir, expandHome(from));
  const dest = resolve(workspaceDir, to);

  assertInside(workspaceDir, dest, `copy destination "${to}"`);

  if (!existsSync(src)) {
    throw new Error(`Copy source does not exist: ${src}`);
  }

  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}
