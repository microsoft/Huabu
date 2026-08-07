// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Runner orchestration.
 *
 * Iterates discovered cases, prepares each fixture, drives `runAgent`
 * via {@link recordTrace}, evaluates assertions, and writes the
 * resulting `RunReport` to disk. The CLI wraps this with arg parsing
 * and post-run actions (baseline save, diff).
 *
 * Cases run **sequentially**. The workspace path is global state on the
 * server side (`workspace.ts`) — concurrent eval runs would clobber it.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  allPassed,
  evaluateAssertions,
  type AssertionResult,
} from './assertions.js';
import { discoverCases, type LoadedCase } from './case-loader.js';
import { prepareFixture } from './fixture.js';
import { recordTrace, type Trace } from './trace.js';

export interface SeedResult {
  seed: number;
  trace: Trace;
  assertions: AssertionResult[];
  pass: boolean;
}

export interface CaseResult {
  caseId: string;
  description: string;
  /** Aggregate pass: all seeds for this case passed all assertions. */
  pass: boolean;
  seeds: SeedResult[];
}

export interface RunReport {
  /** ISO timestamp marking when the run started. */
  startedAt: string;
  /** Total wall-clock elapsed (ms) for the entire run. */
  elapsedMs: number;
  /** Git revision (`git rev-parse --short HEAD`) or null if unavailable. */
  commit: string | null;
  /** Active git branch or null if unavailable. */
  branch: string | null;
  /** Aggregate pass: every case passed. */
  pass: boolean;
  cases: CaseResult[];
}

export interface RunOptions {
  /** Absolute path to `evals/cases/` */
  casesDir: string;
  /** Absolute path to `evals/fixtures/` */
  fixturesDir: string;
  /** Absolute path where the report (and per-trace dump) should be written. */
  outputDir: string;
  /** When set, only cases with these ids are run. */
  filter?: string[];
  /** Optional logger; defaults to `console`. */
  log?: (msg: string) => void;
}

function gitInfo(): { commit: string | null; branch: string | null } {
  try {
    const commit = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return { commit, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

async function runCase(
  loaded: LoadedCase,
  opts: { fixturesDir: string; log: (msg: string) => void },
): Promise<CaseResult> {
  const { def } = loaded;
  const seeds: SeedResult[] = [];

  for (let seed = 0; seed < def.seeds; seed++) {
    opts.log(`  seed ${seed + 1}/${def.seeds} …`);
    const fixture = prepareFixture(opts.fixturesDir, def.fixture);
    try {
      const trace = await recordTrace({
        caseId: def.id,
        seed,
        mode: def.mode,
        canvasId: def.canvasId,
        prompt: def.prompt,
        maxIterations: def.maxIterations,
      });
      const assertions = evaluateAssertions(trace, def.assertions);
      const pass = allPassed(assertions) && trace.error === null;
      seeds.push({ seed, trace, assertions, pass });
      const status = pass ? 'PASS' : 'FAIL';
      const failed = assertions.filter((r) => !r.pass).map((r) => r.id);
      opts.log(
        `    ${status}  turns=${trace.turns} tools=${trace.toolCalls.length}${
          failed.length > 0 ? `  failed=[${failed.join(', ')}]` : ''
        }${trace.error ? `  error=${trace.error}` : ''}`,
      );
    } finally {
      fixture.cleanup();
    }
  }

  return {
    caseId: def.id,
    description: def.description,
    pass: seeds.every((s) => s.pass),
    seeds,
  };
}

/**
 * Run every discovered case (or the filtered subset) and write a
 * single `report.json` plus one `<caseId>-seed<N>.trace.json` per
 * seed into `outputDir`.
 */
export async function runAll(opts: RunOptions): Promise<RunReport> {
  const log = opts.log ?? ((m) => console.log(m));
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const cases = discoverCases(opts.casesDir, opts.filter);

  log(`Discovered ${cases.length} case(s).`);
  mkdirSync(opts.outputDir, { recursive: true });

  const results: CaseResult[] = [];
  for (const loaded of cases) {
    log(`▶ ${loaded.def.id} — ${loaded.def.description}`);
    const caseResult = await runCase(loaded, {
      fixturesDir: opts.fixturesDir,
      log,
    });
    results.push(caseResult);
    // Persist per-seed traces eagerly so a crash mid-run does not
    // discard everything we already collected.
    for (const seed of caseResult.seeds) {
      const traceFile = path.join(
        opts.outputDir,
        `${caseResult.caseId}-seed${seed.seed}.trace.json`,
      );
      writeFileSync(traceFile, JSON.stringify(seed.trace, null, 2));
    }
  }

  const elapsedMs = Date.now() - startedAtMs;
  const { commit, branch } = gitInfo();
  const report: RunReport = {
    startedAt,
    elapsedMs,
    commit,
    branch,
    pass: results.every((c) => c.pass),
    cases: results,
  };
  writeFileSync(
    path.join(opts.outputDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  const passed = results.filter((c) => c.pass).length;
  log('');
  log(
    `Done. ${passed}/${results.length} case(s) passed in ${(elapsedMs / 1000).toFixed(1)}s.`,
  );
  log(`Report written to: ${opts.outputDir}`);

  return report;
}
