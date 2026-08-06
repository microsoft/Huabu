// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Assertion evaluator.
 *
 * Each `Assertion` from `case-loader.ts` is mapped to a small pure
 * function that consumes a `Trace` and returns a `AssertionResult`.
 * The runner aggregates results into the per-seed report; the differ
 * uses the boolean pass/fail field to colour the cell.
 */

import type { Assertion } from './case-loader.js';
import type { Trace } from './trace.js';

export interface AssertionResult {
  /** Stable identifier including discriminating fields (e.g. `tool_called:read`). */
  id: string;
  pass: boolean;
  /** Human-readable explanation; only meaningful when `pass: false`. */
  detail?: string;
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  const v = args['path'];
  return typeof v === 'string' ? v : null;
}

export function evaluateAssertions(
  trace: Trace,
  assertions: Assertion[],
): AssertionResult[] {
  return assertions.map((a) => evaluateOne(trace, a));
}

function evaluateOne(trace: Trace, a: Assertion): AssertionResult {
  switch (a.kind) {
    case 'tool_called': {
      const id = `tool_called:${a.name}${
        a.pathEquals
          ? `(path=${a.pathEquals})`
          : a.pathContains
            ? `(path~=${a.pathContains})`
            : ''
      }`;
      const matches = trace.toolCalls.filter((c) => {
        if (c.name !== a.name) return false;
        const p = pathFromArgs(c.args);
        if (a.pathEquals !== undefined && p !== a.pathEquals) return false;
        if (
          a.pathContains !== undefined &&
          (p === null || !p.includes(a.pathContains))
        ) {
          return false;
        }
        return true;
      });
      const minTimes = a.minTimes ?? 1;
      if (matches.length >= minTimes) return { id, pass: true };
      return {
        id,
        pass: false,
        detail:
          `expected ≥${minTimes} matching call(s); got ${matches.length}. ` +
          `Observed ${a.name} calls: ${
            trace.toolCalls
              .filter((c) => c.name === a.name)
              .map((c) => JSON.stringify(c.args))
              .join(' | ') || '(none)'
          }`,
      };
    }

    case 'tool_succeeded': {
      const id = `tool_succeeded:${a.name}`;
      const calls = trace.toolCalls.filter((c) => c.name === a.name);
      if (calls.length === 0) {
        return { id, pass: false, detail: `no ${a.name} call recorded` };
      }
      if (calls.some((c) => c.ok)) return { id, pass: true };
      return {
        id,
        pass: false,
        detail:
          `all ${a.name} calls returned isError=true. ` +
          `Last preview: ${calls[calls.length - 1].resultPreview.slice(0, 200)}`,
      };
    }

    case 'response_contains': {
      const haystack = trace.finalText.toLowerCase();
      const matched = a.anyOf.find((needle) =>
        haystack.includes(needle.toLowerCase()),
      );
      const id = `response_contains:[${a.anyOf.join('|')}]`;
      if (matched) return { id, pass: true, detail: `matched "${matched}"` };
      return {
        id,
        pass: false,
        detail: `final text contained none of: ${a.anyOf.join(', ')}`,
      };
    }

    case 'max_turns': {
      const id = `max_turns:${a.max}`;
      if (trace.turns <= a.max) return { id, pass: true };
      return {
        id,
        pass: false,
        detail: `trace.turns=${trace.turns} > max=${a.max}`,
      };
    }

    case 'no_error': {
      const id = 'no_error';
      if (trace.error === null) return { id, pass: true };
      return { id, pass: false, detail: trace.error };
    }

    case 'command_emitted': {
      const where = a.where ?? {};
      const id = `command_emitted:${a.type}${
        Object.keys(where).length > 0
          ? `(${Object.entries(where)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(',')})`
          : ''
      }${a.hasNonEmpty?.length ? `[${a.hasNonEmpty.join(',')}]` : ''}`;

      const emitted = trace.toolCalls
        .filter((c) => c.name === 'space_commands')
        .flatMap((c) => {
          const commands = c.args['commands'];
          return Array.isArray(commands)
            ? (commands as Array<Record<string, unknown>>)
            : [];
        });

      const matched = emitted.filter((cmd) => {
        if (cmd['type'] !== a.type) return false;
        for (const [key, value] of Object.entries(where)) {
          if (cmd[key] !== value) return false;
        }
        for (const field of a.hasNonEmpty ?? []) {
          const v = cmd[field];
          if (v === null || v === undefined) return false;
          if (Array.isArray(v) && v.length === 0) return false;
        }
        return true;
      });

      if (matched.length > 0) return { id, pass: true };
      return {
        id,
        pass: false,
        detail:
          `no matching ${a.type}. Emitted commands: ${
            emitted.map((c) => String(c['type'])).join(', ') || '(none)'
          }. ` +
          `Candidates of this type: ${
            emitted
              .filter((c) => c['type'] === a.type)
              .map((c) => JSON.stringify(c).slice(0, 240))
              .join(' | ') || '(none)'
          }`,
      };
    }
  }
}

/** Convenience: did all assertions pass? */
export function allPassed(results: AssertionResult[]): boolean {
  return results.every((r) => r.pass);
}
