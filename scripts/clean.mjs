#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Full workspace reset: removes build artifacts AND every package's
// node_modules (root + all workspace packages). Requires a reinstall
// (`pnpm install`) afterwards.
//
// Implemented as a plain Node script rather than a `pnpm -r exec ...`
// one-liner so it works on any pnpm version (no dependency on recursive
// `exec` / filter syntax that varies across releases) and is fully
// cross-platform (no rm -rf / rimraf dependency).
//
// Run with:  pnpm run clean
//        or: pnpm run clean -- --dry-run   (list what would be removed)
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dryRun =
  process.argv.includes('--dry-run') || process.argv.includes('-n');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directory names to delete wherever they sit at a package root. */
const ARTIFACT_DIRS = [
  'node_modules',
  'dist',
  'dist-bundle',
  'dist-electron',
  'build',
  'release',
  'out',
  'coverage',
  '.nyc_output',
  '.turbo',
];

/**
 * Expand the workspace package globs from pnpm-workspace.yaml into
 * concrete directories. Supports plain paths and a single trailing
 * `/*` (the only glob shape this workspace uses) without pulling in a
 * YAML or glob dependency.
 */
function resolveWorkspaceDirs() {
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = raw.match(/^\s+-\s+['"]?([^'"]+?)['"]?\s*$/);
      if (m) {
        patterns.push(m[1]);
        continue;
      }
      // A non-indented, non-list line ends the packages block.
      if (raw.trim() !== '' && !/^\s/.test(raw)) inPackages = false;
    }
  }

  const dirs = new Set([repoRoot]);
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = join(repoRoot, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) {
        const full = join(base, name);
        if (statSync(full).isDirectory()) dirs.add(full);
      }
    } else {
      const full = join(repoRoot, pattern);
      if (existsSync(full)) dirs.add(full);
    }
  }
  return [...dirs];
}

function remove(target, label) {
  if (!existsSync(target)) return false;
  if (dryRun) {
    console.log(`  would remove ${label}`);
    return true;
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`  removed ${label}`);
  return true;
}

function rel(p) {
  return p === repoRoot
    ? '.'
    : p.slice(repoRoot.length + 1).replace(/\\/g, '/');
}

let count = 0;
for (const dir of resolveWorkspaceDirs()) {
  for (const name of ARTIFACT_DIRS) {
    if (remove(join(dir, name), `${rel(dir)}/${name}`)) count++;
  }
  // *.tsbuildinfo files at the package root.
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.tsbuildinfo')) {
        if (remove(join(dir, name), `${rel(dir)}/${name}`)) count++;
      }
    }
  }
}

console.log(
  count === 0
    ? 'Nothing to clean.'
    : dryRun
      ? `Would clean ${count} item(s).`
      : `Cleaned ${count} item(s). Run "pnpm install" to restore dependencies.`,
);
