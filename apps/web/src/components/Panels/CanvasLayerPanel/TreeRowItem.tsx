// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  FileWarning,
  Lock,
  Plus,
  Unlock,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../Common/Button';
import { Tooltip } from '../../Common/Tooltip';

import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import type { ReactNode } from 'react';

export interface TreeRowItemProps extends React.HTMLAttributes<HTMLDivElement> {
  depth: number;
  icon: ReactNode;
  label: string;

  // Visual states
  isSelected?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;
  missingFileLabel?: string;

  // Frame/Group specific
  isCollapsible?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;

  // Lock state
  isLocked?: boolean;
  onToggleLock?: () => void;

  // External (not-yet-imported) markdown file: greys out the row,
  // disables rename, and shows a hover "add to canvas" button.
  isExternal?: boolean;
  onImport?: () => void;

  /**
   * Live drop indicator shown during a layer-panel drag-over:
   *
   *   - `'before'` → thin `bg-info` caret on the row's TOP edge
   *     (insert above). Caret's `left` offset reflects
   *     `dropIntentDepth`.
   *   - `'after'`  → same caret on the row's BOTTOM edge (insert
   *     below).
   *   - `'into'`   → NO caret. The frame row's inner pill gets a
   *     soft `bg-info/15` fill so the row itself reads as the drop
   *     target (= drop as first child of THIS frame). Avoids the
   *     ambiguity of a thin caret line near the frame's bottom
   *     border, which users can perceive as "below / outside the
   *     frame".
   *
   * `null` means no indicator. Set by `CanvasLayerTree` from its
   * `dnd-kit` `onDragOver` handler.
   */
  dropIntent?: 'before' | 'after' | 'into' | null;

  /**
   * Hierarchy depth the caret should anchor to — usually the depth of
   * the future parent's children at this slot. The caret's left offset
   * is `8 + dropIntentDepth * 25 px`, matching the indent of a row at
   * that depth. This is what makes the caret visually "live inside"
   * the destination frame: a deeper caret = nested deeper. When the
   * dragged node would land at top-level, pass `0`. Only meaningful
   * when `dropIntent` is `'before'` or `'after'`. Defaults to `depth`.
   */
  dropIntentDepth?: number;

  /**
   * Apply the soft `bg-info/15` fill to this row's pill EVEN when
   * `dropIntent` isn't `'into'`. Used by `CanvasLayerTree` to mark a
   * frame row as the destination parent when the caret is rendered at
   * its bottom edge for the "drop as first child" slot — the fill
   * disambiguates the caret from "after this row as a sibling".
   */
  isIntoFrameHighlight?: boolean;

  // Interaction overrides
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;

  // Editing functionality
  editable?: boolean;
  /**
   * Called when the user commits a rename. May be sync or async, and may
   * return `false` (or resolve to `false`) to signal that the rename was
   * rejected (e.g. by a backend collision check). When rejected the
   * editor exits and the displayed label reverts to `label`.
   */
  onRename?: (newName: string) => void | boolean | Promise<boolean | void>;

  // DnD refs and props
  forwardedRef?: React.Ref<HTMLDivElement>;
  dndListeners?: DraggableSyntheticListeners;
}

