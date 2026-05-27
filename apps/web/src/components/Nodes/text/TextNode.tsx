import { resolveAccent } from '@sediment/shared';
import { Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { memo, useCallback, useState, useRef, useMemo } from 'react';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import useCanvasStore from '@/store/canvasStore.ts';

import { getAccentTokens } from '../accentTokens';
import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { TextNodeBody } from '../shared/TextNodeBody';

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
  ({ id, data, selected, width }: NodeProps<TextNodeType>) => {
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const content = data.content ?? '';

    // ------------------------------------------------------------------
    // Style derivation
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

    // ------------------------------------------------------------------
    // Shared surface (auto-size + draft state + wrapper/body prop bundles)
    // ------------------------------------------------------------------
    const surface = useTextNodeSurface({
      nodeId: id,
      width,
      isEditing,
      content,
      baseFontSize: 16,
      padding: NODE_PADDING,
      borderInset,
      fontOpts,
      placeholder: 'Type...',
    });

    // ------------------------------------------------------------------
    // Editing handlers
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

    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      setIsEditing(true);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }, []);

    const handleBlur = useCallback(() => {
      setIsEditing(false);
      if (surface.draft === content) return;
      updateNodeData(id, { content: surface.draft });
    }, [surface.draft, content, id, updateNodeData]);

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
        className="transition-all duration-200"
        {...surface.nodeWrapperProps}
      >
        <TextNodeBody
          ref={textareaRef}
          {...surface.bodyProps}
          draft={surface.draft}
          onChange={surface.setDraft}
          onBlur={handleBlur}
          isEditing={isEditing}
          onRequestEdit={handleDoubleClick}
          placeholder="Type..."
          fontFamily={fontFamily}
          fontWeight={isBold ? 'bold' : 'normal'}
          fontStyle={isItalic ? 'italic' : 'normal'}
          textDecoration={textDecoration}
          color={textColor}
          textareaClassName="placeholder:text-fg-subtle/30"
          containerClassName="overflow-hidden"
        >
          {/*
            Server flagged the per-node markdown file as missing on disk.
            Surface a small inline banner while the editor is empty so the
            user can recreate the file by typing or remove the node.
          */}
          {data.contentMissing && !surface.draft.trim() && (
            <div className="absolute top-1 right-1 left-1 z-10">
              <MissingFileBanner
                nodeId={id}
                title="Text file missing — type to recreate it"
                variant="inline"
              />
            </div>
          )}
        </TextNodeBody>
      </NodeWrapper>
    );
  },
);
