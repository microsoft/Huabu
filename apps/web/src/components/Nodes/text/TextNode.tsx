import { resolveAccent } from '@sediment/shared';
import { clsx } from 'clsx';
import { Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { memo, useCallback, useState, useRef, useMemo, useEffect } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { useTextAutoSize } from '@/hooks/useTextAutoSize';
import useCanvasStore from '@/store/canvasStore.ts';

import { getAccentTokens } from '../accentTokens';
import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasTextNodeData, NodeStyle } from '../types';
import type { NodeFontFamily } from '@sediment/shared';
import type { Node, NodeProps } from '@xyflow/react';

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

/** Padding inside the node (px on each side). */
const NODE_PADDING = 4;
/** Border width NodeWrapper applies when an accent color is set (`border-3`). */
const ACCENT_BORDER = 3;

export type TextNodeType = Node<CanvasTextNodeData, 'text'>;

export const TextNode = memo(
  ({ id, data, selected, width, height }: NodeProps<TextNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    // Text auto-sizing (shared with QuestionNode)
    // ------------------------------------------------------------------
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
    const textDecoration = style.textDecoration || '';

    // Accent is the single source of color styling. The dedicated text-color
    // and background-color pickers were removed in favour of one accent token,
    // which derives both fg and bg via the same formulas as SemanticPlaceholder
    // (so full LOD and minimal LOD stay in sync across semantic zoom).
    const accent = resolveAccent(style.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;
    const textColor = accentTokens?.fg ?? undefined;

    // Build the data object passed to NodeWrapper so its existing rendering
    // path tints the card. When no accent is set we explicitly null out any
    // legacy persisted backgroundColor / textColor so toggling back to
    // Transparent really clears the card instead of falling through to a
    // stale value from the pre-picker era.
    const wrapperData = useMemo(() => {
      const baseStyle = data.style ?? {};
      const nextStyle = accentTokens
        ? {
            ...baseStyle,
            backgroundColor: accentTokens.bg,
            textColor: undefined,
          }
        : { ...baseStyle, backgroundColor: undefined, textColor: undefined };
      return { ...data, style: nextStyle };
    }, [data, accentTokens]);

    const fontOpts = useMemo(
      () => ({
        fontFamily,
        fontWeight: isBold ? 'bold' : 'normal',
        fontStyle: isItalic ? 'italic' : 'normal',
        lineHeight: 1.5,
      }),
      [fontFamily, isBold, isItalic],
    );

    const borderInset = style.accent ? ACCENT_BORDER : 0;

    const {
      hasFixedSize,
      effectiveFontSize,
      autoWidth,
      autoHeight,
      handleResizeStart,
      handleResize,
      handleResizeEnd,
    } = useTextAutoSize({
      nodeId: id,
      text: draftContent,
      baseFontSize,
      padding: NODE_PADDING,
      borderInset,
      fontOpts,
      placeholder: 'Type...',
      width,
      height,
    });

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
      if (draftContent === (data.content ?? '')) return;
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
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={wrapperData}
        type={'text'}
        selected={selected}
        toolbar={TextToolbar}
        keepAspectRatio={false}
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        className="transition-all duration-200"
      >
        {/*
          Server flagged the per-node markdown file as missing on disk.
          Surface a small inline banner while the editor is empty so the
          user can recreate the file by typing or remove the node.
        */}
        {data.contentMissing && !draftContent.trim() && (
          <div className="absolute top-1 right-1 left-1 z-10">
            <MissingFileBanner
              nodeId={id}
              title="Text file missing — type to recreate it"
              variant="inline"
            />
          </div>
        )}
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
