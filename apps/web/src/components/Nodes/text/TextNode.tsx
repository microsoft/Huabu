import { Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { memo, useCallback, useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveAccent } from '@sediment/shared';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import useCanvasStore, { settleNodePreprocess } from '@/store/canvasStore.ts';
import {
  FONT_FAMILY_CSS,
  getTextNodeFontOpts,
  TEXT_ACCENT_BORDER as ACCENT_BORDER,
  TEXT_NODE_PADDING_X as NODE_PADDING_X,
  TEXT_NODE_PADDING_Y as NODE_PADDING_Y,
  TEXT_NODE_PLACEHOLDER,
} from '@/utils/node/nodeFontConfig';

import { getAccentTokens } from '../accentTokens';
import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { TextNodeBody } from '../shared/TextNodeBody';

import type { CanvasTextNodeData, NodeStyle } from '../types';
import type { NodeFontFamily } from '@sediment/shared';
import type { Node, NodeProps } from '@xyflow/react';

const FONT_FAMILY_OPTIONS: { name: string; value: NodeFontFamily }[] = [
  { name: 'Default', value: 'default' },
  { name: 'Serif', value: 'serif' },
  { name: 'Mono', value: 'mono' },
  { name: 'Hand', value: 'hand' },
];

export type TextNodeType = Node<CanvasTextNodeData, 'text'>;

export const TextNode = memo(
  ({ id, data, selected, width }: NodeProps<TextNodeType>) => {
    const { t } = useTranslation();
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

    // Accent is the single source of color styling. NodeWrapper paints
    // both the border and the fill from `data.style.accent` (using the
    // same `accentTokens` formulas as SemanticPlaceholder, so semantic
    // zoom doesn't visibly shift the color). Locally we only need the
    // foreground tint for the editable text body.
    const accent = resolveAccent(style.accent);
    const accentTokens = accent ? getAccentTokens(accent) : null;
    const textColor = accentTokens?.fg ?? undefined;

    const fontOpts = useMemo(
      () => getTextNodeFontOpts(style),
      [style.fontFamily, style.fontWeight, style.fontStyle],
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
      paddingX: NODE_PADDING_X,
      paddingY: NODE_PADDING_Y,
      borderInset,
      fontOpts,
      placeholder: TEXT_NODE_PLACEHOLDER,
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
      // Exit-edit "settle": commit the auto-derived label (the `.md`
      // filename) now that the user left the inline editor, instead of on
      // every keystroke pause. See
      // `docs/architecture/node-preprocessing.md` §4 (Triggers & state).
      settleNodePreprocess(id);
    }, [surface.draft, content, id, updateNodeData]);

    const TextToolbar = (
      <>
        <FloatingToolbar.Select
          options={FONT_FAMILY_OPTIONS.map((f) => ({
            value: f.value,
            label:
              f.value === 'default'
                ? t('node.fontDefault')
                : f.value === 'serif'
                  ? t('node.fontSerif')
                  : f.value === 'mono'
                    ? t('node.fontMono')
                    : t('node.fontHand'),
          }))}
          value={style.fontFamily ?? 'default'}
          onChange={(v) => updateStyle({ fontFamily: v })}
        />

        <FloatingToolbar.Divider />

        <FloatingToolbar.ToggleButton
          active={style.fontWeight === 'bold'}
          title={t('editor.inlineMarks.bold')}
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
          title={t('editor.inlineMarks.italic')}
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
          title={t('node.underline')}
          onClick={() => toggleDecoration('underline')}
        >
          <Underline />
        </FloatingToolbar.ToggleButton>

        <FloatingToolbar.ToggleButton
          active={textDecoration.includes('line-through')}
          title={t('editor.inlineMarks.strikethrough')}
          onClick={() => toggleDecoration('line-through')}
        >
          <Strikethrough />
        </FloatingToolbar.ToggleButton>
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
          placeholder={TEXT_NODE_PLACEHOLDER}
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
                title={t('node.textFileMissingRecreate')}
                variant="inline"
              />
            </div>
          )}
        </TextNodeBody>
      </NodeWrapper>
    );
  },
);
