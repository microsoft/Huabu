/**
 * Resolve an Agent Team spec into a concrete { command, cwd, env } tuple
 * that the daemon can use for spawning.
 */

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { readManifest } from '../setup/manifest.js';
import {
  npmToolsBinDir,
  resolveNpmToolsRoot,
} from '../setup/npm-tools.js';
import type { AgentTeamManifest } from '../setup/types.js';

/** Input: the agentTeam field from SessionSpec. */
export type AgentTeamRef =
  | {
      manifestPath: string;
      workingDirPath: string;
      harness: string;
    }
  | {
      agentDir: string;
      harness?: string;
    };

/** Output: resolved spawn parameters. */
export interface ResolvedSpawn {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

/**
 * Resolve an Agent Team reference into concrete spawn parameters.
 *
 * 1. Read agentlet.yaml from agentDir
 * 2. Determine harness (explicit > first command key)
 * 3. Validate workspace exists
 * 4. Resolve command from manifest
 * 5. Load .env if present
 */
export function resolveAgentTeam(
  ref: AgentTeamRef,
  envOverrides: Record<string, string> = {},
): ResolvedSpawn {
  const agentDir =
    'manifestPath' in ref
      ? dirname(resolve(ref.manifestPath))
      : resolve(ref.agentDir);

  // 1. Read manifest
  const manifest = readManifest(agentDir);

  // 2. Determine harness
  const harness = resolveHarness(ref.harness, manifest);

  // 3. Validate workspace
  const cwd =
    'workingDirPath' in ref
      ? resolve(ref.workingDirPath)
      : join(agentDir, 'workspaces', harness);
  if (!existsSync(cwd)) {
    throw new Error(
      `Agent Team workspace not prepared for harness "${harness}": ${cwd}\n` +
        `Run: cd ${agentDir} && agentlet agent-team setup --harness ${harness}`,
    );
  }

  // 4. Resolve command
  const command = resolveCommand(manifest, harness);

  // 5. Load .env
  const env = { ...loadDotEnv(agentDir), ...envOverrides };

  // 6. Make workspace and agentlet-shared CLI tools reachable on the final PATH.
  const workspaceBinDir = join(cwd, 'node_modules', '.bin');
  const sharedBinDirs = (manifest.require?.['cli-tools'] ?? [])
    .filter((tool) => tool.scope === 'shared')
    .map((tool) => npmToolsBinDir(resolveNpmToolsRoot(tool, cwd)));
  const basePath = env.PATH ?? process.env.PATH ?? '';
  env.PATH = [workspaceBinDir, ...sharedBinDirs, basePath]
    .filter(Boolean)
    .join(delimiter);

  return { command, cwd, env };
}

/** Determine which harness to use. */
function resolveHarness(
  requested: string | undefined,
  manifest: AgentTeamManifest,
): string {
  const harnesses = Object.keys(manifest.command);
  if (harnesses.length === 0) {
    throw new Error('No harness commands defined in agentlet.yaml');
  }

  if (requested) {
    if (!harnesses.includes(requested)) {
      throw new Error(
        `Harness "${requested}" is not defined in agentlet.yaml. Available: [${harnesses.join(', ')}]`,
      );
    }
    return requested;
  }
  return harnesses[0];
}

/** Resolve the command string from the manifest for a given harness. */
function resolveCommand(manifest: AgentTeamManifest, harness: string): string {
  const cmd = manifest.command[harness];
  if (!cmd) {
    throw new Error(
      `No command defined for harness "${harness}" in agentlet.yaml. ` +
        `Available: [${Object.keys(manifest.command).join(', ')}]`,
    );
  }
  return cmd;
}

/**
 * Parse a simple .env file (KEY=VALUE lines, # comments, blank lines).
 * Returns empty record if .env does not exist.
 */
function loadDotEnv(agentDir: string): Record<string, string> {
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    return {};
  }

  const env: Record<string, string> = {};
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = value;
  }
  return env;
}
