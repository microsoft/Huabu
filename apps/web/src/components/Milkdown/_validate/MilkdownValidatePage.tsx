/**
 * Phase 1a validation page (dev-only).
 *
 * Two purposes:
 *  1. Automated Gate G1 — round-trip stability on 4 fixtures.
 *  2. Manual gates G2-G6 — live editor for KaTeX rendering, drag handle,
 *     IME smoke test, and ad-hoc performance probing.
 *
 * Mounted by `main.tsx` when `?milkdown-validate=1` is present in the URL.
 * The whole `_validate/` directory is dev-only and deleted in Phase 1b.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Common/Button';

import { createValidateEditor } from './createValidateEditor';
import aiHalfBakedMd from './fixtures/ai-half-baked.md?raw';
import complexMd from './fixtures/complex.md?raw';
import mathMd from './fixtures/math.md?raw';
import simpleMd from './fixtures/simple.md?raw';
import { runRoundTripBatch, type RoundTripResult } from './roundTripHarness';

const FIXTURES = [
  { name: 'simple.md', markdown: simpleMd },
  { name: 'math.md', markdown: mathMd },
  { name: 'complex.md', markdown: complexMd },
  { name: 'ai-half-baked.md', markdown: aiHalfBakedMd },
] as const;

const PERF_FIXTURE = simpleMd.repeat(20); // ~5000 chars order of magnitude
const PERF_RUNS = 5;
const SET_MARKDOWN_BUDGET_MS = 50;

interface PerfMeasurement {
  charCount: number;
  /** Cold construction cost (informational — not part of G5). */
  createMs: number;
  /** Single getMarkdown call after warm-up. */
  getMarkdownMs: number;
  /** Per-iteration setMarkdown latencies (the actual G5 metric). */
  setMarkdownMs: number[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(((sorted.length - 1) * p) / 100),
  );
  return sorted[idx] ?? 0;
}

function StatusPill({
  status,
}: {
  status: RoundTripResult['status'] | 'running';
}) {
  const map: Record<typeof status, { bg: string; fg: string; label: string }> =
    {
      running: { bg: 'bg-info-bg', fg: 'text-info', label: 'running…' },
      pass: { bg: 'bg-success-bg', fg: 'text-success', label: 'pass' },
      fail: { bg: 'bg-danger-bg', fg: 'text-danger', label: 'fail' },
    };
  const { bg, fg, label } = map[status];
  return (
    <span
      className={`${bg} ${fg} rounded-full px-2 py-0.5 font-mono text-xs font-semibold uppercase`}
    >
      {label}
    </span>
  );
}

