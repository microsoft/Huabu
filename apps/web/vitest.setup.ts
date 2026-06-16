/**
 * Vitest setup file. Runs before any test file is imported.
 *
 * The test environment is `happy-dom` (see `vitest.config.ts`), which is
 * required because CommonJS modules like `cytoscape-layout-utilities`
 * — pulled in transitively when the shared canvas-engine command
 * registry loads — reference `window` at module-load time. happy-dom
 * supplies a real `window` shim, so no manual polyfill is needed here.
 *
 * Add globally-needed test setup (matchers, mocks) below.
 */

// ---------------------------------------------------------------------------
// Canvas 2D text-metrics stub.
//
// `@chenglou/pretext` (used by `utils/node/textMeasure`) measures text via a
// canvas 2D context. happy-dom does not implement `getContext('2d')`, so it
// returns null and pretext throws when setting `.font`. We provide a minimal,
// deterministic context: `measureText` returns a width proportional to the
// string length and the current font's px size. It is intentionally crude —
// tests that exercise font fitting assert against the SAME measurement path,
// so only determinism and monotonicity matter, not pixel accuracy.
// ---------------------------------------------------------------------------
const measureCtx = {
  font: '10px sans-serif',
  measureText(text: string): TextMetrics {
    const match = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const size = match ? parseFloat(match[1]) : 10;
    const width = text.length * size * 0.6;
    return {
      width,
      actualBoundingBoxAscent: size * 0.8,
      actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      fontBoundingBoxAscent: size * 0.8,
      fontBoundingBoxDescent: size * 0.2,
    } as TextMetrics;
  },
};

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext(): unknown {
    return measureCtx;
  } as HTMLCanvasElement['getContext'];
}

export {};
