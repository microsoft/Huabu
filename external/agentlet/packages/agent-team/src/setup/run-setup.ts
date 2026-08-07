/**
 * Main entry point for Agent Team setup.
 *
 * Two modes:
 *   1. CLI mode: `agentlet agent-team setup --harness <name>` (run from
 *      inside the agent-team folder). The CLI reads ./agentlet.yaml and
 *      runs the declarative pipeline.
 *   2. Script mode: per-package agent-setup.mjs calls `runSetup(callbacks)`.
 *      Kept for backward compat and complex custom setups.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import spawn from 'cross-spawn';
import { parseSetupArgs } from './cli.js';
import {
  clearManagedSetupMarker,
  markManagedSetupReady,
} from '../managed-workspace.js';
import {
  detectInstalledHarnesses,
  getHarnessInfo,
  getPromptTarget,
} from './harness.js';
import { readManifest } from './manifest.js';
import {
  cliToolExecutablesExist,
  cliToolIsReady,
  recordCliTool,
  resolveNpmToolsRoot,
} from './npm-tools.js';
import type {
  AgentTeamManifest,
  CallbackContext,
  CliToolRequirement,
  CopyEntry,
  ManagedSetupOptions,
  ManagedSetupPhase,
  SetupCallbacks,
  SetupLogger,
} from './types.js';
import {
  createWorkspace,
  copyEntryToWorkspace,
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
 * - Otherwise, use the harnesses declared in manifest.command.
 * - Prefer installed harnesses when auto-detecting.
 */
function resolveHarnesses(
  manifest: Pick<AgentTeamManifest, 'command'>,
  requestedHarness: string | undefined,
  log: SetupLogger,
): string[] {
  const declaredHarnesses = Object.keys(manifest.command);
  if (declaredHarnesses.length === 0) {
    throw new Error('No harness commands defined in agentlet.yaml');
  }

  if (requestedHarness) {
    if (!declaredHarnesses.includes(requestedHarness)) {
      throw new Error(
        `Harness "${requestedHarness}" is not defined in command: [${declaredHarnesses.join(', ')}]`,
      );
    }
    return [requestedHarness];
  }

  const installed = detectInstalledHarnesses(declaredHarnesses);
  if (installed.length === 0) {
    log.warn(`None of the declared harnesses are installed: [${declaredHarnesses.join(', ')}]`);
    log.info('Use --harness <name> to prepare for a specific harness anyway');
    return declaredHarnesses;
  }

  const skipped = declaredHarnesses.filter((h) => !installed.includes(h));
  if (skipped.length > 0) {
    log.warn(
      `Skipping declared harness(es) not installed on this machine: [${skipped.join(', ')}]`,
    );
    log.info(
      `Preparing installed harness(es): [${installed.join(', ')}]. ` +
        'Use --harness <name> to prepare a non-installed one anyway.',
    );
  }

  return installed;
}

// ── Declarative pipeline steps ─────────────────────────────────────────

function getRequiredCliTools(
  manifest: AgentTeamManifest,
): CliToolRequirement[] {
  return manifest.require?.['cli-tools'] ?? [];
}

function getRequiredSkills(manifest: AgentTeamManifest): string[] {
  return manifest.require?.skills ?? [];
}

function getRequiredPrompts(manifest: AgentTeamManifest): string[] {
  return manifest.require?.prompts ?? [];
}

