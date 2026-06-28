/**
 * Workspace creation and file distribution.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
