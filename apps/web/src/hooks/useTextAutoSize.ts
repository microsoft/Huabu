// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Hook that encapsulates text auto-sizing logic shared by TextNode and QuestionNode.
 *
 * Model:
 *   - Width: Fixed if the node has `style.width` (set by a resize gesture),
 *     else auto-fits the content at `baseFontSize`.
 *   - Fixed card policy: always uses `baseFontSize`, never migrates or writes
 *     font size, and reflows height from width even during a resize.
 *   - Proportional policy (Text/Question): corners multiply the starting font
 *     by the outer-width ratio and scale content insets by font/default.
 *     Side grips preserve typography and reflow content. Stored fonts are
 *     respected; legacy height never implicitly authors a font in this policy.
 *   - Resizable policy: locked via `style.fontSize`. Fit resize searches the box,
 *     scale resize follows the content-width ratio, and width resize leaves
 *     the persisted font untouched. An absent value defaults to
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

import { NODE_SHELL_INSET } from '@huabu/shared/canvas-engine';

import useCanvasStore from '@/store/canvasStore';
import {
  computeFontSizeForHeight,
  measureTextContent,
  measureTextHeight,
  type FontOpts,
} from '@/utils/node/textMeasure';

import type { NodeStyle } from '@huabu/shared';

/** Maximum characters per line before wrapping in auto-width mode. */
const MAX_CHARS_PER_LINE = 18;

/**
 * Extra width (px) added to the content area so that lines which barely fit
 * in pretext don't wrap in the browser (CJK rounding differences).
 */
const WRAP_TOLERANCE = 4;

export type TextResizeMode = 'fit' | 'width' | 'scale';

export interface UseTextAutoSizeOpts {
  nodeId: string;
  text: string;
  baseFontSize?: number;
  paddingX: number;
  paddingY: number;
  fontOpts: FontOpts;
  /** Placeholder text used to measure minimum width when content is empty. */
  placeholder?: string;
  /** Node width from NodeProps (only available once measured). */
  width?: number;
  /** Minimum natural width for non-text chrome; never overrides authored width. */
  minAutoWidth?: number;
  /** Proportional scales all content metrics; fixed ignores authored fonts. */
  fontSizing?: 'resizable' | 'fixed' | 'proportional';
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
  /** Proportional content insets, shared by measurement and rendering. */
  effectivePaddingX: number;
  effectivePaddingY: number;
  /** Callback for NodeWrapper onResizeStart. */
  handleResizeStart: (mode?: TextResizeMode) => void;
  /** Callback for NodeWrapper onResize. */
  handleResize: (width: number, height: number) => void;
  /** Callback for NodeWrapper onResizeEnd. */
  handleResizeEnd: (width: number, height: number) => void;
}

