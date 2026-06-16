import { prepare, layout } from '@chenglou/pretext';
import { useMemo } from 'react';

const DEFAULT_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';

interface FitTextOptions {
  minSize?: number;
  maxSize?: number;
  font?: string;
  lineHeightRatio?: number;
}

/**
 * The result snaps to a multiple of 4 (see `Math.floor(lo / 4) * 4`), so
 * the binary search only needs enough iterations to resolve the threshold
 * to better than 4px. Over the default [10, 144] range, 10 iterations
 * resolve to ~0.13px — visually identical to the previous 15 iterations.
 */
const FIT_ITERATIONS = 10;

/**
 * Reference size at which the text is measured exactly once per call. Glyph
 * advances scale linearly with font px, so a single `prepare` at this size
 * lets every binary-search probe reuse the same measured run — only the
 * (cheap, measureText-free) `layout` wrap pass repeats. Picked large enough
 * that sub-pixel rounding in the measured advances is negligible.
 */
const REF_SIZE = 100;

/**
 * Cache of computed fit sizes keyed by the exact inputs. A canvas zoomed
 * out to fit shows every node as a minimal-LOD placeholder at once, and
 * the same (text, width, height) recurs across StrictMode's double render,
 * virtualized remounts, and zoom round-trips. Memoising globally collapses
 * all of those into a single measurement. Bounded to avoid unbounded growth
 * across long sessions with many distinct labels.
 */
const fitCache = new Map<string, number>();
const FIT_CACHE_MAX = 4096;

/**
 * Binary-search the largest font size whose laid-out text fits inside
 * `width × height`, using pretext (pure arithmetic — no DOM reflow).
 *
 * The text is measured a single time via `prepare` at `REF_SIZE`; each probe
 * then reuses that prepared run and only re-runs `layout` (which does not
 * touch `measureText`). Because glyph advances scale linearly with font size,
 * fitting at size `s` is equivalent to wrapping the `REF_SIZE` run at width
 * `width * REF_SIZE / s` with line height `s * lhRatio` — pretext's own wrap
 * logic (CJK / soft-break aware) is preserved, just fed a scaled width.
 */
export function fitFontSize(
  text: string,
  width: number,
  height: number,
  opts?: FitTextOptions,
): number {
  const min = opts?.minSize ?? 10;
  const max = opts?.maxSize ?? 144;
  const font = opts?.font ?? DEFAULT_FONT;
  const lhRatio = opts?.lineHeightRatio ?? 1.4;

  if (width <= 0 || height <= 0 || !text.trim()) return min;

  const key = `${min}|${max}|${lhRatio}|${font}|${width}|${height}|${text}`;
  const cached = fitCache.get(key);
  if (cached !== undefined) return cached;

  // Measure once; every probe below scales this single run arithmetically.
  const prepared = prepare(text, `${REF_SIZE}px ${font}`);

  let lo = min;
  let hi = max;
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const { height: h } = layout(
      prepared,
      (width * REF_SIZE) / mid,
      mid * lhRatio,
    );
    if (h <= height) lo = mid;
    else hi = mid;
  }
  const snapped = Math.floor(lo / 4) * 4;
  const result = Math.max(min, snapped);

  if (fitCache.size >= FIT_CACHE_MAX) fitCache.clear();
  fitCache.set(key, result);
  return result;
}

/**
 * React hook wrapping `fitFontSize` in a memo.
 */
export function useFitText(
  text: string,
  width: number,
  height: number,
  opts?: FitTextOptions,
): number {
  return useMemo(
    () => fitFontSize(text, width, height, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      text,
      width,
      height,
      opts?.minSize,
      opts?.maxSize,
      opts?.font,
      opts?.lineHeightRatio,
    ],
  );
}
