import { useMemo } from 'react';

import { fitFontSize, type FontOpts } from '@/utils/node/textMeasure';

const DEFAULT_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';

/** Shared across all calls — zoom-out renders hundreds of placeholders at once. */
const FIT_CACHE = new Map<string, number>();

interface FitTextOptions {
  minSize?: number;
  maxSize?: number;
  font?: string;
  lineHeightRatio?: number;
}

/**
 * Largest font size whose label fits inside `width × height`. Thin
 * preset on top of {@link fitFontSize}: coarse 4 px snap, global cache,
 * `floorSize: 4` so a single long word descends below `minSize` rather
 * than letting pretext's `overflow-wrap: break-word` split it.
 */
export function fitFontSizeForLabel(
  text: string,
  width: number,
  height: number,
  opts?: FitTextOptions,
): number {
  const font: FontOpts = {
    fontFamily: opts?.font ?? DEFAULT_FONT,
    fontWeight: 'normal',
    fontStyle: 'normal',
    lineHeight: opts?.lineHeightRatio ?? 1.4,
  };
  return fitFontSize(text, width, height, font, {
    minSize: opts?.minSize ?? 10,
    maxSize: opts?.maxSize ?? 144,
    floorSize: 4,
    snapStep: 4,
    iterations: 10,
    cache: FIT_CACHE,
  });
}

/** React hook wrapping {@link fitFontSizeForLabel} in a `useMemo`. */
export function useFitText(
  text: string,
  width: number,
  height: number,
  opts?: FitTextOptions,
): number {
  return useMemo(
    () => fitFontSizeForLabel(text, width, height, opts),
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
