import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext';
import { type Node, type NodeProps, useStore } from '@xyflow/react';
import { clsx } from 'clsx';
import { Baseline, Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { memo, useCallback, useState, useRef, useMemo, useEffect } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { NODE_BG_COLORS, COLOR_PALETTE } from '@/config/colors';
import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from '../NodeWrapper';

import type { CanvasTextNodeData, NodeStyle } from '../types';
import type { NodeFontFamily } from '@sediment/shared';

/** Map logical font family names to CSS font stacks. */
const FONT_FAMILY_CSS: Record<NodeFontFamily, string> = {
  default: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  hand: '"Comic Sans MS", "Chalkboard SE", sans-serif',
};

const FONT_FAMILY_OPTIONS: { name: string; value: NodeFontFamily }[] = [
  { name: 'Default', value: 'default' },
  { name: 'Serif', value: 'serif' },
  { name: 'Mono', value: 'mono' },
  { name: 'Hand', value: 'hand' },
];

/** Maximum characters per line before wrapping. */
const MAX_CHARS_PER_LINE = 18;
/** Padding inside the node (px on each side). */
const NODE_PADDING = 4;
/** Border width NodeWrapper applies when an accent colour is set (`border-2`). */
const ACCENT_BORDER = 2;
/**
 * Extra width (px) added to the content area so that lines which barely fit
 * in pretext don't wrap in the browser.  pretext uses canvas text-metrics
 * while the browser uses its own font-shaping engine; for CJK text the
 * per-character difference can be 1-2 px, enough to push a line over the
 * edge and create an extra wrap (→ the last line gets clipped).
 */
const WRAP_TOLERANCE = 4;

export type TextNodeType = Node<CanvasTextNodeData, 'text'>;

/**
 * Build the CSS font shorthand string for pretext's prepare().
 */
function buildFontStr(
  fontSize: number,
  fontFamily: string,
  fontWeight: string,
  fontStyle: string,
): string {
  let s = '';
  if (fontStyle === 'italic') s += 'italic ';
  if (fontWeight === 'bold') s += 'bold ';
  return `${s}${fontSize}px ${fontFamily}`;
}

/**
 * Measure the natural content dimensions using pretext (no DOM reflow).
 * maxWidth controls the wrap boundary.
 */
function measureTextContent(
  text: string,
  opts: {
    fontSize: number;
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
    lineHeight: number;
    maxWidth: number;
  },
): { width: number; height: number } {
  const fontStr = buildFontStr(
    opts.fontSize,
    opts.fontFamily,
    opts.fontWeight,
    opts.fontStyle,
  );
  const prepared = prepareWithSegments(text || ' ', fontStr, {
    whiteSpace: 'pre-wrap',
  });
  const lineH = opts.fontSize * opts.lineHeight;
  const { height, lines } = layoutWithLines(prepared, opts.maxWidth, lineH);

  // Width = widest line (shrink-wrap, matching old DOM measurement behaviour)
  let maxW = 0;
  for (const line of lines) {
    if (line.width > maxW) maxW = line.width;
  }
  return { width: Math.ceil(maxW), height: Math.ceil(height) };
}

/**
 * Binary-search for the font size that makes text fill a target height
 * at a given content width.  Uses pretext — pure arithmetic, no DOM access.
 */
function computeFontSizeForHeight(
  text: string,
  contentWidth: number,
  contentHeight: number,
  opts: {
    fontFamily: string;
    fontWeight: string;
    fontStyle: string;
    lineHeight: number;
  },
): number {
  if (contentWidth <= 0 || contentHeight <= 0) return 16;
  if (!text.trim()) {
    return Math.max(
      1,
      Math.min(Math.round(contentHeight / opts.lineHeight), 200),
    );
  }
  let lo = 1;
  let hi = 200;
  for (let i = 0; i < 15; i++) {
    const mid = (lo + hi) / 2;
    const fontStr = buildFontStr(
      mid,
      opts.fontFamily,
      opts.fontWeight,
      opts.fontStyle,
    );
    const prepared = prepareWithSegments(text, fontStr, {
      whiteSpace: 'pre-wrap',
    });
    const lineH = mid * opts.lineHeight;
    const { height } = layoutWithLines(prepared, contentWidth, lineH);
    if (height <= contentHeight) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Use 0.5px precision instead of integer-only sizing.
  // Integer steps can cause big height jumps due to line-wrap discontinuities,
  // leaving large blank areas. Half-pixel steps fill the container much better.
  return Math.max(1, Math.floor(lo * 2) / 2);
}

export const TextNode = memo(
  ({ id, data, selected, width, height }: NodeProps<TextNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isResizingRef = useRef(false);

    // Controlled draft state — local during editing, synced from store on undo/external update.
    const content = data.content ?? '';
    const [draftContent, setDraftContent] = useState(content);

    // Sync draft from external store changes (undo/redo, server updates).
    useEffect(() => {
      if (!isEditing) {
        setDraftContent(data.content ?? '');
      }
    }, [data.content, isEditing]);

    // ------------------------------------------------------------------
    // Fixed vs auto mode: if the node's style.height is a number,
    // the user has resized it. Otherwise it's in auto mode.
    // Mirrors the NoteNode pattern (hasFixedHeight).
    // ------------------------------------------------------------------
    const hasFixedSize = useStore(
      (s) => typeof s.nodeLookup.get(id)?.style?.height === 'number',
    );

    // Live font size during resize (computed from current dimensions)
    const [liveFontSize, setLiveFontSize] = useState<number | null>(null);

    const updateStyle = useCallback(
      (newStyle: Partial<NodeStyle>) => {
        updateNodeData(id, {
          style: {
            ...data.style,
            ...newStyle,
          },
        });
      },
      [id, data.style, updateNodeData],
    );

    const style = data.style || {};
    const baseFontSize = 16;
    const fontFamily = FONT_FAMILY_CSS[style.fontFamily ?? 'default'];
    const isBold = style.fontWeight === 'bold';
    const isItalic = style.fontStyle === 'italic';
    const textColor = style.textColor;
    const textDecoration = style.textDecoration || '';

    const fontOpts = useMemo(
      () => ({
        fontFamily,
        fontWeight: isBold ? 'bold' : 'normal',
        fontStyle: isItalic ? 'italic' : 'normal',
        lineHeight: 1.5,
      }),
      [fontFamily, isBold, isItalic],
    );

    // When an accent is set NodeWrapper renders `border-2` which, under
    // border-box, eats into the node's width/height.  We must subtract
    // it from the available content area for measurement.
    const borderInset = style.accent ? ACCENT_BORDER : 0;

    // ------------------------------------------------------------------
    // Effective font size:
    //   Resizing live  → liveFontSize (during drag)
    //   Fixed mode     → computed to fill node height at node width
    //   Auto mode      → baseFontSize, refined by pretext to guarantee fit
    // ------------------------------------------------------------------
    const inset = NODE_PADDING + borderInset;
    const computedFontSize = useMemo(() => {
      if (hasFixedSize && width != null && height != null) {
        const cw = width - inset * 2;
        const ch = height - inset * 2;
        return computeFontSizeForHeight(draftContent, cw, ch, fontOpts);
      }
      return baseFontSize;
    }, [
      hasFixedSize,
      width,
      height,
      draftContent,
      baseFontSize,
      fontOpts,
      inset,
    ]);

    // ------------------------------------------------------------------
    // Auto mode measurement (only when no fixed size)
    // ------------------------------------------------------------------
    const maxAutoWidth = baseFontSize * MAX_CHARS_PER_LINE * 0.62;

    const autoSize = useMemo(() => {
      if (hasFixedSize) return null;
      // When content is empty, measure the placeholder so the node is wide
      // enough to display it without clipping.
      const text = draftContent || 'Type...';
      return measureTextContent(text, {
        ...fontOpts,
        fontSize: baseFontSize,
        maxWidth: maxAutoWidth,
      });
    }, [hasFixedSize, draftContent, baseFontSize, fontOpts, maxAutoWidth]);

    const effectiveFontSize = liveFontSize ?? computedFontSize;

    // In auto mode, compute target dimensions from content measurement.
    // In fixed mode, dimensions come from node style (set by setNodeGeometry).
    // WRAP_TOLERANCE prevents the browser from wrapping a line that pretext
    // said fits — the most common cause of last-line clipping.
    const autoWidth = hasFixedSize
      ? undefined
      : Math.max((autoSize?.width ?? 0) + WRAP_TOLERANCE + inset * 2, 30);
    const autoHeight = hasFixedSize
      ? undefined
      : Math.max(
          (autoSize?.height ?? 0) + inset * 2,
          baseFontSize * 1.5 + inset * 2,
        );

    // ------------------------------------------------------------------
    // Resize callbacks — live font recalc during drag
    // ------------------------------------------------------------------
    const handleResizeStart = useCallback(() => {
      isResizingRef.current = true;
    }, []);

    const handleResize = useCallback(
      (width: number, height: number) => {
        // pretext is pure arithmetic — no DOM reflow, no debounce needed.
        const cw = width - inset * 2;
        const ch = height - inset * 2;
        const fs = computeFontSizeForHeight(draftContent, cw, ch, fontOpts);
        setLiveFontSize(fs);
      },
      [draftContent, fontOpts, inset],
    );

    const handleResizeEnd = useCallback(() => {
      isResizingRef.current = false;
      setLiveFontSize(null); // clear live → computedFontSize takes over
      // setNodeGeometry (called by NodeWrapper) writes numeric width/height
      // to node.style, which flips hasFixedSize → true automatically.
    }, []);

    // ------------------------------------------------------------------
    // Toolbar state
    // ------------------------------------------------------------------
    const toggleDecoration = (value: string) => {
      let current = textDecoration.split(' ').filter(Boolean);
      if (current.includes(value)) {
        current = current.filter((v) => v !== value);
      } else {
        current.push(value);
      }
      updateStyle({ textDecoration: current.join(' ') });
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsEditing(true);
      setTimeout(() => textareaRef.current?.focus(), 50);
    };

    const handleBlur = () => {
      setIsEditing(false);
      // Only commit if something actually changed — avoid a spurious undo
      // snapshot when the user clicks into and immediately out of the node.
      if (draftContent === (data.content ?? '')) return;
      // Commit the draft to the store on blur so it records a single undo entry
      // for the entire editing session, rather than on every keystroke.
      updateNodeData(id, { content: draftContent });
    };

    const TextToolbar = (
      <>
        <FloatingToolbar.Select
          options={FONT_FAMILY_OPTIONS.map((f) => ({
            value: f.value,
            label: f.name,
          }))}
          value={style.fontFamily ?? 'default'}
          onChange={(v) => updateStyle({ fontFamily: v })}
        />

        <FloatingToolbar.Divider />

        <FloatingToolbar.ToggleButton
          active={style.fontWeight === 'bold'}
          title="Bold"
          onClick={() =>
            updateStyle({
              fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold',
            })
          }
        >
          <Bold />
        </FloatingToolbar.ToggleButton>

        <FloatingToolbar.ToggleButton
          active={style.fontStyle === 'italic'}
          title="Italic"
          onClick={() =>
            updateStyle({
              fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic',
            })
          }
        >
          <Italic />
        </FloatingToolbar.ToggleButton>

        <FloatingToolbar.ToggleButton
          active={textDecoration.includes('underline')}
          title="Underline"
          onClick={() => toggleDecoration('underline')}
        >
          <Underline />
        </FloatingToolbar.ToggleButton>

        <FloatingToolbar.ToggleButton
          active={textDecoration.includes('line-through')}
          title="Strikethrough"
          onClick={() => toggleDecoration('line-through')}
        >
          <Strikethrough />
        </FloatingToolbar.ToggleButton>

        <FloatingToolbar.Divider />

        <FloatingToolbar.ColorPicker
          colors={COLOR_PALETTE}
          value={data.style?.textColor ?? COLOR_PALETTE[0].value}
          onSelect={(v) =>
            updateNodeData(id, {
              style: { ...data.style, textColor: v },
            })
          }
          title="Change Text Color"
        >
          <Baseline
            style={{
              color: data.style?.textColor || COLOR_PALETTE[0].value,
            }}
          />
        </FloatingToolbar.ColorPicker>
        <FloatingToolbar.ColorPicker
          colors={NODE_BG_COLORS}
          value={data.style?.backgroundColor ?? NODE_BG_COLORS[0].value}
          onSelect={(v) =>
            updateNodeData(id, {
              style: { ...data.style, backgroundColor: v },
            })
          }
          title="Change Color"
        />
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'text'}
        selected={selected}
        toolbar={TextToolbar}
        keepAspectRatio={false}
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        className="transition-all duration-200"
      >
        <div
          className={clsx(
            'relative overflow-hidden',
            hasFixedSize ? 'h-full w-full' : undefined,
          )}
          style={{
            padding: `${NODE_PADDING}px`,
            ...(autoWidth != null
              ? { width: autoWidth, height: autoHeight }
              : undefined),
          }}
          onDoubleClick={handleDoubleClick}
        >
          <textarea
            ref={textareaRef}
            className={clsx(
              'placeholder:text-fg-subtle/30 h-full w-full resize-none overflow-hidden bg-transparent outline-none',
              isEditing
                ? 'nodrag cursor-text'
                : 'pointer-events-none cursor-grab select-none',
            )}
            placeholder="Type..."
            value={draftContent}
            onChange={(e) => {
              // Update local draft state — no store write on every keystroke.
              setDraftContent(e.target.value);
            }}
            onBlur={handleBlur}
            readOnly={!isEditing}
            style={{
              color: textColor,
              fontWeight: isBold ? 'bold' : 'normal',
              fontStyle: isItalic ? 'italic' : 'normal',
              fontFamily,
              fontSize: `${effectiveFontSize}px`,
              lineHeight: 1.5,
              textDecoration,
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              padding: 0,
              border: 'none',
            }}
          />
        </div>
      </NodeWrapper>
    );
  },
);
