// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Eval case schema + YAML loader.
 *
 * A case is a self-contained scenario: a fixture (mini vault) + a user
 * prompt + a list of assertions to run against the resulting agent
 * trace. Cases are authored as YAML in `evals/cases/*.yml` so that
 * humans, the agent, and external tooling can all read / diff them.
 *
 * The runtime contract is captured by a single zod schema so a typo
 * in a case file fails loudly with a helpful path-prefixed message.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parse as yamlParse } from 'yaml';
import { z } from 'zod';

// ─── Assertion variants ─────────────────────────────────────────────────────
//
// Each `kind` corresponds to one entry in `assertions.ts`'s dispatch
// table. New assertion kinds belong on both ends.

const toolCalledAssertion = z.object({
  kind: z.literal('tool_called'),
  /** Tool name that must appear at least once in the trace. */
  name: z.string().min(1),
  /**
   * Optional path predicate. Currently a literal-equals match against
   * `args.path` (case-sensitive, after string coercion). Useful for
   * pinning `read("nodes/<safeLabel>.md")` calls.
   */
  pathEquals: z.string().optional(),
  /**
   * Optional substring predicate against `args.path`. Use when the
   * exact filename varies (e.g. dedupe suffixes).
   */
  pathContains: z.string().optional(),
  /** Lower bound on the number of matching calls. Default: 1. */
  minTimes: z.number().int().min(1).optional(),
});

const toolSucceededAssertion = z.object({
  kind: z.literal('tool_succeeded'),
  /** Tool name; at least one matching call must have `ok: true`. */
  name: z.string().min(1),
});

const responseContainsAssertion = z.object({
  kind: z.literal('response_contains'),
  /**
   * Pass when the final assistant text contains ANY of these
   * substrings (case-insensitive). Use to verify the agent grounded
   * its reply in fixture content without forcing a single phrasing.
   */
  anyOf: z.array(z.string().min(1)).min(1),
});

const maxTurnsAssertion = z.object({
  kind: z.literal('max_turns'),
  /** Inclusive upper bound on `turns`. */
  max: z.number().int().min(1),
});

const noErrorAssertion = z.object({
  kind: z.literal('no_error'),
});

const commandEmittedAssertion = z.object({
  kind: z.literal('command_emitted'),
  /**
   * Canvas command type that must appear in some `space_commands` call.
   * `tool_called` can only see the tool name, which for `space_commands`
   * says nothing about what the agent actually asked for — the whole
   * decision lives in the arguments.
   */
  type: z.string().min(1),
  /**
   * Optional literal field predicates on the matched command, e.g.
   * `{ mode: grid }`. All listed fields must match.
   */
  where: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /**
   * Optional dotted paths that must be present and non-empty on the
   * matched command, e.g. `cells`. Distinguishes "chose the right
   * command" from "chose it and supplied the payload that makes it do
   * anything".
   */
  hasNonEmpty: z.array(z.string().min(1)).optional(),
});

export const assertionSchema = z.discriminatedUnion('kind', [
  toolCalledAssertion,
  toolSucceededAssertion,
  responseContainsAssertion,
  maxTurnsAssertion,
  noErrorAssertion,
  commandEmittedAssertion,
]);

export type Assertion = z.infer<typeof assertionSchema>;

// ─── Case ───────────────────────────────────────────────────────────────────

export const caseSchema = z.object({
  /** Stable identifier; doubles as the run output filename. Must be filesystem-safe. */
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/i,
      'case id must match /^[a-z0-9][a-z0-9._-]*$/i',
    ),
  /** One-line human-facing description (rendered in the report). */
  description: z.string().min(1),
  /** Agent surface to invoke. */
  mode: z.enum(['ask', 'operate']),
  /**
   * Fixture directory name under `evals/fixtures/`. The runner copies
   * its contents into a temp workspace before each run.
   */
  fixture: z.string().min(1),
  /**
   * Canvas id within the fixture. Defaults to `default-canvas` (matches
   * the convention used by `apps/server/data/vault/`).
   */
  canvasId: z.string().min(1).default('default-canvas'),
  /** Number of independent runs per case. Each run gets its own seed index. */
  seeds: z.number().int().min(1).max(10).default(1),
  /** Soft cap on agent turns; passes straight through to `runAgent`. */
  maxIterations: z.number().int().min(1).max(50).default(10),
  /** The user message sent to the agent. Single string; no attachments. */
  prompt: z.string().min(1),
  /** Assertions evaluated against each seed's trace. */
  assertions: z.array(assertionSchema).min(1),
});

export type CaseDefinition = z.infer<typeof caseSchema>;

// ─── Loader ─────────────────────────────────────────────────────────────────

export interface LoadedCase {
  /** The validated case definition. */
  def: CaseDefinition;
  /** Absolute path of the source YAML — used in error reporting. */
  sourcePath: string;
}

/** Parse + validate a single YAML file. */
export function loadCaseFile(filePath: string): LoadedCase {
  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML in ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const result = caseSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid case file ${filePath}:\n${issues}`);
  }
  return { def: result.data, sourcePath: filePath };
}

/**
 * Discover cases under `evals/cases/`.
 *
 * Optional `filter`: array of case ids; when present, only matching
 * cases are returned (the runner uses this for `--case` selection).
 */
export function discoverCases(
  casesDir: string,
  filter?: string[],
): LoadedCase[] {
  if (!statSync(casesDir).isDirectory()) {
    throw new Error(`cases directory not found: ${casesDir}`);
  }
  const wanted = filter && filter.length > 0 ? new Set(filter) : null;
  const entries = readdirSync(casesDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  const out: LoadedCase[] = [];
  for (const name of entries) {
    const full = path.join(casesDir, name);
    const loaded = loadCaseFile(full);
    if (wanted && !wanted.has(loaded.def.id)) continue;
    out.push(loaded);
  }
  if (wanted) {
    const found = new Set(out.map((c) => c.def.id));
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`No case files matched: ${missing.join(', ')}`);
    }
  }
  return out;
}
