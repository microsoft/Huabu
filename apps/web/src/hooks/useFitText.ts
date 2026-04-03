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
 * Binary-search the largest font size whose laid-out text fits inside
 * `width × height`, using pretext (pure arithmetic — no DOM reflow).
 */
export function fitFontSize(
  text: string,
  width: number,
  height: number,
  opts?: FitTextOptions,
): number {
  const min = opts?.minSize ?? 10;
  const max = opts?.maxSize ?? 72;
  const font = opts?.font ?? DEFAULT_FONT;
  const lhRatio = opts?.lineHeightRatio ?? 1.4;

  if (width <= 0 || height <= 0 || !text.trim()) return min;

  let lo = min;
  let hi = max;
  for (let i = 0; i < 15; i++) {
    const mid = (lo + hi) / 2;
    const prepared = prepare(text, `${mid}px ${font}`);
    const lineHeight = mid * lhRatio;
    const { height: h } = layout(prepared, width, lineHeight);
    if (h <= height) lo = mid;
    else hi = mid;
  }
  const snapped = Math.floor(lo / 4) * 4;
  return Math.max(min, snapped);
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
