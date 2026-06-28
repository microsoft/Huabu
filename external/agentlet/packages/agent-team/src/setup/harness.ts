/**
 * Harness detection and prompt file mapping.
 */

import { execFileSync } from 'node:child_process';
import type { HarnessName, HarnessPromptTarget } from './types.js';
import {
  HARNESS_REGISTRY,
  type HarnessInfo,
} from './harness-registry.js';

/** Get the registered harness info, if known. */
export function getHarnessInfo(harness: string): HarnessInfo | undefined {
  return HARNESS_REGISTRY[harness];
}

/** Check whether a harness CLI is available on PATH. */
export function isHarnessInstalled(harness: HarnessName): boolean {
  const binary = getHarnessInfo(harness)?.binary;
  if (!binary) {
    return false;
  }
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

/** Get the prompt file target for a harness, if the harness is known. */
export function getPromptTarget(
  harness: string,
): HarnessPromptTarget | undefined {
  return getHarnessInfo(harness)?.prompt;
}