export function useTextAutoSize({
  nodeId,
  text,
  baseFontSize = 16,
  paddingX,
  paddingY,
  fontOpts,
  placeholder = 'Type...',
  width,
  minAutoWidth = 30,
  fontSizing = 'resizable',
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

  const fixedFont = fontSizing === 'fixed';
  const proportional = fontSizing === 'proportional';
  const lockedFontSize =
    fixedFont ||
    !Number.isFinite(style?.fontSize) ||
    (style?.fontSize ?? 0) <= 0
      ? undefined
      : style?.fontSize;
  const [liveFontSize, setLiveFontSize] = useState<number | null>(null);
  const fontSize = fixedFont
    ? baseFontSize
    : (liveFontSize ?? lockedFontSize ?? baseFontSize);
  const contentScale = proportional ? fontSize / baseFontSize : 1;

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

  // The insets are the body's own padding and NOTHING else. In particular
  // the node shell's 3px border must not be subtracted here: `TextNodeBody`
  // absorbs that border into its own padding (`resolveTextBodyBox`), so the
  // text always lays out at exactly `width - 2 * paddingX` whether or not an
  // accent makes the border visible. Measuring at a narrower width than the
  // text renders at counts a line as wrapped that the browser keeps on one
  // line, and the node then reserves a line of height that renders empty.
  const insetX = paddingX * contentScale;
  const insetY = paddingY * contentScale;
  const resizeRef = useRef<{
    mode: TextResizeMode;
    initialContentWidth: number;
    initialWidth: number;
    initialFontSize: number;
  } | null>(null);

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
    if (fixedFont || proportional) return;
    if (migrationDoneRef.current || resizeRef.current) return;
    if (lockedFontSize !== undefined) {
      migrationDoneRef.current = true;
      return;
    }
    if (persistedHeight === undefined || width === undefined) return;
    if (width - insetX * 2 <= 0 || persistedHeight - insetY * 2 <= 0) return;
    migrationDoneRef.current = true;
    const derived = text.trim()
      ? computeFontSizeForHeight(
          text,
          width - insetX * 2,
          persistedHeight - insetY * 2,
          fontOpts,
        )
      : baseFontSize;
    writeLockedFontSize(derived);
    // Intentionally minimal deps — we want a one-shot migration using the
    // text/dims at mount time, not a reactive recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    fixedFont,
    proportional,
    lockedFontSize,
    persistedHeight,
    width,
    writeLockedFontSize,
  ]);

  // --------------------------------------------------------------------
  // Live drag state — overrides locked size while user is dragging the
  // resize handle so feedback is instantaneous.
  // --------------------------------------------------------------------
  const [liveSize, setLiveSize] = useState<{
    width: number;
    height?: number;
  } | null>(null);

  // --------------------------------------------------------------------
  // Auto-width fallback (used when no fixed width is set).
  // --------------------------------------------------------------------
  const naturalFont = proportional ? fontSize : baseFontSize;
  const maxAutoWidth = naturalFont * MAX_CHARS_PER_LINE * 0.62;

  const autoContent = useMemo(() => {
    const measuredText = text || placeholder;
    return measureTextContent(measuredText, {
      ...fontOpts,
      fontSize: naturalFont,
      maxWidth: maxAutoWidth,
    });
  }, [text, naturalFont, fontOpts, maxAutoWidth, placeholder]);

  const autoWidth = Math.max(
    autoContent.width + WRAP_TOLERANCE * contentScale + insetX * 2,
    minAutoWidth * contentScale,
  );

  // --------------------------------------------------------------------
  // Effective dimensions.
  //
  // - Width:  live drag value > fixed `style.width` > auto-measured
  // - Height: content-driven for fixed/proportional policies and width drags;
  //   resizable fit/scale modes use the dragged height until release.
  // - Font:   live drag value > locked `style.fontSize` > placeholder cap
  // --------------------------------------------------------------------
  const effectiveWidth =
    liveSize?.width ?? (hasFixedWidth ? (width ?? autoWidth) : autoWidth);
  const contentWidth = Math.max(effectiveWidth - insetX * 2, 1);

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
      measuredHeight + insetY * 2,
      renderFontSize * fontOpts.lineHeight + insetY * 2,
    );

  // --------------------------------------------------------------------
  // Resize callbacks.
  //
  // During drag: fit uses the box, width reflows at the captured font,
  // and proportional scaling preserves the outer-width/font ratio.
  // On end:     fit/scale write the final fontSize to `style.fontSize` (silent —
  // no undo entry) and release the live state. NodeWrapper, configured
  // with `resizeEndClearHeight`, then commits width-only geometry in the
  // same resize gesture's undo entry.
  // --------------------------------------------------------------------
  const handleResizeStart = useCallback(
    (mode: TextResizeMode = 'fit') => {
      resizeRef.current = {
        mode,
        initialContentWidth: contentWidth,
        initialWidth: effectiveWidth,
        initialFontSize: renderFontSize,
      };
    },
    [contentWidth, effectiveWidth, renderFontSize],
  );

  const resolveResizeFontSize = useCallback(
    (w: number, h: number) => {
      if (fixedFont) return baseFontSize;
      const resize = resizeRef.current;
      if (resize?.mode === 'width') return resize.initialFontSize;
      if (proportional && resize) {
        return (resize.initialFontSize * Math.max(w, 1)) / resize.initialWidth;
      }
      if (resize?.mode === 'scale') {
        // Match computeFontSizeForHeight's 1–200px bounds, but do not snap:
        // rounding the ratio would introduce extra wrapping during scaling.
        const scaled =
          resize.initialFontSize *
          (Math.max(w - insetX * 2, 1) / resize.initialContentWidth);
        return Math.max(1, Math.min(200, scaled));
      }
      // Use placeholder as the measurement target when empty, so dragging
      // on an empty node still scales the font naturally (same behaviour
      // and same final size as if the user had typed something).
      const target = text.trim() ? text : placeholder;
      const cw = w - insetX * 2;
      const ch = h - insetY * 2;
      return computeFontSizeForHeight(target, cw, ch, fontOpts);
    },
    [
      fixedFont,
      proportional,
      baseFontSize,
      text,
      placeholder,
      fontOpts,
      insetX,
      insetY,
    ],
  );

  const handleResize = useCallback(
    (w: number, h: number) => {
      setLiveSize({
        width: w,
        height:
          fixedFont || proportional || resizeRef.current?.mode === 'width'
            ? undefined
            : Math.max(h - NODE_SHELL_INSET, 0),
      });
      setLiveFontSize(resolveResizeFontSize(w, h));
    },
    [fixedFont, proportional, resolveResizeFontSize],
  );

  const handleResizeEnd = useCallback(
    (w: number, h: number) => {
      // Width-only gestures never author typography, including when the
      // initial font is the implicit base size rather than a persisted value.
      if (!fixedFont && resizeRef.current?.mode !== 'width') {
        writeLockedFontSize(resolveResizeFontSize(w, h));
      }
      resizeRef.current = null;
      // Release live state. The next render uses the persisted fontSize
      // and recomputes height to wrap text exactly — visually this snaps
      // the bottom edge to content height, which is the intended UX:
      // resize sets fontSize, height returns to being content-driven.
      setLiveFontSize(null);
      setLiveSize(null);
    },
    [fixedFont, resolveResizeFontSize, writeLockedFontSize],
  );

  return {
    hasFixedWidth,
    effectiveFontSize: renderFontSize,
    effectiveWidth,
    effectiveHeight,
    effectivePaddingX: insetX,
    effectivePaddingY: insetY,
    handleResizeStart,
    handleResize,
    handleResizeEnd,
  };
}
