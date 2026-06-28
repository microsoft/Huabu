/**
 * Main entry point for Agent Team setup.
 *
 * Two modes:
 *   1. CLI mode: `npx @agentlet/agent-team setup <dir> --harness <name>`
 *      The CLI reads the manifest and runs the declarative pipeline.
 *   2. Script mode: per-package agent-setup.mjs calls `runSetup(callbacks)`.
 *      Kept for backward compat and complex custom setups.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSetupArgs } from './cli.js';
import { detectInstalledHarnesses, getPromptTarget } from './harness.js';
import { readManifest } from './manifest.js';
import type { AgentTeamManifest, CallbackContext, SetupCallbacks, SetupLogger } from './types.js';
import {
  createWorkspace,
  distributePrompt,
  isWorkspaceReady,
  resolveWorkspaceDir,
} from './workspace.js';

/** Create the default console logger. */
function createLogger(): SetupLogger {
  return {
    info: (msg) => console.log(`  ${msg}`),
    warn: (msg) => console.warn(`⚠ ${msg}`),
    error: (msg) => console.error(`✖ ${msg}`),
    success: (msg) => console.log(`✔ ${msg}`),
  };
}

/**
 * Resolve which harnesses to process.
 *
 * - If `--harness` is given, use that (validated against manifest).
 * - Otherwise, use all supported harnesses from manifest.
 * - If no supported_harnesses in manifest, use 'default'.
 */
function resolveHarnesses(
  manifest: { supported_harnesses?: string[] },
  requestedHarness: string | undefined,
  log: SetupLogger,
): string[] {
  if (requestedHarness) {
    if (
      manifest.supported_harnesses &&
      !manifest.supported_harnesses.includes(requestedHarness)
    ) {
      throw new Error(
        `Harness "${requestedHarness}" is not in supported_harnesses: [${manifest.supported_harnesses.join(', ')}]`,
      );
    }
    return [requestedHarness];
  }

  if (manifest.supported_harnesses && manifest.supported_harnesses.length > 0) {
    const installed = detectInstalledHarnesses(manifest.supported_harnesses);
    if (installed.length === 0) {
      log.warn(
        `None of the supported harnesses are installed: [${manifest.supported_harnesses.join(', ')}]`,
      );
      log.info('Use --harness <name> to prepare for a specific harness anyway');
      return manifest.supported_harnesses;
    }
    return installed;
  }

  return ['default'];
}

// ── Declarative pipeline steps ─────────────────────────────────────────

/** Install CLI tools declared in manifest.tools via npm. */
function installTools(
  manifest: AgentTeamManifest,
  workspaceDir: string,
  log: SetupLogger,
): void {
  if (!manifest.tools || manifest.tools.length === 0) return;
  log.info(`Installing tools: ${manifest.tools.join(', ')}`);

  // Ensure package.json exists so npm install works
  const pkgJson = join(workspaceDir, 'package.json');
  if (!existsSync(pkgJson)) {
    execSync('npm init -y --silent', { cwd: workspaceDir, stdio: 'pipe' });
  }

  const pkgs = manifest.tools.join(' ');
  execSync(`npm install ${pkgs}`, { cwd: workspaceDir, stdio: 'inherit' });
  log.success('Tools installed');
}

/**
 * Skills agent name mapping for `npx skills add --agent <name>`.
 * See https://github.com/vercel-labs/skills#supported-agents
 */
const SKILLS_AGENT_MAP: Record<string, string> = {
  claude: 'claude',
  copilot: 'github-copilot',
  codex: 'codex',
};

