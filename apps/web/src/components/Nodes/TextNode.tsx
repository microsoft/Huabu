import { type Node, type NodeProps, useStore } from '@xyflow/react';
import { clsx } from 'clsx';
import { Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { memo, useCallback, useState, useRef, useMemo, useEffect } from 'react';

import { IconButton } from '@/components/Common/IconButton.tsx';
import { NodeBgColorSelector } from '@/components/Common/NodeBgColorSelector.tsx';
import { NodeTextColorSelector } from '@/components/Common/NodeTextColorSelector.tsx';
import useCanvasStore from '@/store/canvasStore.ts';

import { NodeWrapper } from './NodeWrapper.tsx';

import type { CanvasTextNodeData, NodeStyle } from './types.ts';

const FONT_FAMILIES = [
  { name: 'Default', value: 'ui-sans-serif, system-ui, sans-serif' },
  {
    name: 'Serif',
    value: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    name: 'Mono',
    value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  { name: 'Hand', value: '"Comic Sans MS", "Chalkboard SE", sans-serif' },
];

/** Maximum characters per line before wrapping. */
const MAX_CHARS_PER_LINE = 18;
/** Padding inside the node (px on each side). */
const NODE_PADDING = 4;

export type TextNodeType = Node<CanvasTextNodeData, 'text'>;

/**
 * Measure the natural content dimensions using a hidden off-screen element.
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
  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.visibility = 'hidden';
  el.style.whiteSpace = 'pre-wrap';
  el.style.wordBreak = 'break-word';
  el.style.fontSize = `${opts.fontSize}px`;
  el.style.fontFamily = opts.fontFamily;
  el.style.fontWeight = opts.fontWeight;
  el.style.fontStyle = opts.fontStyle;
  el.style.lineHeight = String(opts.lineHeight);
  el.style.maxWidth = `${opts.maxWidth}px`;
  el.style.padding = '0';
  el.textContent = text || ' ';
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  document.body.removeChild(el);
  // Ceil the height to prevent sub-pixel rounding from clipping the last line.
  return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

/**
 * Binary-search for the font size that makes text fill a target height
 * at a given content width.
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
    const measured = measureTextContent(text, {
      ...opts,
      fontSize: mid,
      maxWidth: contentWidth,
    });
    if (measured.height <= contentHeight) {
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
    const [draftLabel, setDraftLabel] = useState(
      data.label as string | undefined,
    );
    const [draftLabelSource, setDraftLabelSource] = useState(
      data.labelSource as string | undefined,
    );

    // Sync draft from external store changes (undo/redo, server updates).
    useEffect(() => {
      if (!isEditing) {
        setDraftContent(data.content ?? '');
        setDraftLabel(data.label as string | undefined);
        setDraftLabelSource(data.labelSource as string | undefined);
      }
    }, [data.content, data.label, data.labelSource, isEditing]);

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
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    const baseFontSize = style.fontSize || 16;
    const fontFamily = style.fontFamily || FONT_FAMILIES[0].value;
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

    // ------------------------------------------------------------------
    // Effective font size:
    //   Resizing live  → liveFontSize (debounced during drag)
    //   Fixed mode     → computed to fill node height at node width
    //   Auto mode      → baseFontSize from style
    // ------------------------------------------------------------------
    const computedFontSize = useMemo(() => {
      if (hasFixedSize && width != null && height != null) {
        const cw = width - NODE_PADDING * 2;
        const ch = height - NODE_PADDING * 2;
        return computeFontSizeForHeight(draftContent, cw, ch, fontOpts);
      }
      return baseFontSize;
    }, [hasFixedSize, width, height, draftContent, baseFontSize, fontOpts]);

    const effectiveFontSize = liveFontSize ?? computedFontSize;

    // ------------------------------------------------------------------
    // Auto mode measurement (only when no fixed size)
    // ------------------------------------------------------------------
    const maxAutoWidth = baseFontSize * MAX_CHARS_PER_LINE * 0.62;

    const autoSize = useMemo(() => {
      if (hasFixedSize) return null;
      return measureTextContent(draftContent, {
        ...fontOpts,
        fontSize: baseFontSize,
        maxWidth: maxAutoWidth,
      });
    }, [hasFixedSize, draftContent, baseFontSize, fontOpts, maxAutoWidth]);

    // In auto mode, compute target dimensions from content measurement.
    // In fixed mode, dimensions come from node style (set by setNodeGeometry).
    const autoWidth = hasFixedSize
      ? undefined
      : Math.max((autoSize?.width ?? 0) + NODE_PADDING * 2, 30);
    const autoHeight = hasFixedSize
      ? undefined
      : Math.max(
          (autoSize?.height ?? 0) + NODE_PADDING * 2,
          baseFontSize * 1.5 + NODE_PADDING * 2,
        );

    // ------------------------------------------------------------------
    // Resize callbacks — live font recalc during drag
    // ------------------------------------------------------------------
    const handleResizeStart = useCallback(() => {
      isResizingRef.current = true;
    }, []);

    const handleResize = useCallback(
      (width: number, height: number) => {
        // Debounce the font-size computation (~30ms) for smooth dragging
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          const cw = width - NODE_PADDING * 2;
          const ch = height - NODE_PADDING * 2;
          const fs = computeFontSizeForHeight(draftContent, cw, ch, fontOpts);
          setLiveFontSize(fs);
        }, 10);
      },
      [draftContent, fontOpts],
    );

    const handleResizeEnd = useCallback(() => {
      isResizingRef.current = false;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
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
      const isDirty =
        draftContent !== (data.content ?? '') ||
        draftLabel !== (data.label as string | undefined) ||
        draftLabelSource !== (data.labelSource as string | undefined);
      if (!isDirty) return;
      // Commit the draft to the store on blur so it records a single undo entry
      // for the entire editing session, rather than on every keystroke.
      const patch: Record<string, unknown> = { content: draftContent };
      if (draftLabel !== undefined) patch.label = draftLabel;
      if (draftLabelSource !== undefined) patch.labelSource = draftLabelSource;
      updateNodeData(id, patch);
    };

    const TextToolbar = (
      <div className="flex w-full items-center gap-1">
        <div
          className="hover:bg-muted text-muted-foreground border-border flex items-center rounded border bg-transparent p-0.5 transition-colors"
          title="Font Family"
        >
          <select
            className="h-full w-16 cursor-pointer bg-transparent text-xs outline-none"
            value={fontFamily}
            onChange={(e) => updateStyle({ fontFamily: e.target.value })}
          >
            {FONT_FAMILIES.map((f) => (
              <option key={f.name} value={f.value} className="text-black">
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <div className="bg-border mx-1 h-3 w-px" />

        <IconButton
          onClick={() =>
            updateStyle({
              fontWeight: style.fontWeight === 'bold' ? 'normal' : 'bold',
            })
          }
          className={clsx(
            'rounded p-1',
            style.fontWeight === 'bold'
              ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
              : 'text-muted-foreground hover:bg-background',
          )}
        >
          <Bold size={14} />
        </IconButton>

        <IconButton
          onClick={() =>
            updateStyle({
              fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic',
            })
          }
          className={clsx(
            'rounded p-1',
            style.fontStyle === 'italic'
              ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
              : 'text-muted-foreground hover:bg-background',
          )}
        >
          <Italic size={14} />
        </IconButton>

        <IconButton
          onClick={() => toggleDecoration('underline')}
          className={clsx(
            'p-1',
            textDecoration.includes('underline')
              ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
              : 'text-muted-foreground hover:bg-background',
          )}
        >
          <Underline size={14} />
        </IconButton>

        <IconButton
          onClick={() => toggleDecoration('line-through')}
          className={clsx(
            'p-1',
            textDecoration.includes('line-through')
              ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
              : 'text-muted-foreground hover:bg-background',
          )}
        >
          <Strikethrough size={14} />
        </IconButton>

        <div className="bg-border mx-1 h-3 w-px" />

        <NodeTextColorSelector
          nodeId={id}
          currentTextColor={data.style?.textColor}
          style={data.style}
        />
        <NodeBgColorSelector
          nodeId={id}
          currentColor={data.style?.backgroundColor}
          style={data.style}
        />
      </div>
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
              'placeholder:text-muted-foreground/30 h-full w-full resize-none overflow-hidden bg-transparent outline-none',
              isEditing
                ? 'nodrag cursor-text'
                : 'pointer-events-none cursor-grab select-none',
            )}
            placeholder="Type..."
            value={draftContent}
            onChange={(e) => {
              const newContent = e.target.value;
              // Update local draft state — no store write on every keystroke.
              setDraftContent(newContent);

              // Auto-update label from content when not manually renamed.
              if (draftLabelSource !== 'user') {
                const firstLine = newContent.split('\n')[0]?.trim() ?? '';
                const autoLabel =
                  firstLine.length > 40
                    ? firstLine.slice(0, 40) + '…'
                    : firstLine;
                if (autoLabel) {
                  setDraftLabel(autoLabel);
                  setDraftLabelSource('auto');
                }
              }
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
