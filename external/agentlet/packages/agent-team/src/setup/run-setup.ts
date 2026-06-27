/**
 * Main entry point for Agent Team setup scripts.
 *
 * Per-package agent-setup.mjs calls `runSetup(callbacks)` and the runtime
 * handles everything else: arg parsing, manifest reading, harness resolution,
 * workspace creation, and callback orchestration.
 */

import { resolve } from 'node:path';
import { parseSetupArgs } from './cli.js';
import { detectInstalledHarnesses } from './harness.js';
import { readManifest } from './manifest.js';
import type { CallbackContext, SetupCallbacks, SetupLogger } from './types.js';
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

/** Run the `unpack` command. */
async function runUnpack(
  packageDir: string,
  requestedHarness: string | undefined,
  callbacks: SetupCallbacks,
  log: SetupLogger,
): Promise<void> {
  const manifest = readManifest(packageDir);
  const harnesses = resolveHarnesses(manifest, requestedHarness, log);

  console.log(`\nUnpacking "${manifest.name}" for: ${harnesses.join(', ')}\n`);

  for (const harness of harnesses) {
    log.info(`Preparing workspace for "${harness}"...`);
    const workspaceDir = resolveWorkspaceDir(packageDir, harness);

    createWorkspace(workspaceDir);
    distributePrompt(packageDir, workspaceDir, harness);

    const ctx: CallbackContext = { packageDir, manifest, log };

    if (callbacks.onInstall) {
      log.info('Running install...');
      await callbacks.onInstall(harness, workspaceDir, ctx);
    }

    if (callbacks.onUnpack) {
      log.info('Running unpack...');
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
      log.info('Run `node agent-setup.mjs unpack` first');
      allValid = false;
      continue;
    }

    log.success(`Workspace exists for "${harness}"`);

    if (callbacks.onValidate) {
      try {
        const ctx: CallbackContext = { packageDir, manifest, log };
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

  log.info(`Package:   ${manifest.name}`);
  log.info(`Schema:    ${manifest.schema}`);
  log.info(`Harnesses: ${harnesses.join(', ')}`);
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
      const ctx: CallbackContext = { packageDir, manifest, log };
      await callbacks.onDoctor(harness, workspaceDir, ctx);
    }

    console.log();
  }
}

/**
 * Main entry point for per-package agent-setup.mjs scripts.
 *
 * Usage in agent-setup.mjs:
 * ```js
 * import { runSetup } from '@agentlet/agent-team-runtime';
 *
 * runSetup({
 *   onInstall(ctx) { ... },
 *   onUnpack(ctx)  { ... },
 * });
 * ```
 */
export async function runSetup(callbacks: SetupCallbacks = {}): Promise<void> {
  const args = parseSetupArgs();
  const packageDir = resolve('.');
  const log = createLogger();

  try {
    switch (args.command) {
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