/** Install skills declared in manifest.skills via `npx skills add`. */
function installSkills(
  manifest: AgentTeamManifest,
  harness: string,
  workspaceDir: string,
  packageDir: string,
  log: SetupLogger,
): void {
  if (!manifest.skills || manifest.skills.length === 0) return;
  const agentName = SKILLS_AGENT_MAP[harness] ?? harness;
  log.info(`Installing skills for agent "${agentName}": ${manifest.skills.join(', ')}`);

  for (const skill of manifest.skills) {
    // Resolve relative skill paths against packageDir
    const skillPath = skill.startsWith('.') ? resolve(packageDir, skill) : skill;
    execSync(`npx skills add ${skillPath} --agent ${agentName}`, {
      cwd: workspaceDir,
      stdio: 'inherit',
    });
  }
  log.success('Skills installed');
}

/** Place the system prompt at the harness-specific location. */
function placeSystemPrompt(
  manifest: AgentTeamManifest,
  packageDir: string,
  workspaceDir: string,
  harness: string,
  log: SetupLogger,
): void {
  // Use manifest.system_prompt if declared, otherwise fall back to convention
  const promptFile = manifest.system_prompt ?? 'system_prompt.md';
  const promptSource = resolve(packageDir, promptFile);

  if (!existsSync(promptSource)) {
    if (manifest.system_prompt) {
      log.warn(`Declared system_prompt not found: ${promptSource}`);
    }
    return;
  }

  distributePrompt(packageDir, workspaceDir, harness, promptFile);
  const target = getPromptTarget(harness);
  log.success(`Prompt placed at ${target.path}/${target.filename}`);
}

/**
 * Load and invoke the custom onInstall script declared in the manifest.
 * The script must export a default async function.
 */
async function runCustomOnInstall(
  manifest: AgentTeamManifest,
  packageDir: string,
  ctx: CallbackContext,
  log: SetupLogger,
): Promise<void> {
  if (!manifest.onInstall) return;

  const scriptPath = resolve(packageDir, manifest.onInstall);
  if (!existsSync(scriptPath)) {
    log.warn(`onInstall script not found: ${scriptPath}`);
    return;
  }

  log.info(`Running custom onInstall: ${manifest.onInstall}`);
  const mod = await import(pathToFileURL(scriptPath).href);
  const fn = mod.default ?? mod.onInstall;
  if (typeof fn !== 'function') {
    throw new Error(
      `onInstall script must export a default function: ${scriptPath}`,
    );
  }
  await fn(ctx);
}

// ── Command runners ────────────────────────────────────────────────────

/** Run the `unpack` (or `setup`) command. */
async function runUnpack(
  packageDir: string,
  requestedHarness: string | undefined,
  callbacks: SetupCallbacks,
  log: SetupLogger,
): Promise<void> {
  const manifest = readManifest(packageDir);
  const harnesses = resolveHarnesses(manifest, requestedHarness, log);

  console.log(`\nSetting up "${manifest.name}" for: ${harnesses.join(', ')}\n`);

  for (const harness of harnesses) {
    log.info(`Preparing workspace for "${harness}"...`);
    const workspaceDir = resolveWorkspaceDir(packageDir, harness);

    createWorkspace(workspaceDir);

    // Declarative pipeline: tools → skills → prompt
    installTools(manifest, workspaceDir, log);
    installSkills(manifest, harness, workspaceDir, packageDir, log);
    placeSystemPrompt(manifest, packageDir, workspaceDir, harness, log);

    const ctx: CallbackContext = { packageDir, manifest, harness, workspaceDir, log };

    // Custom onInstall from manifest (dynamic import)
    await runCustomOnInstall(manifest, packageDir, ctx, log);

    // Legacy callbacks from runSetup({ onInstall, onUnpack })
    if (callbacks.onInstall) {
      log.info('Running callback install...');
      await callbacks.onInstall(harness, workspaceDir, ctx);
    }

    if (callbacks.onUnpack) {
      log.info('Running callback unpack...');
      await callbacks.onUnpack(harness, workspaceDir, ctx);
    }

    log.success(`Workspace ready: ${workspaceDir}`);
  }

  console.log('\nDone.\n');
}

