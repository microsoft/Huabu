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

export interface TextNodeBodyProps {
  // -------- Sizing (from useTextNodeSurface().bodyProps) --------
  /** Width to apply to the container div. */
  effectiveWidth: number;
  /** Height to apply to the container div. */
  effectiveHeight: number;
  /** Font size (px) for the textarea. */
  effectiveFontSize: number;
  /** Inner padding (px), applied on all sides. */
  padding: number;

  // -------- Editing state --------
  /** Current draft text (controlled by parent via `setDraft`). */
  draft: string;
  /** Called on every keystroke with the new value. */
  onChange: (next: string) => void;
  /** Called when the textarea loses focus. */
  onBlur: () => void;
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
      padding,
      draft,
      onChange,
      onBlur,
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
    return (
      <div
        className={clsx('relative', containerClassName)}
        style={{
          padding: `${padding}px`,
          width: effectiveWidth,
          height: effectiveHeight,
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
          readOnly={!isEditing}
          style={{
            padding: 0,
            border: 'none',
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
        />
      </div>
    );
  },
);
