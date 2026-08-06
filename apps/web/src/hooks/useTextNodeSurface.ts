// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Single-call hook that bundles everything a text-bearing canvas node
 * needs in order to render a `<TextNodeBody>`:
 *
 *   - `useState` + external-content sync for the draft text.
 *   - `useTextAutoSize` for fontSize / width / height behaviour.
 *   - The resize callback bundle ready to spread onto `<NodeWrapper>`.
 *   - The sizing bundle ready to spread onto `<TextNodeBody>`.
 *
 * Splitting these concerns into separate hooks worked but forced every
 * caller (TextNode, QuestionNode) to duplicate the wiring. With this
 * unified hook, both nodes use the same pattern:
 *
 * ```tsx
 * const surface = useTextNodeSurface({
 *   nodeId: id,
 *   width,
 *   isEditing,
 *   content,             // current persisted text
 *   baseFontSize: 16,
 *   paddingX: NODE_PADDING,
 *   paddingY: NODE_PADDING,
 *   fontOpts,
 *   placeholder: 'Type...',
 * });
 *
 * return (
 *   <NodeWrapper {...wrapperProps} {...surface.nodeWrapperProps}>
 *     <TextNodeBody
 *       ref={textareaRef}
 *       {...surface.bodyProps}
 *       draft={surface.draft}
 *       onChange={surface.setDraft}
 *       onBlur={handleBlur}
 *       isEditing={isEditing}
 *       onRequestEdit={handleDoubleClick}
 *       placeholder="Type..."
 *       fontFamily={...}
 *     />
 *   </NodeWrapper>
 * );
 * ```
 */

import { useEffect, useState } from 'react';

import { useTextAutoSize } from './useTextAutoSize';

import type { FontOpts } from '@/utils/node/textMeasure';

export interface UseTextNodeSurfaceOpts {
  // -------- Identity --------
  nodeId: string;
  /** Node width from `NodeProps`. May be undefined on first render. */
  width?: number;

  // -------- Editing state (owned by parent) --------
  /** Whether the user is currently editing the textarea. */
  isEditing: boolean;
  /** The persisted text content. Draft is re-synced from this when not editing. */
  content: string;

  // -------- Sizing config --------
  baseFontSize?: number;
  paddingX: number;
  paddingY: number;
  fontOpts: FontOpts;
  placeholder?: string;
}

export interface UseTextNodeSurfaceResult {
  // -------- Draft state --------
  /** Current draft (controlled by this hook). */
  draft: string;
  /** Setter — call from the textarea's `onChange`. */
  setDraft: (next: string) => void;

  // -------- Props bundles --------
  /** Spread onto `<NodeWrapper>` to wire all resize behaviour. */
  nodeWrapperProps: {
    onResizeStart: () => void;
    onResize: (w: number, h: number) => void;
    onResizeEnd: (w: number, h: number) => void;
    resizeEndClearHeight: true;
  };
  /** Spread onto `<TextNodeBody>` for sizing. */
  bodyProps: {
    effectiveWidth: number;
    effectiveHeight: number;
    effectiveFontSize: number;
    paddingX: number;
    paddingY: number;
  };
}

export function useTextNodeSurface(
  opts: UseTextNodeSurfaceOpts,
): UseTextNodeSurfaceResult {
  const {
    nodeId,
    width,
    isEditing,
    content,
    baseFontSize = 16,
    paddingX,
    paddingY,
    fontOpts,
    placeholder = 'Type...',
  } = opts;

  // -------- Draft state --------
  // Local-during-editing, re-synced from store on undo/redo/external updates.
  const [draft, setDraft] = useState(content);
  useEffect(() => {
    if (!isEditing) setDraft(content);
  }, [content, isEditing]);

  // -------- Auto-size --------
  const autoSize = useTextAutoSize({
    nodeId,
    text: draft,
    baseFontSize,
    paddingX,
    paddingY,
    fontOpts,
    placeholder,
    width,
  });

  return {
    draft,
    setDraft,
    nodeWrapperProps: {
      onResizeStart: autoSize.handleResizeStart,
      onResize: autoSize.handleResize,
      onResizeEnd: autoSize.handleResizeEnd,
      resizeEndClearHeight: true,
    },
    bodyProps: {
      effectiveWidth: autoSize.effectiveWidth,
      effectiveHeight: autoSize.effectiveHeight,
      effectiveFontSize: autoSize.effectiveFontSize,
      paddingX,
      paddingY,
    },
  };
}
