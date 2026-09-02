import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Bounded subdirectories created under the resource root. Nothing outside
 * this fixed set is created, scanned, or written by this package.
 */
export const RESOURCE_SUBDIRS = ['skills', 'tools', 'connectors', 'receipts'] as const;

export type ResourceSubdir = (typeof RESOURCE_SUBDIRS)[number];

const DEFAULT_RESOURCE_DIR_SEGMENTS = ['.agentlet', 'resources'] as const;

/**
 * Resolve the machine-local `AGENT_RESOURCE_DIR` root.
 *
 * Defaults to an absolute `~/.agentlet/resources` directory, matching the
 * cross-platform home-directory convention Node's `os.homedir()` already
 * applies (`$HOME` on POSIX, `USERPROFILE` on Windows). A host may configure
 * an explicit absolute root via the `AGENT_RESOURCE_DIR` environment
 * variable, mirroring the `AGENTLET_SHARED_NPM_TOOLS_DIR` override pattern
 * used for Agent Team shared tool installs.
 */
export function resolveResourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_RESOURCE_DIR?.trim();
  if (!override) {
    return join(homedir(), ...DEFAULT_RESOURCE_DIR_SEGMENTS);
  }
  if (!isAbsolute(override)) {
    throw new Error('AGENT_RESOURCE_DIR must be an absolute path');
  }
  return override;
}

/** Absolute path of one bounded subdirectory under a resource root. */
export function resourceSubdirPath(root: string, subdir: ResourceSubdir): string {
  return join(root, subdir);
}

/**
 * Idempotently create the bounded `skills/ tools/ connectors/ receipts/`
 * layout under `root`. Safe to call repeatedly; existing content is left
 * untouched.
 */
export function ensureResourceLayout(root: string): void {
  mkdirSync(root, { recursive: true });
  for (const subdir of RESOURCE_SUBDIRS) {
    mkdirSync(resourceSubdirPath(root, subdir), { recursive: true });
  }
}
