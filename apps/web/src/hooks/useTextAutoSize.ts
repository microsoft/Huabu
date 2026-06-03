/**
 * Hook that encapsulates text auto-sizing logic shared by TextNode and QuestionNode.
 *
 * Model:
 *   - Width: Fixed if the node has `style.width` (set by a resize gesture),
 *     else auto-fits the content at `baseFontSize`.
 *   - Font size: locked via `style.fontSize`. Captured at resize-end by
 *     binary-searching the box dimensions; absent value defaults to
 *     `baseFontSize`. Typing / deleting / undo / external sync never
 *     change it — they only adjust the height.
 *   - Height: ALWAYS content-driven. Measured from the locked font size
 *     and width. The node's `style.height` is intentionally never persisted
 *     by these node types (NodeWrapper's `resizeEndClearHeight` prop
 *     ensures the resize commit drops it).
 *
 * Returns dimensions, effective font size, and resize callbacks.
 */

import { useStore } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { NodeStyle } from '@sediment/shared';

import useCanvasStore from '@/store/canvasStore';
import {
  computeFontSizeForHeight,
  measureTextContent,
  measureTextHeight,
  type FontOpts,
} from '@/utils/node/textMeasure';

/** Maximum characters per line before wrapping in auto-width mode. */
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
  /** Node width from NodeProps (only available once measured). */
  width?: number;
}

