/**
 * Hook that encapsulates text auto-sizing logic shared by TextNode and QuestionNode.
 *
 * Two modes:
 *   - Auto mode (no fixed size): node shrink-wraps to content at baseFontSize
 *   - Fixed mode (user resized): font size is computed to fill the node
 *
 * Returns dimensions, effective font size, and resize callbacks.
 */

import { useStore } from '@xyflow/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  computeFontSizeForHeight,
  measureTextContent,
  type FontOpts,
} from '@/utils/node/textMeasure';

/** Maximum characters per line before wrapping (auto mode). */
const MAX_CHARS_PER_LINE = 18;

/**
 * Extra width (px) added to the content area so that lines which barely fit
 * in pretext don't wrap in the browser (CJK rounding differences).
 */
const WRAP_TOLERANCE = 4;

export interface UseTextAutoSizeOpts {
  nodeId: string;
  text: string;
  baseFontSize?: number;
  padding: number;
  borderInset?: number;
  fontOpts: FontOpts;
  /** Placeholder text used to measure minimum width when content is empty. */
  placeholder?: string;
  /** Node width from NodeProps (only available in fixed mode). */
  width?: number;
  /** Node height from NodeProps (only available in fixed mode). */
  height?: number;
}

export interface UseTextAutoSizeResult {
  /** Whether the node has been manually resized to a fixed size. */
  hasFixedSize: boolean;
  /** The font size to apply to the textarea. */
  effectiveFontSize: number;
  /** Auto-computed width (undefined in fixed mode). */
  autoWidth: number | undefined;
  /** Auto-computed height (undefined in fixed mode). */
  autoHeight: number | undefined;
  /** Callback for NodeWrapper onResizeStart. */
  handleResizeStart: () => void;
  /** Callback for NodeWrapper onResize. */
  handleResize: (width: number, height: number) => void;
  /** Callback for NodeWrapper onResizeEnd. */
  handleResizeEnd: () => void;
}

export function useTextAutoSize({
  nodeId,
  text,
  baseFontSize = 16,
  padding,
  borderInset = 0,
  fontOpts,
  placeholder = 'Type...',
  width,
  height,
}: UseTextAutoSizeOpts): UseTextAutoSizeResult {
  const hasFixedSize = useStore(
    (s) => typeof s.nodeLookup.get(nodeId)?.style?.height === 'number',
  );

  const [liveFontSize, setLiveFontSize] = useState<number | null>(null);
  const isResizingRef = useRef(false);

  const inset = padding + borderInset;

  const computedFontSize = useMemo(() => {
    if (hasFixedSize && width != null && height != null) {
      // Empty content -> render the placeholder at the base size (a small
      // hint, not a fill-the-box title). Scaling the placeholder up would
      // either wrap it onto multiple lines or clip it.
      if (!text.trim()) return baseFontSize;
      const cw = width - inset * 2;
      const ch = height - inset * 2;
      return computeFontSizeForHeight(text, cw, ch, fontOpts);
    }
    return baseFontSize;
  }, [hasFixedSize, width, height, text, baseFontSize, fontOpts, inset]);

  // Clear liveFontSize once computedFontSize updates after resize ends,
  // so the stable memo-driven value takes over.
  const prevComputedRef = useRef(computedFontSize);
  if (prevComputedRef.current !== computedFontSize) {
    prevComputedRef.current = computedFontSize;
    if (!isResizingRef.current && liveFontSize !== null) {
      setLiveFontSize(null);
    }
  }

  const maxAutoWidth = baseFontSize * MAX_CHARS_PER_LINE * 0.62;

  const autoSize = useMemo(() => {
    if (hasFixedSize) return null;
    const measuredText = text || placeholder;
    return measureTextContent(measuredText, {
      ...fontOpts,
      fontSize: baseFontSize,
      maxWidth: maxAutoWidth,
    });
  }, [hasFixedSize, text, baseFontSize, fontOpts, maxAutoWidth, placeholder]);

  // After resize ends, prefer computedFontSize (driven by NodeProps width/height)
  // over liveFontSize. During active drag, use liveFontSize for instant feedback.
  const effectiveFontSize = liveFontSize ?? computedFontSize;

  const autoWidth = hasFixedSize
    ? undefined
    : Math.max((autoSize?.width ?? 0) + WRAP_TOLERANCE + inset * 2, 30);
  const autoHeight = hasFixedSize
    ? undefined
    : Math.max(
        (autoSize?.height ?? 0) + inset * 2,
        baseFontSize * 1.5 + inset * 2,
      );

  const handleResizeStart = useCallback(() => {
    isResizingRef.current = true;
  }, []);

  const handleResize = useCallback(
    (w: number, h: number) => {
      if (!text.trim()) {
        setLiveFontSize(baseFontSize);
        return;
      }
      const cw = w - inset * 2;
      const ch = h - inset * 2;
      const fs = computeFontSizeForHeight(text, cw, ch, fontOpts);
      setLiveFontSize(fs);
    },
    [text, baseFontSize, fontOpts, inset],
  );

  const handleResizeEnd = useCallback(() => {
    isResizingRef.current = false;
    // Keep liveFontSize until the next render with updated NodeProps dimensions,
    // which will recompute computedFontSize. Clearing it immediately would cause
    // a flash to baseFontSize before React Flow propagates measured dimensions.
  }, []);

  return {
    hasFixedSize,
    effectiveFontSize,
    autoWidth,
    autoHeight,
    handleResizeStart,
    handleResize,
    handleResizeEnd,
  };
}
