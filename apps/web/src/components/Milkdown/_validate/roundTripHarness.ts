/**
 * Round-trip harness for Phase 1a Gate G1.
 *
 * Drives the validation editor through N iterations of
 * `setMarkdown -> getMarkdown` and reports whether the output stabilizes.
 *
 * Pass criterion: the markdown emitted on iteration N (for N >= 2)
 * must be identical to iteration N - 1. The first iteration is allowed
 * to normalize the input (table column widths, list-marker alignment,
 * trailing whitespace, etc.).
 */

import { createValidateEditor } from './createValidateEditor';

export interface RoundTripResult {
  fixtureName: string;
  /** History of markdown snapshots: [original, iter1, iter2, ...]. */
  iterations: string[];
  status: 'pass' | 'fail';
  /** First iteration index (1-based, into `iterations`) that diverged. */
  failedAtIteration?: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

function normalizeNewlines(md: string): string {
  return md.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * Run a single fixture through `iterations` round-trips.
 *
 * Each iteration creates a fresh Crepe instance in a hidden, off-screen
 * container, reads back the markdown, then tears it down. This isolates
 * each pass from accumulated editor state.
 */
export async function runRoundTrip(
  fixtureName: string,
  markdown: string,
  iterations = 3,
): Promise<RoundTripResult> {
  const t0 = performance.now();
  const history: string[] = [normalizeNewlines(markdown)];

  for (let i = 0; i < iterations; i++) {
    const container = document.createElement('div');
    // Hide the editor without removing it from the layout — Crepe's
    // floating UI (block handle, toolbar) refuses to attach if the
    // root is `display: none` because measurements break.
    container.style.cssText =
      'position:fixed;top:-99999px;left:-99999px;width:800px;height:600px;opacity:0;pointer-events:none;';
    document.body.appendChild(container);

    try {
      const editor = await createValidateEditor(
        container,
        history[history.length - 1],
      );
      // Yield once so Crepe's deferred decoration plugins
      // (block-edit handles, latex render) finish before we read back.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      const out = normalizeNewlines(editor.getMarkdown());
      history.push(out);
      await editor.destroy();
    } finally {
      container.remove();
    }
  }

  // Stability check: from the second pass onward, output must not change.
  for (let i = 2; i < history.length; i++) {
    if (history[i] !== history[i - 1]) {
      return {
        fixtureName,
        iterations: history,
        status: 'fail',
        failedAtIteration: i,
        durationMs: performance.now() - t0,
      };
    }
  }

  return {
    fixtureName,
    iterations: history,
    status: 'pass',
    durationMs: performance.now() - t0,
  };
}

/**
 * Convenience: run a batch of fixtures sequentially.
 *
 * Sequential (not parallel) so we don't have multiple ProseMirror
 * editors competing for focus / measurement in the off-screen layer.
 */
export async function runRoundTripBatch(
  fixtures: ReadonlyArray<{ name: string; markdown: string }>,
  iterations = 3,
): Promise<RoundTripResult[]> {
  const results: RoundTripResult[] = [];
  for (const fixture of fixtures) {
    results.push(
      await runRoundTrip(fixture.name, fixture.markdown, iterations),
    );
  }
  return results;
}