/** Run the `validate` command. */
async function runValidate(
  packageDir: string,
  requestedHarness: string | undefined,
  callbacks: SetupCallbacks,
  log: SetupLogger,
): Promise<void> {
  const manifest = readManifest(packageDir);
  const harnesses = resolveHarnesses(manifest, requestedHarness, log);

  console.log(`\nValidating "${manifest.name}" for: ${harnesses.join(', ')}\n`);

  let allValid = true;
  for (const harness of harnesses) {
    const workspaceDir = resolveWorkspaceDir(packageDir, harness);

    if (!isWorkspaceReady(workspaceDir)) {
      log.error(`Workspace missing for "${harness}": ${workspaceDir}`);
      log.info('Run setup first: npx @agentlet/agent-team setup <dir>');
      allValid = false;
      continue;
    }

    log.success(`Workspace exists for "${harness}"`);

    if (callbacks.onValidate) {
      try {
        const ctx: CallbackContext = { packageDir, manifest, harness, workspaceDir, log };
        await callbacks.onValidate(harness, workspaceDir, ctx);
        log.success(`Package validation passed for "${harness}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Package validation failed for "${harness}": ${msg}`);
        allValid = false;
      }
    }
  }

  if (!allValid) {
    process.exitCode = 1;
  }

  console.log();
}

/** Run the `doctor` command. */
async function runDoctor(
  packageDir: string,
  requestedHarness: string | undefined,
  callbacks: SetupCallbacks,
  log: SetupLogger,
): Promise<void> {
  const manifest = readManifest(packageDir);
  const harnesses = resolveHarnesses(manifest, requestedHarness, log);

  console.log(`\nDiagnostics for "${manifest.name}"\n`);

  log.info(`Package:      ${manifest.name}`);
  log.info(`Schema:       ${manifest.schema}`);
  log.info(`Harnesses:    ${harnesses.join(', ')}`);
  if (manifest.tools?.length) log.info(`Tools:        ${manifest.tools.join(', ')}`);
  if (manifest.skills?.length) log.info(`Skills:       ${manifest.skills.join(', ')}`);
  if (manifest.system_prompt) log.info(`Prompt:       ${manifest.system_prompt}`);
  if (manifest.onInstall) log.info(`Custom setup: ${manifest.onInstall}`);
  console.log();

  for (const harness of harnesses) {
    const workspaceDir = resolveWorkspaceDir(packageDir, harness);
    const ready = isWorkspaceReady(workspaceDir);

    console.log(`  [${harness}]`);
    log.info(`  Workspace: ${ready ? '✔ ready' : '✖ not prepared'}`);

    const command =
      typeof manifest.command === 'string'
        ? manifest.command
        : manifest.command[harness];
    log.info(`  Command:   ${command ?? '(not defined for this harness)'}`);

    if (callbacks.onDoctor && ready) {
      const ctx: CallbackContext = { packageDir, manifest, harness, workspaceDir, log };
      await callbacks.onDoctor(harness, workspaceDir, ctx);
    }

    console.log();
  }
}

/**
 * Main entry point — can be called two ways:
 *
 * 1. As a library: `runSetup(callbacks)` from per-package agent-setup.mjs
 * 2. As the CLI: `npx @agentlet/agent-team setup <dir> --harness <name>`
 *    (callbacks are empty; the manifest drives everything declaratively)
 */
export async function runSetup(callbacks: SetupCallbacks = {}): Promise<void> {
  const args = parseSetupArgs();
  const packageDir = args.dir ? resolve(args.dir) : resolve('.');
  const log = createLogger();

  try {
    switch (args.command) {
      case 'setup':
      case 'unpack':
        await runUnpack(packageDir, args.harness, callbacks, log);
        break;
      case 'validate':
        await runValidate(packageDir, args.harness, callbacks, log);
        break;
      case 'doctor':
        await runDoctor(packageDir, args.harness, callbacks, log);
        break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    process.exitCode = 1;
  }
}
