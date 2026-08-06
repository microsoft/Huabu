// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified surface for canvas nodes whose body is "a single auto-sizing
 * textarea" (TextNode, QuestionNode, ...).
 *
 * Responsibilities (kept inside this component so individual node types
 * stop duplicating them):
 *
 *  - The container `<div>` with the auto-sized `width` / `height` / `padding`.
 *  - The absolutely-positioned invisible overlay that captures double-click
 *    while not editing (so the textarea can stay `pointer-events: none`).
 *  - The `<textarea>` with the locked font size, font family, weight, style,
 *    decoration, color, and the standard reset (no padding/border, wrap rules).
 *  - The `readOnly` + `pointer-events` toggle driven by `isEditing`.
 *
 * Anything position-specific (status badge, missing-file banner, etc.) is
 * passed as `children` and rendered ABOVE the textarea, inside the same
 * container, so absolute offsets behave as the parent expects.
 *
 * Sizing values come from `useTextNodeSurface()` so callers don't need to
 * wire `effectiveWidth` / `effectiveHeight` / `effectiveFontSize` by hand.
 */

import { clsx } from 'clsx';
import { forwardRef, type CSSProperties, type ReactNode } from 'react';

import { NODE_SHELL_INSET } from '@huabu/shared/canvas-engine';

/** Border (px) the node shell adds on each side. */
const SHELL_BORDER = NODE_SHELL_INSET / 2;

/**
 * Geometry actually written to the body container.
 *
 * `NodeWrapper` wraps every node in a 3px border (transparent unless an
 * accent is set) with `box-sizing: border-box`, so a child may only
 * occupy the node box minus {@link NODE_SHELL_INSET}.
 *
 * Only the **width** is corrected for it, because only the width is
 * pinned: React Flow owns `style.width`, so a body taking the node's full
 * outer width overflows the shell and the wrapper clips the outermost
 * pixels of its padding — which is why text used to sit glued to an
 * accent border. Height is content-driven for these node types (the shell
 * has no height of its own and grows to fit the body), so the body keeps
 * its full height and vertical padding; subtracting there would only
 * tighten the vertical rhythm of every text node for nothing.
 *
 * The correction keeps the *text* box identical to what `useTextAutoSize`
 * measured — `width - 2 * paddingX` — by letting the shell border count
 * towards the padding rather than eating into the content. Any other
 * split would re-wrap every existing node, because the measurement that
 * decides a node's height assumes exactly this width.
 */
export function resolveTextBodyBox(box: {
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
}): { width: number; height: number; paddingX: number; paddingY: number } {
  return {
    width: Math.max(box.width - NODE_SHELL_INSET, 0),
    height: box.height,
    paddingX: Math.max(box.paddingX - SHELL_BORDER, 0),
    paddingY: box.paddingY,
  };
}

export interface TextNodeBodyProps {
  // -------- Sizing (from useTextNodeSurface().bodyProps) --------
  /** Width of the node's OUTER box (shell border included). */
  effectiveWidth: number;
  /** Height of the body box; the shell's border sits outside it. */
  effectiveHeight: number;
  /** Font size (px) for the textarea. */
  effectiveFontSize: number;
  /** Horizontal inner padding (px), shell border included. */
  paddingX: number;
  /** Vertical inner padding (px). */
  paddingY: number;

