// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Eval CLI.
 *
 * Subcommands:
 *   run [--case id1,id2]                    Run all cases (or filtered subset),
 *                                           write report+traces to runs/<ts>/.
 *   baseline <name> [--case id1,id2]        Run, then save the report+traces to
 *                                           baselines/<name>/ for later diffing.
 *   diff <name> [--case id1,id2]            Run, then diff the result against
 *                                           baselines/<name>/report.json and
 *                                           print a Markdown report to stdout.
 *   list                                    Print available cases and baselines.
 *
 * The runner is invoked from inside this file so all three subcommands
 * share identical case-discovery / fixture / trace plumbing.
 *
 * Note: this script imports server modules (workspace, storage, agent),
 * so it MUST be executed via `tsx` and load env first.
 */

import './load-env-bootstrap.js';

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDiff } from './differ.js';
import { runAll, type RunReport } from './runner.js';
import { initializeSecretStore } from '../src/security/secret-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(HERE, 'cases');
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const RUNS_DIR = path.join(HERE, 'runs');
const BASELINES_DIR = path.join(HERE, 'baselines');

interface ParsedArgs {
  command: 'run' | 'baseline' | 'diff' | 'list' | 'help';
  positional: string[];
  filter: string[] | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    return { command: 'help', positional: [], filter: undefined };
  }
  const command = args.shift() as ParsedArgs['command'];
  const positional: string[] = [];
  let filter: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--case' || a === '--cases') {
      const val = args[++i];
      if (!val) throw new Error(`${a} requires a comma-separated list of ids`);
      filter = val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith('--case=')) {
      filter = a
        .slice('--case='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      positional.push(a);
    }
  }
  return { command, positional, filter };
}

function timestampId(): string {
  // Local-time timestamp safe for filesystem use across all platforms.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm eval run [--case id1,id2]
  pnpm eval baseline <name> [--case id1,id2]
  pnpm eval diff <name> [--case id1,id2]
  pnpm eval list

Output:
  Per-run reports under  apps/server/evals/runs/<timestamp>/
  Named baselines under  apps/server/evals/baselines/<name>/
`);
}

function listCommand(): void {
  console.log('Cases:');
  if (!existsSync(CASES_DIR)) {
    console.log('  (cases/ does not exist)');
  } else {
    for (const name of readdirSync(CASES_DIR).sort()) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) {
        console.log(`  - ${name}`);
      }
    }
  }
  console.log('');
  console.log('Baselines:');
  if (!existsSync(BASELINES_DIR)) {
    console.log('  (baselines/ does not exist)');
    return;
  }
  for (const name of readdirSync(BASELINES_DIR).sort()) {
    const p = path.join(BASELINES_DIR, name);
    if (statSync(p).isDirectory()) {
      const reportPath = path.join(p, 'report.json');
      if (existsSync(reportPath)) {
        const r = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport;
        console.log(
          `  - ${name}  (${r.startedAt}, ${r.cases.length} case(s), ${r.pass ? 'pass' : 'fail'})`,
        );
      } else {
        console.log(`  - ${name}  (no report.json)`);
      }
    }
  }
}

async function runCommand(filter: string[] | undefined): Promise<{
  outputDir: string;
  report: RunReport;
}> {
  // The server boots this during startup; the eval CLI is a second entry
  // point into the same code, so without it every case dies at the first
  // credential read with "Secret store has not been initialized" —
  // before any model call, which reads as a case failure rather than a
  // setup failure.
  await initializeSecretStore();
  const outputDir = path.join(RUNS_DIR, timestampId());
  const report = await runAll({
    casesDir: CASES_DIR,
    fixturesDir: FIXTURES_DIR,
    outputDir,
    filter,
  });
  return { outputDir, report };
}

async function baselineCommand(
  name: string,
  filter: string[] | undefined,
): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid baseline name "${name}". Use only letters, digits, dot, dash, underscore.`,
    );
  }
  const { outputDir } = await runCommand(filter);

  const dest = path.join(BASELINES_DIR, name);
  // Replace any existing baseline with the same name. The user
  // explicitly passed it as the destination, so this is intentional.
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(BASELINES_DIR, { recursive: true });
  cpSync(outputDir, dest, { recursive: true });
  console.log(`Saved baseline → ${dest}`);
}

async function diffCommand(
  name: string,
  filter: string[] | undefined,
): Promise<void> {
  const baselineReportPath = path.join(BASELINES_DIR, name, 'report.json');
  if (!existsSync(baselineReportPath)) {
    throw new Error(
      `Baseline not found: ${baselineReportPath}. ` +
        `Run \`pnpm eval baseline ${name}\` first.`,
    );
  }
  const baseline = JSON.parse(
    readFileSync(baselineReportPath, 'utf8'),
  ) as RunReport;

  const { outputDir, report } = await runCommand(filter);
  const md = renderDiff(baseline, report, {
    baselineLabel: `baseline:${name}`,
    currentLabel: `current:${path.basename(outputDir)}`,
  });
  const diffPath = path.join(outputDir, 'diff.md');
  writeFileSync(diffPath, md);
  console.log('');
  console.log(md);
  console.log('');
  console.log(`Diff written to: ${diffPath}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  switch (parsed.command) {
    case 'help':
      printHelp();
      return;
    case 'list':
      listCommand();
      return;
    case 'run': {
      const { outputDir, report } = await runCommand(parsed.filter);
      process.exitCode = report.pass ? 0 : 1;
      return void outputDir;
    }
    case 'baseline': {
      const name = parsed.positional[0];
      if (!name) throw new Error('baseline requires a name argument');
      await baselineCommand(name, parsed.filter);
      return;
    }
    case 'diff': {
      const name = parsed.positional[0];
      if (!name) throw new Error('diff requires a baseline name argument');
      await diffCommand(name, parsed.filter);
      return;
    }
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(2);
});