function getRequiredCopies(manifest: AgentTeamManifest): CopyEntry[] {
  return manifest.require?.copies ?? [];
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      signal,
    });
    child.once('error', rejectCommand);
    child.once('exit', (code, childSignal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      if (signal?.aborted) {
        rejectCommand(signal.reason);
        return;
      }
      rejectCommand(
        new Error(
          `${command} exited with ${code === null ? `signal ${childSignal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

async function waitForLock(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}

async function withInstallLock(
  root: string,
  signal: AbortSignal | undefined,
  action: () => Promise<void>,
): Promise<void> {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, '.agentlet-install-lock');
  const ownerPath = join(lockPath, 'owner');
  const owner = randomUUID();
  const deadline = Date.now() + 120_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, owner, 'utf8');
      break;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        )
      ) {
        throw error;
      }
      let lockAge: number;
      try {
        lockAge = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue;
      }
      if (lockAge > 30 * 60_000) {
        const stalePath = `${lockPath}.stale-${owner}`;
        try {
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        } catch {
          // Another waiter or the active owner changed the lock first.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for npm tools lock: ${lockPath}`);
      }
      await waitForLock(signal);
    }
  }
  const ownsLock = () => {
    try {
      return readFileSync(ownerPath, 'utf8') === owner;
    } catch {
      return false;
    }
  };
  const heartbeat = setInterval(() => {
    if (!ownsLock()) return;
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // Losing the lock is detected before release.
    }
  }, 30_000);
  heartbeat.unref();
  try {
    await action();
  } finally {
    clearInterval(heartbeat);
    if (ownsLock()) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

function ensureNpmRoot(root: string): void {
  mkdirSync(root, { recursive: true });
  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify({ private: true }, null, 2)}\n`,
      'utf8',
    );
  }
}

async function installTool(
  tool: CliToolRequirement,
  workspaceDir: string,
  log: SetupLogger,
  signal?: AbortSignal,
): Promise<void> {
  const root = resolveNpmToolsRoot(tool, workspaceDir);
  await withInstallLock(root, signal, async () => {
    if (cliToolIsReady(root, tool)) {
      log.info(`Tool already ready: ${tool.package} (${tool.scope})`);
      return;
    }
    ensureNpmRoot(root);
    await runCommand(
      'npm',
      ['install', '--prefix', root, '--save-exact', tool.package],
      root,
      signal,
    );
    if (!cliToolExecutablesExist(root, tool)) {
      throw new Error(
        `Installed package "${tool.package}" did not provide required executable(s): ${tool.executables.join(', ')}`,
      );
    }
    recordCliTool(root, tool);
    log.success(`Tool installed: ${tool.package} (${tool.scope})`);
  });
}

async function installTools(
  manifest: AgentTeamManifest,
  workspaceDir: string,
  log: SetupLogger,
  signal?: AbortSignal,
): Promise<void> {
  const cliTools = getRequiredCliTools(manifest);
  if (cliTools.length === 0) return;
  log.info(
    `Preparing tools: ${cliTools.map((tool) => tool.package).join(', ')}`,
  );
  for (const tool of cliTools) {
    await installTool(tool, workspaceDir, log, signal);
  }
}

/** Install skills declared in manifest.require.skills via `npx skills add`. */
async function installSkills(
  manifest: AgentTeamManifest,
  harness: string,
  workspaceDir: string,
  packageDir: string,
  log: SetupLogger,
  signal?: AbortSignal,
): Promise<void> {
  const skills = getRequiredSkills(manifest);
  if (skills.length === 0) return;

  const harnessInfo = getHarnessInfo(harness);
  if (!harnessInfo) {
    return;
  }

  log.info(
    `Installing skills for agent "${harnessInfo.skillsAgent}": ${skills.join(', ')}`,
  );

  for (const skill of skills) {
    // Resolve relative skill paths against packageDir
    const skillPath = skill.startsWith('.') ? resolve(packageDir, skill) : skill;
    // `npx --yes` auto-confirms the one-time install of the `skills`
    // package; the trailing `--yes` skips the skills tool's own prompts
    // (e.g. installation scope) so setup stays fully non-interactive.
    await runCommand(
      'npx',
      [
        '--yes',
        'skills',
        'add',
        skillPath,
        '--agent',
        harnessInfo.skillsAgent,
        '--yes',
      ],
      workspaceDir,
      signal,
    );
  }

  log.success('Skills installed');
}

async function runPhase(
  options: ManagedSetupOptions,
  phase: ManagedSetupPhase,
  message: string,
  action: () => void | Promise<void>,
): Promise<void> {
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase, status: 'started', message });
  await action();
  options.signal?.throwIfAborted();
  options.onProgress?.({ phase, status: 'completed', message });
}

/** Place the system prompt at the harness-specific location. */
function placeSystemPrompt(
  manifest: AgentTeamManifest,
  packageDir: string,
  workspaceDir: string,
  harness: string,
  log: SetupLogger,
): void {
  const prompts = getRequiredPrompts(manifest);
  const promptFile = prompts[0];
  if (!promptFile) {
    return;
  }

  const harnessInfo = getHarnessInfo(harness);
  if (!harnessInfo) {
    return;
  }

  const promptSource = resolve(packageDir, promptFile);

  if (!existsSync(promptSource)) {
    log.warn(`Declared prompt not found: ${promptSource}`);
    return;
  }

  distributePrompt(packageDir, workspaceDir, harness, promptFile);
  const target = getPromptTarget(harness);
  if (target) {
    log.success(`Prompt placed at ${target.dir}/${target.filename}`);
  }
}

/** Copy declared `require.copies` entries from the package into the workspace. */
function distributeCopies(
  manifest: AgentTeamManifest,
  packageDir: string,
  workspaceDir: string,
  log: SetupLogger,
): void {
  const copies = getRequiredCopies(manifest);
  if (copies.length === 0) return;

  for (const { from, to } of copies) {
    copyEntryToWorkspace(packageDir, workspaceDir, from, to);
    log.success(`Copied ${from} → ${to}`);
  }
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

/** Materialize one explicit Agent Team deployment workspace. */
export async function runManagedSetup(
  options: ManagedSetupOptions,
  callbacks: SetupCallbacks = {},
): Promise<void> {
  let manifest: AgentTeamManifest | undefined;
  await runPhase(
    options,
    'validating_manifest',
    'Validating Agent Team manifest',
    () => {
      manifest = readManifest(options.packageDir);
      resolveHarnesses(manifest, options.harness, options.log);
    },
  );

  const validatedManifest = manifest;
  if (!validatedManifest) {
    throw new Error('Agent Team manifest validation did not complete');
  }

  const { packageDir, harness, workingDirPath, log, signal } = options;
  const harnessInfo = getHarnessInfo(harness);

  await runPhase(
    options,
    'preparing_workspace',
    'Preparing deployment workspace',
    () => {
      createWorkspace(workingDirPath);
      clearManagedSetupMarker(workingDirPath);
    },
  );

  if (!harnessInfo) {
    log.warn(
      `Unknown harness '${harness}', skipping prompt placement and skills installation`,
    );
  }

  await runPhase(options, 'installing_tools', 'Installing CLI tools', () =>
    installTools(validatedManifest, workingDirPath, log, signal),
  );
  await runPhase(options, 'installing_skills', 'Installing skills', () =>
    installSkills(
      validatedManifest,
      harness,
      workingDirPath,
      packageDir,
      log,
      signal,
    ),
  );
  await runPhase(options, 'placing_prompt', 'Placing system prompt', () =>
    placeSystemPrompt(
      validatedManifest,
      packageDir,
      workingDirPath,
      harness,
      log,
    ),
  );
  await runPhase(options, 'copying_files', 'Copying declared files', () =>
    distributeCopies(validatedManifest, packageDir, workingDirPath, log),
  );

  const ctx: CallbackContext = {
    packageDir,
    manifest: validatedManifest,
    harness,
    workspaceDir: workingDirPath,
    log,
  };
  await runPhase(
    options,
    'running_custom_setup',
    'Running custom setup',
    async () => {
      await runCustomOnInstall(
        validatedManifest,
        packageDir,
        ctx,
        log,
      );
      if (callbacks.onInstall) {
        log.info('Running callback install...');
        await callbacks.onInstall(harness, workingDirPath, ctx);
      }
      if (callbacks.onUnpack) {
        log.info('Running callback unpack...');
        await callbacks.onUnpack(harness, workingDirPath, ctx);
      }
    },
  );

  markManagedSetupReady(workingDirPath, harness);
  log.success(`Workspace ready: ${workingDirPath}`);
}

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
    await runManagedSetup(
      { packageDir, harness, workingDirPath: workspaceDir, log },
      callbacks,
    );
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
      log.info('Run setup first: agentlet agent-team setup (from this folder)');
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
  if (getRequiredCliTools(manifest).length) {
    log.info(
      `CLI tools:    ${getRequiredCliTools(manifest)
        .map((tool) => `${tool.package} (${tool.installer}/${tool.scope})`)
        .join(', ')}`,
    );
  }
  if (getRequiredSkills(manifest).length) {
    log.info(`Skills:       ${getRequiredSkills(manifest).join(', ')}`);
  }
  if (getRequiredPrompts(manifest).length) {
    log.info(`Prompts:      ${getRequiredPrompts(manifest).join(', ')}`);
  }
  if (getRequiredCopies(manifest).length) {
    log.info(
      `Copies:       ${getRequiredCopies(manifest)
        .map(({ from, to }) => `${from} → ${to}`)
        .join(', ')}`,
    );
  }
  if (manifest.onInstall) log.info(`Custom setup: ${manifest.onInstall}`);
  console.log();

  for (const harness of harnesses) {
    const workspaceDir = resolveWorkspaceDir(packageDir, harness);
    const ready = isWorkspaceReady(workspaceDir);

    console.log(`  [${harness}]`);
    log.info(`  Workspace: ${ready ? '✔ ready' : '✖ not prepared'}`);
    const command = manifest.command[harness];
    log.info(`  Command:   ${command ?? '(not defined for this harness)'}`);

    if (callbacks.onDoctor && ready) {
      const ctx: CallbackContext = { packageDir, manifest, harness, workspaceDir, log };
      await callbacks.onDoctor(harness, workspaceDir, ctx);
    }

    console.log();
  }
}

/**
 * Arguments for an Agent Team setup command, decoupled from argv parsing
 * so external CLIs (e.g. the `agentlet` daemon CLI) can invoke setup
 * directly without re-parsing `process.argv`.
 *
 * The command always operates on the current working directory: it must
 * be run from inside the agent-team folder (the one containing
 * `agentlet.yaml`). There is no directory argument by design — this keeps
 * relative paths in the manifest unambiguous (always anchored to cwd).
 */
export interface SetupCommandArgs {
  command: 'setup' | 'unpack' | 'validate' | 'doctor';
  /** Specific harness to target. */
  harness?: string;
}

/**
 * Run an Agent Team setup command from explicit args (no argv parsing).
 *
 * This is the programmatic entry point used by the `agentlet agent-team`
 * subcommand. The legacy {@link runSetup} wraps this after parsing argv.
 *
 * Always operates on the current working directory; run it from inside
 * the agent-team folder.
 */
export async function runSetupCommand(
  args: SetupCommandArgs,
  callbacks: SetupCallbacks = {},
): Promise<void> {
  const packageDir = resolve('.');
  const log = createLogger();

  if (!existsSync(join(packageDir, 'agentlet.yaml'))) {
    log.error(
      'No agentlet.yaml in the current directory — run this from inside an agent-team folder.',
    );
    process.exitCode = 1;
    return;
  }

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

/**
 * Legacy entry point for per-package agent-setup.mjs scripts.
 *
 * Parses `process.argv` and delegates to {@link runSetupCommand}. Kept
 * for backward compatibility; new setups are driven declaratively from
 * the manifest via the `agentlet agent-team` subcommand.
 */
export async function runSetup(callbacks: SetupCallbacks = {}): Promise<void> {
  const args = parseSetupArgs();
  await runSetupCommand(args, callbacks);
}