  // -------- Editing state --------
  /** Current draft text (controlled by parent via `setDraft`). */
  draft: string;
  /** Called on every keystroke with the new value. */
  onChange: (next: string) => void;
  /**
   * Called when the textarea loses focus. Receives the native React
   * focus event so callers can inspect `relatedTarget` and ignore
   * intra-node focus shifts (e.g. clicking a typeahead menu option).
   */
  onBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  /**
   * Optional textarea keydown handler. Lets the parent intercept keys
   * before the browser's default (used by the QuestionNode `@`
   * mention typeahead).
   */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Optional handlers fired AFTER browser updates the textarea state.
   * Used by typeahead pickers to keep an internal caret tracker in
   * sync without owning the textarea element directly.
   */
  onKeyUp?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLTextAreaElement>) => void;
  onSelect?: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  /** When true the textarea accepts input; when false the dblclick overlay is shown. */
  isEditing: boolean;
  /** Invoked when the user double-clicks the body while not editing. */
  onRequestEdit?: (e: React.MouseEvent) => void;

  // -------- Visual --------
  placeholder: string;
  fontFamily: string;
  fontWeight?: CSSProperties['fontWeight'];
  fontStyle?: CSSProperties['fontStyle'];
  textDecoration?: CSSProperties['textDecoration'];
  color?: CSSProperties['color'];
  lineHeight?: number;
  /**
   * Extra classes for the textarea — typically the per-node placeholder
   * color modifier (e.g. `placeholder:text-fg-subtle/30`).
   */
  textareaClassName?: string;
  /**
   * Extra classes for the container div. Defaults to just `relative` so
   * absolute children (banners, badges) position correctly. Add
   * `overflow-hidden` here if the node should clip rendered content.
   */
  containerClassName?: string;

  // -------- Overlays --------
  /**
   * Rendered above the textarea inside the container. Use for absolute
   * banners (missing-file warning) or status badges that need to overlap
   * the body.
   */
  children?: ReactNode;
}

/**
 * Shared textarea body for text-bearing canvas nodes. Wire it up via
 * `useTextNodeSurface()` to keep both node types behaviorally identical
 * around fontSize, sizing, and the editing surface.
 */
export const TextNodeBody = forwardRef<HTMLTextAreaElement, TextNodeBodyProps>(
  function TextNodeBody(
    {
      effectiveWidth,
      effectiveHeight,
      effectiveFontSize,
      paddingX,
      paddingY,
      draft,
      onChange,
      onBlur,
      onKeyDown,
      onKeyUp,
      onClick,
      onSelect,
      isEditing,
      onRequestEdit,
      placeholder,
      fontFamily,
      fontWeight = 'normal',
      fontStyle = 'normal',
      textDecoration,
      color,
      lineHeight = 1.5,
      textareaClassName,
      containerClassName,
      children,
    },
    textareaRef,
  ) {
    const box = resolveTextBodyBox({
      width: effectiveWidth,
      height: effectiveHeight,
      paddingX,
      paddingY,
    });

    return (
      <div
        className={clsx('relative', containerClassName)}
        style={{
          padding: `${box.paddingY}px ${box.paddingX}px`,
          width: box.width,
          height: box.height,
        }}
      >
        {children}
        {/*
          Invisible dblclick capture layer. Sits above the textarea but
          below children (z-10 reserved for banners/badges that should
          remain clickable). The textarea itself stays pointer-events:none
          when not editing, so this overlay is the sole interaction target.
        */}
        {!isEditing && onRequestEdit && (
          <div
            className="absolute inset-0 z-2 cursor-grab"
            onDoubleClick={onRequestEdit}
          />
        )}
        {/*
          Read-only text mirror. While not editing the textarea's value
          is unreachable to the document-wide TreeWalker (textarea
          content is not real DOM text), so the canvas search highlight
          (`::highlight(huabu-search)`) cannot paint over it. We
          render an identically-laid-out, pointer-events-none mirror
          carrying the same text so the highlight layer can target it.
          The textarea's text color is forced transparent while not
          editing so only the mirror is visible. Placeholder color is
          unaffected (`::placeholder` ignores `color`), so empty-state
          remains identical to before.
        */}
        {!isEditing && draft.length > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-1 overflow-hidden"
            style={{
              padding: `${box.paddingY}px ${box.paddingX}px`,
              color,
              fontFamily,
              fontWeight,
              fontStyle,
              fontSize: `${effectiveFontSize}px`,
              lineHeight,
              textDecoration,
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            {draft}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={clsx(
            'relative z-1 h-full w-full resize-none overflow-hidden bg-transparent outline-none',
            isEditing ? 'nodrag nowheel cursor-text' : 'pointer-events-none',
            textareaClassName,
          )}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onClick={onClick}
          onSelect={onSelect}
          readOnly={!isEditing}
          style={{
            padding: 0,
            border: 'none',
            color: !isEditing && draft.length > 0 ? 'transparent' : color,
            fontFamily,
            fontWeight,
            fontStyle,
            fontSize: `${effectiveFontSize}px`,
            lineHeight,
            textDecoration,
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        />
      </div>
    );
  },
);