export const TreeRowItem = React.memo(
  ({
    depth,
    icon,
    label,
    isSelected,
    isHighlighted,
    isDragging,
    missingFileLabel,
    isCollapsible = false,
    isCollapsed = false,
    onToggleCollapse,
    isLocked = false,
    onToggleLock,
    isExternal = false,
    onImport,
    onClick,
    onDoubleClick,
    editable = false,
    onRename,
    dropIntent = null,
    dropIntentDepth,
    isIntoFrameHighlight = false,
    forwardedRef,
    dndListeners,
    style,
    className,
    ...rest
  }: TreeRowItemProps) => {
    const { t } = useTranslation();
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(label);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      setEditValue(label);
    }, [label]);

    const handleDoubleClick = (e: React.MouseEvent) => {
      if (isExternal) {
        e.stopPropagation();
        onImport?.();
        return;
      }
      if (editable) {
        e.stopPropagation();
        setEditValue(label);
        setIsEditing(true);
      }
      onDoubleClick?.(e);
    };

    const handleSave = () => {
      if (editValue.trim() && editValue !== label) {
        const result = onRename?.(editValue.trim());
        // Reset the local edit value to the persisted label whenever the
        // parent rejects the rename (sync `false` or resolved `false`).
        // The editor closes either way; the label prop will rerun the
        // `useEffect(setEditValue(label))` sync above on next render.
        if (result instanceof Promise) {
          void result.then((accepted) => {
            if (accepted === false) setEditValue(label);
          });
        } else if (result === false) {
          setEditValue(label);
        }
      }
      setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        setEditValue(label);
        setIsEditing(false);
      }
    };

    const handleToggleCollapse = (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleCollapse?.();
    };

    const handleToggleLock = (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleLock?.();
    };

    const handleImport = (e: React.MouseEvent) => {
      e.stopPropagation();
      onImport?.();
    };

    const bgColor = isSelected
      ? 'bg-info-bg'
      : isHighlighted
        ? 'bg-info-bg/50'
        : 'hover:bg-bg-default';

    const mergedStyle: React.CSSProperties = {
      ...style,
      paddingLeft: 8 + depth * 25,
      opacity: isDragging ? 0.3 : 1,
      zIndex: isDragging ? 999 : 'auto',
      position: 'relative',
    };

    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div
        ref={forwardedRef}
        style={mergedStyle}
        {...(!isEditing ? dndListeners : {})}
        onClick={onClick}
        onDoubleClick={handleDoubleClick}
        className={clsx(
          'bg-surface flex h-9 w-full cursor-pointer touch-none items-center gap-1 px-2 focus:outline-none focus-visible:outline-none',
          className,
        )}
        {...rest}
      >
        {/* Reorder caret — a single info-coloured line spanning the
            row width at the destination indent. The caret's left
            offset reflects `dropIntentDepth` (= the indent of a row
            at the destination depth), so a deeper drop site visually
            nests further inside its parent frame.

            `'into'` is intentionally NOT rendered as a caret — the
            destination frame's row gets a dashed `outline-info`
            highlight instead (see below) so the row itself reads as
            the drop target. */}
        {(dropIntent === 'before' || dropIntent === 'after') && (
          <span
            className={clsx(
              'pointer-events-none absolute right-2 z-10 h-0',
              dropIntent === 'before' ? 'top-0' : 'bottom-0',
            )}
            style={{ left: 8 + (dropIntentDepth ?? depth) * 25 }}
            aria-hidden
          >
            <span className="bg-info absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full" />
          </span>
        )}
        <div
          className={clsx(
            'group flex w-full items-center gap-1 rounded px-1 py-1 text-sm transition-colors',
            bgColor,
            // `'into'` / `isIntoFrameHighlight` paints the destination
            // frame's row with a soft `bg-info-bg` fill PLUS a dashed
            // `outline-info` border — bg makes it obvious at a glance,
            // outline gives the crisp frame-target affordance.
            //
            // - `bg-info-bg` (semantic token: light blue in light
            //   mode, blue tint in dark mode).
            // - `hover:bg-info-bg` explicitly overrides the default
            //   row's `hover:bg-bg-default` (a hover variant beats a
            //   base class on :hover regardless of `clsx` order).
            // - `outline` (not `border`) is drawn outside the box
            //   model so it doesn't shift the row's layout.
            //
            // Set when:
            //   1. `dropIntent === 'into'` (this row IS the
            //      destination frame, collapsed case).
            //   2. `isIntoFrameHighlight` (this row is the
            //      destination frame, expanded case where the caret
            //      shows at its bottom edge; OR this row is the
            //      parent frame for a sibling-insert between its
            //      existing children).
            (dropIntent === 'into' || isIntoFrameHighlight) &&
              'bg-info-bg hover:bg-info-bg outline-info outline-1 -outline-offset-1 outline-dashed',
          )}
        >
          {/* Chevron — always reserves space to keep sibling indentation stable */}
          <span className="flex h-2 w-2 shrink-0 items-center justify-center">
            {isCollapsible && (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                onClick={handleToggleCollapse}
                className="text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:!bg-transparent"
                aria-label={
                  isCollapsed ? t('actions.expand') : t('actions.collapse')
                }
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="!h-2.5 !w-2.5" />
                ) : (
                  <ChevronDown className="!h-2.5 !w-2.5" />
                )}
              </Button>
            )}
          </span>

          {/* Node type icon */}
          <span
            className={clsx(
              'pointer-events-none mr-1 flex shrink-0 items-center',
              isExternal ? 'text-fg-subtle' : 'text-fg-muted',
            )}
          >
            {icon}
          </span>

          {/* Label (editable or static) */}
          {isEditing ? (
            <input
              ref={inputRef}
              // Rename is entered deliberately; focus must follow.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="bg-surface h-6 w-full min-w-0 flex-1 rounded-sm border px-1 text-xs outline-none"
            />
          ) : (
            <span
              className={clsx(
                'truncate select-none',
                isExternal ? 'text-fg-subtle italic' : 'text-fg-default',
              )}
            >
              {label}
            </span>
          )}

          {/* Action buttons on the right */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {missingFileLabel && (
              <Tooltip content={missingFileLabel}>
                <span
                  role="img"
                  aria-label={missingFileLabel}
                  className="text-warning inline-flex"
                >
                  <FileWarning className="h-3.5 w-3.5" />
                </span>
              </Tooltip>
            )}
            {isExternal && onImport && (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                onClick={handleImport}
                className="hover:text-fg-default text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
                title={t('layers.addToCanvas')}
                aria-label={t('layers.addToCanvas')}
              >
                <Plus />
              </Button>
            )}
            {/* Lock button - always visible if locked, hover visible if unlocked */}
            {!isExternal && onToggleLock && (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                onClick={handleToggleLock}
                className={clsx(
                  'transition-opacity',
                  isLocked
                    ? 'text-fg-default opacity-100'
                    : 'hover:text-fg-default opacity-0 group-hover:opacity-100',
                )}
                aria-label={isLocked ? t('actions.unlock') : t('actions.lock')}
              >
                {isLocked ? <Lock /> : <Unlock />}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

TreeRowItem.displayName = 'TreeRowItem';
