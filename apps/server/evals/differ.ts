// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Diff two `RunReport`s into a Markdown summary.
 *
 * The differ is intentionally numeric / coarse-grained: it surfaces
 * pass/fail flips, turn-count deltas, tool-call deltas, token deltas,
 * and wall-clock deltas per case. For deeper inspection the reviewer
 * opens the side-by-side per-seed `*.trace.json` files.
 *
 * "Baseline" and "current" are just two RunReport objects — the CLI
 * wires the file loading, this module is pure.
 */

import type { CaseResult, RunReport, SeedResult } from './runner.js';

interface CaseDelta {
  caseId: string;
  description: string;
  /** Status transition: 'pass→pass' / 'pass→fail' / 'fail→pass' / 'fail→fail'. */
  status: string;
  /** Average across seeds of (current − baseline). null if either side missing. */
  turnsDelta: number | null;
  toolCallsDelta: number | null;
  tokensDelta: number | null;
  /** New assertion failures (assertion ids that passed in baseline, fail now). */
  newFailures: string[];
  /** Newly-fixed assertions (failed in baseline, pass now). */
  newFixes: string[];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function meanTurns(c: CaseResult): number {
  return avg(c.seeds.map((s) => s.trace.turns));
}

function meanTools(c: CaseResult): number {
  return avg(c.seeds.map((s) => s.trace.toolCalls.length));
}

function meanTokens(c: CaseResult): number {
  return avg(c.seeds.map((s) => s.trace.usage?.total ?? 0));
}

function failedAssertionIds(c: CaseResult): Set<string> {
  // Treat an assertion id as "failed" if it failed in any seed.
  const ids = new Set<string>();
  for (const s of c.seeds) {
    for (const r of s.assertions) {
      if (!r.pass) ids.add(r.id);
    }
  }
  return ids;
}

function diffCase(
  baseline: CaseResult | undefined,
  current: CaseResult | undefined,
): CaseDelta {
  // At least one side must be present — `diffCase` is only called for
  // ids drawn from `baseline ∪ current`.
  const reference = current ?? baseline;
  if (!reference) {
    throw new Error('diffCase called with both sides undefined');
  }
  const id = reference.caseId;
  const description = reference.description;

  const baseStatus = baseline ? (baseline.pass ? 'pass' : 'fail') : '—';
  const curStatus = current ? (current.pass ? 'pass' : 'fail') : '—';
  const status = `${baseStatus}→${curStatus}`;

  const turnsDelta =
    baseline && current
      ? Number((meanTurns(current) - meanTurns(baseline)).toFixed(2))
      : null;
  const toolCallsDelta =
    baseline && current
      ? Number((meanTools(current) - meanTools(baseline)).toFixed(2))
      : null;
  const tokensDelta =
    baseline && current
      ? Math.round(meanTokens(current) - meanTokens(baseline))
      : null;

  const baseFails = baseline ? failedAssertionIds(baseline) : new Set<string>();
  const curFails = current ? failedAssertionIds(current) : new Set<string>();
  const newFailures = [...curFails].filter((id) => !baseFails.has(id));
  const newFixes = [...baseFails].filter((id) => !curFails.has(id));

  return {
    caseId: id,
    description,
    status,
    turnsDelta,
    toolCallsDelta,
    tokensDelta,
    newFailures,
    newFixes,
  };
}

function fmtDelta(n: number | null, opts: { suffix?: string } = {}): string {
  if (n === null) return '—';
  if (n === 0) return '0';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}${opts.suffix ?? ''}`;
}

function snippetForSeed(s: SeedResult): string {
  const tools =
    s.trace.toolCalls.map((c) => c.name).join(' → ') || '(no tools)';
  return `seed#${s.seed}: turns=${s.trace.turns} tools=[${tools}]`;
}

/**
 * Render a Markdown diff. Sections:
 *   1. Header with both RunReport identifiers.
 *   2. Per-case table of deltas.
 *   3. Regression detail blocks for any case with a new failure or
 *      flipped from pass→fail.
 */
export function renderDiff(
  baseline: RunReport,
  current: RunReport,
  opts: { baselineLabel?: string; currentLabel?: string } = {},
): string {
  const baseLabel =
    opts.baselineLabel ??
    `${baseline.branch ?? 'unknown'}@${baseline.commit ?? '?'}`;
  const curLabel =
    opts.currentLabel ??
    `${current.branch ?? 'unknown'}@${current.commit ?? '?'}`;

  const baselineById = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const currentById = new Map(current.cases.map((c) => [c.caseId, c]));
  const allIds = new Set([...baselineById.keys(), ...currentById.keys()]);

  const deltas: CaseDelta[] = [];
  for (const id of [...allIds].sort()) {
    deltas.push(diffCase(baselineById.get(id), currentById.get(id)));
  }

  const lines: string[] = [];
  lines.push(`# Eval diff: ${baseLabel} → ${curLabel}`);
  lines.push('');
  lines.push(
    `_Baseline: ${baseline.startedAt} · Current: ${current.startedAt}_`,
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(
    '| case | status | turns Δ | tools Δ | tokens Δ | regressions | fixes |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const d of deltas) {
    lines.push(
      `| \`${d.caseId}\` | ${d.status} | ${fmtDelta(d.turnsDelta)} | ${fmtDelta(
        d.toolCallsDelta,
      )} | ${fmtDelta(d.tokensDelta)} | ${
        d.newFailures.length > 0 ? d.newFailures.length : '—'
      } | ${d.newFixes.length > 0 ? d.newFixes.length : '—'} |`,
    );
  }
  lines.push('');

  // Regression detail
  const regressions = deltas.filter(
    (d) => d.newFailures.length > 0 || d.status === 'pass→fail',
  );
  if (regressions.length > 0) {
    lines.push('## Regressions');
    lines.push('');
    for (const d of regressions) {
      const cur = currentById.get(d.caseId);
      const base = baselineById.get(d.caseId);
      lines.push(`### \`${d.caseId}\` — ${d.description}`);
      lines.push('');
      if (d.newFailures.length > 0) {
        lines.push(
          `- New failures: ${d.newFailures.map((id) => `\`${id}\``).join(', ')}`,
        );
      }
      if (cur) {
        lines.push('- Current seeds:');
        for (const s of cur.seeds) lines.push(`  - ${snippetForSeed(s)}`);
      }
      if (base) {
        lines.push('- Baseline seeds:');
        for (const s of base.seeds) lines.push(`  - ${snippetForSeed(s)}`);
      }
      lines.push('');
    }
  }

  // Newly-fixed cases (only call out when a regression existed)
  const fixes = deltas.filter(
    (d) => d.newFixes.length > 0 || d.status === 'fail→pass',
  );
  if (fixes.length > 0) {
    lines.push('## Fixes');
    lines.push('');
    for (const d of fixes) {
      lines.push(
        `- \`${d.caseId}\`: ${d.status}${
          d.newFixes.length > 0
            ? ` (now passing: ${d.newFixes.map((id) => `\`${id}\``).join(', ')})`
            : ''
        }`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
