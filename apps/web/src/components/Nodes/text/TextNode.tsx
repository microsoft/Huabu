// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Bold, Italic, Underline, Strikethrough } from 'lucide-react';
import { memo, useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveAccent } from '@huabu/shared';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar.tsx';
import { useTextNodeSurface } from '@/hooks/useTextNodeSurface';
import useCanvasStore, { settleNodePreprocess } from '@/store/canvasStore.ts';
import {
  FONT_FAMILY_CSS,
  getTextNodeFontOpts,
  TEXT_NODE_PADDING_X as NODE_PADDING_X,
  TEXT_NODE_PADDING_Y as NODE_PADDING_Y,
  TEXT_NODE_PLACEHOLDER,
} from '@/utils/node/nodeFontConfig';

import { getAccentTokens } from '../accentTokens';
import { MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';
import { resolveTextBodyBox, TextNodeBody } from '../shared/TextNodeBody';

import type { CanvasTextNodeData, NodeStyle } from '../types';
import type { NodeFontFamily } from '@huabu/shared';
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
    const inlineEditRequested = useCanvasStore(
      (state) => state.pendingInlineEditNodeId === id,
    );
    const consumeInlineEditRequest = useCanvasStore(
      (state) => state.consumeInlineEditRequest,
    );
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const content = data.content ?? '';
    const isContentMissing = data.contentMissing === true;

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

    const fontOpts = getTextNodeFontOpts(style);

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
      fontOpts,
      placeholder: TEXT_NODE_PLACEHOLDER,
    });
    const missingBodyBox = resolveTextBodyBox({
      width: surface.bodyProps.effectiveWidth,
      height: surface.bodyProps.effectiveHeight,
      paddingX: surface.bodyProps.paddingX,
      paddingY: surface.bodyProps.paddingY,
    });

    // ------------------------------------------------------------------
    // Editing handlers
    // ------------------------------------------------------------------
    // Single focus path: whenever inline editing begins — no matter the
    // trigger (double-click or a post-create request) — focus the
    // textarea. Running in a committed effect guarantees the textarea is
    // mounted, so this is deterministic where a fixed `setTimeout` focus
    // delay was merely a race that usually won.
    useEffect(() => {
      if (isEditing) textareaRef.current?.focus();
    }, [isEditing]);

    // Post-create: a freshly created text node requests direct inline
    // editing. Enter editing (the focus effect above does the focus) and
    // consume the one-shot request.
    useEffect(() => {
      if (!inlineEditRequested) return;
      if (!isContentMissing) setIsEditing(true);
      consumeInlineEditRequest(id);
    }, [consumeInlineEditRequest, id, inlineEditRequested, isContentMissing]);

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

        <FloatingToolbar.Divider />

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
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'text'}
        selected={selected}
        toolbar={isContentMissing ? undefined : TextToolbar}
        keepAspectRatio={false}
        className="transition-all duration-200"
        {...surface.nodeWrapperProps}
      >
        {isContentMissing ? (
          <div
            className="flex items-center overflow-hidden"
            style={{
              width: missingBodyBox.width,
              height: missingBodyBox.height,
            }}
          >
            <MissingFileBanner nodeId={id} />
          </div>
        ) : (
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
          />
        )}
      </NodeWrapper>
    );
  },
);
