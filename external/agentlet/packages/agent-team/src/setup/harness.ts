/**
 * Harness detection and prompt file mapping.
 */

import { execFileSync } from 'node:child_process';
import type { HarnessName, HarnessPromptTarget } from './types.js';

/** Map of harness name to its CLI binary. */
const HARNESS_BINARIES: Record<string, string> = {
  claude: 'claude',
  copilot: 'copilot',
  codex: 'codex',
  pi: 'pi',
};

/**
 * Prompt file conventions per harness.
 * Each harness discovers its system prompt from a different file/location.
 */
const PROMPT_TARGETS: Record<string, HarnessPromptTarget> = {
  claude: { path: '.', filename: 'CLAUDE.md' },
  copilot: { path: '.github', filename: 'copilot-instructions.md' },
  codex: { path: '.', filename: 'AGENTS.md' },
  // pi uses CLAUDE.md convention for now
  pi: { path: '.', filename: 'CLAUDE.md' },
};

/** Check whether a harness CLI is available on PATH. */
export function isHarnessInstalled(harness: HarnessName): boolean {
  const binary = HARNESS_BINARIES[harness] ?? harness;
  try {
    execFileSync('which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Detect which of the given harnesses are installed on this machine. */
export function detectInstalledHarnesses(candidates: string[]): string[] {
  return candidates.filter(isHarnessInstalled);
}

/** Get the prompt file target for a harness. Falls back to root-level system_prompt.md. */
export function getPromptTarget(harness: string): HarnessPromptTarget {
  return (
    PROMPT_TARGETS[harness] ?? { path: '.', filename: 'system_prompt.md' }
  );
}