function ResultCard({ result }: { result: RoundTripResult }) {
  const [showDiff, setShowDiff] = useState(false);
  const diverged = result.failedAtIteration ?? -1;

  return (
    <div className="border-edge-default bg-surface rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-fg-default font-mono text-sm font-medium">
            {result.fixtureName}
          </span>
          <StatusPill status={result.status} />
        </div>
        <span className="text-fg-subtle text-xs">
          {result.durationMs.toFixed(0)}ms · {result.iterations.length - 1}{' '}
          passes
        </span>
      </div>

      {result.status === 'fail' && (
        <div className="text-danger mb-2 text-xs">
          Diverged at iteration {diverged} (length{' '}
          {result.iterations[diverged]?.length ?? 0} vs{' '}
          {result.iterations[diverged - 1]?.length ?? 0})
        </div>
      )}

      <Button
        variant="ghost"
        tone="info"
        size="sm"
        onClick={() => setShowDiff((s) => !s)}
      >
        {showDiff ? 'Hide' : 'Show'} iteration snapshots
      </Button>

      {showDiff && (
        <div className="mt-2 grid gap-2">
          {result.iterations.map((iter, idx) => (
            <details key={idx}>
              <summary className="text-fg-muted cursor-pointer text-xs">
                Iteration {idx} ({iter.length} chars)
              </summary>
              <pre className="bg-bg-default border-edge-default mt-1 max-h-64 overflow-auto rounded border p-2 font-mono text-[11px] leading-tight whitespace-pre-wrap">
                {iter}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function PerfReadout({ measurement }: { measurement: PerfMeasurement | null }) {
  if (!measurement) {
    return (
      <div className="text-fg-subtle text-xs">
        Click <em>Run perf probe</em> to measure setMarkdown latency.
      </div>
    );
  }
  const median = percentile(measurement.setMarkdownMs, 50);
  const p95 = percentile(measurement.setMarkdownMs, 95);
  const ok = median < SET_MARKDOWN_BUDGET_MS;
  return (
    <div className="text-fg-default space-y-1 text-xs">
      <div>
        <span className="font-medium">
          {measurement.charCount.toLocaleString()} chars · {PERF_RUNS}{' '}
          setMarkdown calls
        </span>
      </div>
      <div>
        Gate G5 — setMarkdown: median <strong>{median.toFixed(1)}ms</strong>,
        p95 <strong>{p95.toFixed(1)}ms</strong>{' '}
        <span className={ok ? 'text-success' : 'text-danger'}>
          ({ok ? 'pass' : 'fail'} — target median &lt; {SET_MARKDOWN_BUDGET_MS}
          ms)
        </span>
      </div>
      <div className="text-fg-muted">
        Individual runs:{' '}
        {measurement.setMarkdownMs.map((ms) => ms.toFixed(1)).join(', ')}ms
      </div>
      <div className="text-fg-subtle">
        Informational — initial editor create: {measurement.createMs.toFixed(1)}
        ms; getMarkdown: {measurement.getMarkdownMs.toFixed(1)}ms (only paid
        once per node mount; not part of G5)
      </div>
    </div>
  );
}

export default function MilkdownValidatePage() {
  const [results, setResults] = useState<RoundTripResult[]>([]);
  const [running, setRunning] = useState(false);
  const [perf, setPerf] = useState<PerfMeasurement | null>(null);

  const liveEditorRef = useRef<HTMLDivElement>(null);
  const liveEditorHandleRef = useRef<{ destroy(): Promise<void> } | null>(null);

  // Mount a single editable instance for manual KaTeX / drag / IME testing.
  useEffect(() => {
    let cancelled = false;
    const mount = async () => {
      const root = liveEditorRef.current;
      if (!root) return;
      const handle = await createValidateEditor(
        root,
        '# Live editor\n\nType freely. Try `$E=mc^2$`, IME input (中文), and hover the left margin to see the drag handle.\n',
      );
      if (cancelled) {
        await handle.destroy();
        return;
      }
      liveEditorHandleRef.current = handle;
    };
    void mount();
    return () => {
      cancelled = true;
      const handle = liveEditorHandleRef.current;
      liveEditorHandleRef.current = null;
      if (handle) void handle.destroy();
    };
  }, []);

  const runRoundTrip = useCallback(async () => {
    setRunning(true);
    setResults([]);
    try {
      const out = await runRoundTripBatch([...FIXTURES]);
      setResults(out);
    } finally {
      setRunning(false);
    }
  }, []);

  const runPerf = useCallback(async () => {
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;top:-99999px;left:-99999px;width:800px;height:600px;opacity:0;pointer-events:none;';
    document.body.appendChild(container);
    try {
      // 1) Cold create — informational only. AI streaming runs against an
      //    already-mounted editor, so this isn't the gate.
      const t0 = performance.now();
      const handle = await createValidateEditor(container, PERF_FIXTURE);
      const createMs = performance.now() - t0;

      // 2) getMarkdown after warm-up.
      handle.getMarkdown(); // warm
      const tGet = performance.now();
      handle.getMarkdown();
      const getMarkdownMs = performance.now() - tGet;

      // 3) setMarkdown — the actual G5 metric. We alternate between two
      //    payload variants of the same length so the doc actually changes
      //    each call (otherwise ProseMirror's transaction can short-circuit).
      const payloadA = PERF_FIXTURE;
      const payloadB = PERF_FIXTURE + '\n<!-- variant -->\n';
      const setMarkdownMs: number[] = [];
      for (let i = 0; i < PERF_RUNS; i++) {
        const payload = i % 2 === 0 ? payloadA : payloadB;
        // Yield a frame so any pending decorations from the previous run
        // settle; this matches how AI streaming would feed chunks.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const tSet = performance.now();
        handle.setMarkdown(payload);
        setMarkdownMs.push(performance.now() - tSet);
      }

      await handle.destroy();
      setPerf({
        charCount: PERF_FIXTURE.length,
        createMs,
        getMarkdownMs,
        setMarkdownMs,
      });
    } finally {
      container.remove();
    }
  }, []);

  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;

  return (
    <div className="bg-bg-default text-fg-default min-h-screen p-6">
      <header className="mx-auto mb-6 max-w-5xl">
        <h1 className="text-2xl font-semibold">
          Milkdown — Phase 1a validation
        </h1>
        <p className="text-fg-muted mt-1 text-sm">
          Dev-only harness for the migration spike. Verifies round-trip
          stability (G1) automatically, and renders a live editor for manual
          checks (G2 KaTeX, G3 drag handle, G6 IME).
        </p>
      </header>

      <section className="mx-auto mb-6 max-w-5xl">
        <div className="border-edge-default bg-surface flex items-center justify-between rounded-lg border p-4">
          <div>
            <h2 className="font-medium">Gate G1 — round-trip stability</h2>
            <p className="text-fg-subtle text-xs">
              Each fixture: 3 passes. Pass criterion: output stable from
              iteration 2 onward.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {results.length > 0 && (
              <span className="text-fg-muted text-sm">
                {passCount} pass / {failCount} fail
              </span>
            )}
            <Button onClick={runRoundTrip} disabled={running}>
              {running ? 'Running…' : 'Run round-trip'}
            </Button>
          </div>
        </div>

        {results.length > 0 && (
          <div className="mt-4 grid gap-3">
            {results.map((r) => (
              <ResultCard key={r.fixtureName} result={r} />
            ))}
          </div>
        )}
      </section>

      <section className="mx-auto mb-6 max-w-5xl">
        <div className="border-edge-default bg-surface flex items-center justify-between rounded-lg border p-4">
          <div>
            <h2 className="font-medium">Gate G5 — setMarkdown latency probe</h2>
            <p className="text-fg-subtle text-xs">
              Mounts an editor once with a ~
              {Math.round(PERF_FIXTURE.length / 1000)}k-char fixture, then runs{' '}
              {PERF_RUNS} full-document setMarkdown calls on the live instance.
              This models AI streaming: the editor already exists, content is
              being replaced.
            </p>
          </div>
          <Button onClick={runPerf}>Run perf probe</Button>
        </div>
        <div className="mt-3">
          <PerfReadout measurement={perf} />
        </div>
      </section>

      <section className="mx-auto max-w-5xl">
        <div className="border-edge-default bg-surface rounded-lg border p-4">
          <h2 className="mb-1 font-medium">
            Live editor — manual gates G2 (KaTeX), G3 (drag handle), G6 (IME)
          </h2>
          <p className="text-fg-subtle mb-3 text-xs">
            Edit freely. Inline math: <code>$E=mc^2$</code>. Block math: type{' '}
            <code>$$</code> then enter, or use the slash menu. Hover the left
            margin to see the drag handle. Switch to a CJK IME and type to
            verify composition events.
          </p>
          <div
            ref={liveEditorRef}
            className="bg-bg-default border-edge-default min-h-100 rounded border"
          />
        </div>
      </section>
    </div>
  );
}