export interface UseTextAutoSizeResult {
  /** Whether the node has a user-set width (from a resize gesture). */
  hasFixedWidth: boolean;
  /** The font size to apply to the textarea. */
  effectiveFontSize: number;
  /** Width to apply to the inner content container. */
  effectiveWidth: number;
  /** Height to apply to the inner content container. */
  effectiveHeight: number;
  /** Callback for NodeWrapper onResizeStart. */
  handleResizeStart: () => void;
  /** Callback for NodeWrapper onResize. */
  handleResize: (width: number, height: number) => void;
  /** Callback for NodeWrapper onResizeEnd. */
  handleResizeEnd: (width: number, height: number) => void;
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
}: UseTextAutoSizeOpts): UseTextAutoSizeResult {
  // Subscribe to the persisted style so we react to undo/redo and external
  // edits. Selecting the whole style object is fine — React Flow's store
  // dedupes by reference equality and `style` is treated as immutable.
  const style = useStore(
    (s) => s.nodeLookup.get(nodeId)?.data?.style as NodeStyle | undefined,
  );
  const hasFixedWidth = useStore(
    (s) => typeof s.nodeLookup.get(nodeId)?.style?.width === 'number',
  );
  const persistedHeight = useStore(
    (s) => s.nodeLookup.get(nodeId)?.style?.height as number | undefined,
  );

  const lockedFontSize = style?.fontSize;

  const writeLockedFontSize = useCallback(
    (nextFontSize: number) => {
      const state = useCanvasStore.getState();
      // Read from `data.style` (NodeStyle: fontFamily, fontWeight,
      // textDecoration, accent, colors, …) — NOT from the React Flow
      // node's top-level `style` (geometry width/height). `patchNodeSilent`
      // replaces `data.style` wholesale, so any field omitted here is lost.
      const currentStyle = state.nodes.find((node) => node.id === nodeId)?.data
        ?.style as NodeStyle | undefined;
      state.patchNodeSilent(nodeId, {
        style: {
          ...(currentStyle ?? {}),
          fontSize: nextFontSize,
        },
      });
    },
    [nodeId],
  );

  const inset = padding + borderInset;

  // --------------------------------------------------------------------
  // @deprecated MIGRATION_FONTSIZE_FROM_HEIGHT
  //
  // Nodes created before `style.fontSize` existed persist `style.height`
  // as the implicit carrier of "the size the user resized to". Back-derive
  // a fontSize once, write it via `patchNodeSilent` (no undo entry), and
  // let `NodeWrapper.resizeEndClearHeight` drop `style.height` on the next
  // resize. The block reads `text` only at mount-time so a long edit
  // session after migration doesn't keep recomputing.
  //
  // Safe to remove after live data has migrated (next major schema bump).
  // Grep for `MIGRATION_FONTSIZE_FROM_HEIGHT` to locate this block.
  // --------------------------------------------------------------------
  const migrationDoneRef = useRef(false);
  useEffect(() => {
    if (migrationDoneRef.current) return;
    if (lockedFontSize !== undefined) {
      migrationDoneRef.current = true;
      return;
    }
    if (persistedHeight === undefined || width === undefined) return;
    if (width - inset * 2 <= 0 || persistedHeight - inset * 2 <= 0) return;
    migrationDoneRef.current = true;
    const derived = text.trim()
      ? computeFontSizeForHeight(
          text,
          width - inset * 2,
          persistedHeight - inset * 2,
          fontOpts,
        )
      : baseFontSize;
    writeLockedFontSize(derived);
    // Intentionally minimal deps — we want a one-shot migration using the
    // text/dims at mount time, not a reactive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedFontSize, persistedHeight, width, writeLockedFontSize]);

  // --------------------------------------------------------------------
  // Live drag state — overrides locked size while user is dragging the
  // resize handle so feedback is instantaneous.
  // --------------------------------------------------------------------
  const [liveFontSize, setLiveFontSize] = useState<number | null>(null);
  const [liveSize, setLiveSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const isResizingRef = useRef(false);

  // --------------------------------------------------------------------
  // Auto-width fallback (used when no fixed width is set).
  // --------------------------------------------------------------------
  const fontSize = liveFontSize ?? lockedFontSize ?? baseFontSize;
  const maxAutoWidth = baseFontSize * MAX_CHARS_PER_LINE * 0.62;

  const autoContent = useMemo(() => {
    const measuredText = text || placeholder;
    return measureTextContent(measuredText, {
      ...fontOpts,
      fontSize: baseFontSize,
      maxWidth: maxAutoWidth,
    });
  }, [text, baseFontSize, fontOpts, maxAutoWidth, placeholder]);

  const autoWidth = Math.max(
    autoContent.width + WRAP_TOLERANCE + inset * 2,
    30,
  );

  // --------------------------------------------------------------------
  // Effective dimensions.
  //
  // - Width:  live drag value > fixed `style.width` > auto-measured
  // - Height: live drag value > content-driven height at the current font
  // - Font:   live drag value > locked `style.fontSize` > placeholder cap
  // --------------------------------------------------------------------
  const effectiveWidth =
    liveSize?.width ?? (hasFixedWidth ? (width ?? autoWidth) : autoWidth);
  const contentWidth = Math.max(effectiveWidth - inset * 2, 1);

  // Placeholder renders at the same font size as user-typed text so there
  // is no visual jump between empty and filled states. The placeholder
  // hint reflects exactly what typed text will look like.
  const renderFontSize = fontSize;
  const measureText = text || placeholder;

  const measuredHeight = useMemo(
    () =>
      measureTextHeight(measureText, contentWidth, renderFontSize, fontOpts),
    [measureText, contentWidth, renderFontSize, fontOpts],
  );

  const effectiveHeight =
    liveSize?.height ??
    Math.max(
      measuredHeight + inset * 2,
      renderFontSize * fontOpts.lineHeight + inset * 2,
    );

  // --------------------------------------------------------------------
  // Resize callbacks.
  //
  // During drag: compute a live fontSize from (w, h, text) and a live
  // size so the container visually follows the handle exactly.
  // On end:     write the final fontSize to `style.fontSize` (silent —
  // no undo entry) and release the live state. NodeWrapper, configured
  // with `resizeEndClearHeight`, has already persisted the width-only
  // geometry change in its own undo entry.
  // --------------------------------------------------------------------
  const handleResizeStart = useCallback(() => {
    isResizingRef.current = true;
  }, []);

  const handleResize = useCallback(
    (w: number, h: number) => {
      setLiveSize({ width: w, height: h });
      // Use placeholder as the measurement target when empty, so dragging
      // on an empty node still scales the font naturally (same behaviour
      // and same final size as if the user had typed something).
      const target = text.trim() ? text : placeholder;
      const cw = w - inset * 2;
      const ch = h - inset * 2;
      const fs = computeFontSizeForHeight(target, cw, ch, fontOpts);
      setLiveFontSize(fs);
    },
    [text, placeholder, fontOpts, inset],
  );

  const handleResizeEnd = useCallback(
    (w: number, h: number) => {
      isResizingRef.current = false;
      // Mirror handleResize: placeholder drives sizing when empty so the
      // committed fontSize matches what the user saw during the drag.
      const target = text.trim() ? text : placeholder;
      const finalFontSize = computeFontSizeForHeight(
        target,
        w - inset * 2,
        h - inset * 2,
        fontOpts,
      );
      writeLockedFontSize(finalFontSize);
      // Release live state. The next render uses the persisted fontSize
      // and recomputes height to wrap text exactly — visually this snaps
      // the bottom edge to content height, which is the intended UX:
      // resize sets fontSize, height returns to being content-driven.
      setLiveFontSize(null);
      setLiveSize(null);
    },
    [text, placeholder, fontOpts, inset, writeLockedFontSize],
  );

  return {
    hasFixedWidth,
    effectiveFontSize: renderFontSize,
    effectiveWidth,
    effectiveHeight,
    handleResizeStart,
    handleResize,
    handleResizeEnd,
  };
}
