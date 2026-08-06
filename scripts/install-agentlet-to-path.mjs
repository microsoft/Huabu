#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * postinstall hook — make the `bin/` wrappers (`agentlet` and
 * `start-agentlet-daemon`) discoverable on the user's PATH so first-time
 * setup is "pnpm install && pnpm dev" instead of "pnpm install, then
 * manually edit your shell rc, then pnpm dev". We add the whole `bin/`
 * directory, so both wrappers become available at once.
 *
 * Behaviour:
 *  • POSIX (macOS / Linux / WSL / Git Bash on Windows):
 *      - Detect the user's shell via $SHELL.
 *      - Append a `# Added by Huabu — agentlet CLI` block to the
 *        appropriate rc file (`~/.zshrc`, `~/.bashrc`, fish config).
 *      - Idempotent: skip if the sentinel comment already exists OR
 *        if `bin/agentlet`'s absolute path is already mentioned.
 *  • Windows (native cmd.exe / PowerShell):
 *      - Use PowerShell to prepend `bin/` to the user-scope PATH
 *        environment variable. (The wrapper script itself is POSIX
 *        sh and only runs under Git Bash / WSL, but Git Bash inherits
 *        Windows User PATH so this is still useful.)
 *
 * Safety rails — the script silently exits when:
 *  • bin/ is already on PATH for the current process (nothing to do).
 *  • CI=true (or CI=1) — never modify CI shell configs.
 *  • HUABU_NO_AUTO_PATH=1 — explicit opt-out.
 *  • The probe fails for any reason — we print a manual hint and
 *    continue so `pnpm install` itself never fails.
 *
 * This file is intentionally dependency-free (only Node.js stdlib) so
 * it runs BEFORE workspace packages are built.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL = '# Added by Huabu — agentlet CLI';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const binDir = path.join(repoRoot, 'bin');

function log(msg) {
  process.stdout.write(`[agentlet/postinstall] ${msg}\n`);
}

function shouldSkipForEnv() {
  if (process.env.HUABU_NO_AUTO_PATH === '1') {
    return 'HUABU_NO_AUTO_PATH=1';
  }
  if (process.env.CI === 'true' || process.env.CI === '1') {
    return 'CI environment detected';
  }
  return null;
}

function isAlreadyOnPath() {
  const sep = platform() === 'win32' ? ';' : ':';
  const pathEnv = process.env.PATH || '';
  return pathEnv
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => {
      try {
        return path.resolve(p) === path.resolve(binDir);
      } catch {
        return false;
      }
    });
}

function installPosix() {
  const shell = process.env.SHELL || '';
  let rcPath;
  let snippet;
  if (shell.endsWith('/fish') || shell.endsWith('\\fish')) {
    const dir = path.join(homedir(), '.config', 'fish');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rcPath = path.join(dir, 'config.fish');
    snippet = `\n${SENTINEL}\nfish_add_path "${binDir}"\n`;
  } else if (shell.endsWith('/zsh') || shell.endsWith('\\zsh')) {
    rcPath = path.join(homedir(), '.zshrc');
    snippet = `\n${SENTINEL}\nexport PATH="${binDir}:$PATH"\n`;
  } else {
    // Default to bash. On macOS bash users typically also (or only)
    // have `~/.bash_profile`; for a single safe default we use
    // `~/.bashrc` and leave the existing chain alone. Users who want
    // a different file can set HUABU_NO_AUTO_PATH=1 and add it
    // themselves.
    rcPath = path.join(homedir(), '.bashrc');
    snippet = `\n${SENTINEL}\nexport PATH="${binDir}:$PATH"\n`;
  }

  if (existsSync(rcPath)) {
    const content = readFileSync(rcPath, 'utf8');
    if (content.includes(SENTINEL) || content.includes(binDir)) {
      return { skipped: true, reason: 'already in shell rc', rcPath };
    }
  }

  appendFileSync(rcPath, snippet);
  return { skipped: false, rcPath };
}

function installWindows() {
  // PowerShell can read/write user-scope environment variables
  // persistently. We deliberately keep the script tiny and inline
  // so we never depend on a temp file.
  const escaped = binDir.replace(/'/g, "''");
  const ps = [
    `$bin = '${escaped}'`,
    `$current = [Environment]::GetEnvironmentVariable('Path', 'User')`,
    `if ($null -eq $current) { $current = '' }`,
    `if ($current.Split(';') -contains $bin) {`,
    `  Write-Output 'HUABU_PATH_RESULT=ALREADY_PRESENT'`,
    `} else {`,
    `  $next = if ($current -ne '') { "$bin;$current" } else { $bin }`,
    `  [Environment]::SetEnvironmentVariable('Path', $next, 'User')`,
    `  Write-Output 'HUABU_PATH_RESULT=UPDATED'`,
    `}`,
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { timeout: 8_000, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `PowerShell exited with status ${result.status}: ${result.stderr || result.stdout || '<no output>'}`,
    );
  }
  const stdout = result.stdout || '';
  if (stdout.includes('HUABU_PATH_RESULT=ALREADY_PRESENT')) {
    return { skipped: true, reason: 'already in User PATH' };
  }
  return { skipped: false, rcPath: 'User PATH (Windows registry)' };
}

function main() {
  // Sanity check: the wrapper must actually exist (we only ship the
  // `bin/agentlet` pass-through in a full checkout; if for some reason
  // the user is installing a stripped-down checkout, skip silently).
  if (!existsSync(path.join(binDir, 'agentlet'))) {
    return;
  }

  const skipReason = shouldSkipForEnv();
  if (skipReason) {
    log(`skipping PATH install (${skipReason}).`);
    log(`to use agentlet, prepend "${binDir}" to your PATH manually.`);
    return;
  }

  if (isAlreadyOnPath()) {
    log(`bin/ already on PATH — nothing to do.`);
    return;
  }

  try {
    const result = platform() === 'win32' ? installWindows() : installPosix();
    if (result.skipped) {
      log(
        `already configured (${result.reason}). Open a new terminal to pick it up.`,
      );
    } else {
      log(`added "${binDir}" to PATH (${result.rcPath}).`);
      log(
        `open a new terminal — or run "source ${result.rcPath}" — for "agentlet" to be recognized.`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`could not auto-install to PATH: ${msg}`);
    log(`to use agentlet, prepend "${binDir}" to your PATH manually.`);
    // Never fail the install over this — the wrapper still works via
    // its absolute path; the Settings UI even copies that path
    // automatically when "agentlet" isn't on PATH.
  }
}

main();
