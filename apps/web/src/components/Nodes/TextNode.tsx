import { type Node, type NodeProps } from '@xyflow/react';
import { clsx } from 'clsx';
import { Bold, Italic, Type, Underline, Strikethrough } from 'lucide-react';
import { useCallback, useState, useRef, useMemo, useLayoutEffect } from 'react';

import { GhostButton } from '@/components/Common/GhostButton.tsx';
import { NodeBgColorSelector } from '@/components/Common/NodeBgColorSelector.tsx';
import { NodeTextColorSelector } from '@/components/Common/NodeTextColorSelector.tsx';

import { NodeWrapper } from './NodeWrapper.tsx';
import useCanvasStore from '../../store/canvasStore.ts';

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
const NODE_PADDING = 8;

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
  return { width: rect.width, height: rect.height };
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
  return Math.max(1, Math.round(lo));
}

export const TextNode = ({ id, data, selected }: NodeProps<TextNodeType>) => {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isEditing, setIsEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isResizingRef = useRef(false);

  // ------------------------------------------------------------------
  // User-set dimensions: null → auto mode, number → user has resized.
  // ------------------------------------------------------------------
  const [userWidth, setUserWidth] = useState<number | null>(
    typeof data.userWidth === 'number' ? (data.userWidth as number) : null,
  );
  const [userHeight, setUserHeight] = useState<number | null>(
    typeof data.userHeight === 'number' ? (data.userHeight as number) : null,
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

  const content = data.content ?? '';

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
  //   User mode      → computed to fill userHeight at userWidth
  //   Auto mode      → baseFontSize from style
  // ------------------------------------------------------------------
  const computedFontSize = useMemo(() => {
    if (userWidth !== null && userHeight !== null) {
      const cw = userWidth - NODE_PADDING * 2;
      const ch = userHeight - NODE_PADDING * 2;
      return computeFontSizeForHeight(content, cw, ch, fontOpts);
    }
    return baseFontSize;
  }, [userWidth, userHeight, content, baseFontSize, fontOpts]);

  const effectiveFontSize = liveFontSize ?? computedFontSize;

  // ------------------------------------------------------------------
  // Auto mode measurement (only when not user-resized)
  // ------------------------------------------------------------------
  const maxAutoWidth = baseFontSize * MAX_CHARS_PER_LINE * 0.62;

  const autoSize = useMemo(() => {
    if (userWidth !== null && userHeight !== null) return null;
    return measureTextContent(content, {
      ...fontOpts,
      fontSize: baseFontSize,
      maxWidth: maxAutoWidth,
    });
  }, [userWidth, userHeight, content, baseFontSize, fontOpts, maxAutoWidth]);

  const targetWidth =
    userWidth ?? Math.max((autoSize?.width ?? 0) + NODE_PADDING * 2, 30);
  const targetHeight =
    userHeight ??
    Math.max(
      (autoSize?.height ?? 0) + NODE_PADDING * 2,
      baseFontSize * 1.5 + NODE_PADDING * 2,
    );

  // Avoid redundant store updates
  const prevDimsRef = useRef({ w: 0, h: 0 });

  useLayoutEffect(() => {
    if (isResizingRef.current) return;

    const w = targetWidth;
    const h = targetHeight;

    if (
      Math.abs(prevDimsRef.current.w - w) < 1 &&
      Math.abs(prevDimsRef.current.h - h) < 1
    )
      return;

    prevDimsRef.current = { w, h };

    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, style: { ...n.style, width: w, height: h } } : n,
      ),
    }));
  }, [id, targetWidth, targetHeight]);

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
        const fs = computeFontSizeForHeight(
          data.content ?? '',
          cw,
          ch,
          fontOpts,
        );
        setLiveFontSize(fs);
      }, 10);
    },
    [data.content, fontOpts],
  );

  const handleResizeEnd = useCallback(
    (width: number, height: number) => {
      isResizingRef.current = false;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      setUserWidth(width);
      setUserHeight(height);
      setLiveFontSize(null); // clear live → computedFontSize takes over
      updateNodeData(id, { userWidth: width, userHeight: height });
      prevDimsRef.current = { w: width, h: height };
    },
    [id, updateNodeData],
  );

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

  const handleBlur = () => setIsEditing(false);

  const TextToolbar = (
    <div className="flex w-full items-center gap-1">
      <div className="text-muted-foreground flex flex-1 items-center text-xs font-medium">
        <Type size={14} />
      </div>
      <div className="bg-border h-3 w-px" />
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

      <GhostButton
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
      </GhostButton>

      <GhostButton
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
      </GhostButton>

      <GhostButton
        onClick={() => toggleDecoration('underline')}
        className={clsx(
          'p-1',
          textDecoration.includes('underline')
            ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Underline size={14} />
      </GhostButton>

      <GhostButton
        onClick={() => toggleDecoration('line-through')}
        className={clsx(
          'p-1',
          textDecoration.includes('line-through')
            ? 'text-theme-500 bg-theme-50 enabled:hover:bg-theme-50'
            : 'text-muted-foreground hover:bg-background',
        )}
      >
        <Strikethrough size={14} />
      </GhostButton>

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
        className="relative h-full w-full overflow-hidden"
        style={{ padding: `${NODE_PADDING}px` }}
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
          defaultValue={content}
          onChange={(e) => updateNodeData(id, { content: e.target.value })}
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
          }}
        />
      </div>
    </NodeWrapper>
  );
};
