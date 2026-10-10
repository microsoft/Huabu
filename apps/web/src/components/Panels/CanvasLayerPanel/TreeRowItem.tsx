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

import {
  LAYER_ROW_ACTION_CLASS,
  LAYER_ROW_ICON_CLASS,
  LAYER_ROW_INSET_CLASS,
  LAYER_ROW_SELECTED_FOREGROUND_CLASS,
  LAYER_ROW_SURFACE_CLASS,
  layerRowBackground,
} from './layerRowStyles';
import { isKeyboardInteractiveTarget } from '../../../hooks/shortcuts/isKeyboardInteractiveTarget';
import { Button } from '../../Common/Button';
import { TextInput } from '../../Common/TextInput';
import { Tooltip } from '../../Common/Tooltip';

import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import type { ReactNode } from 'react';

const ROW_INSET_PX = 8;
const TREE_INDENT_PX = 20;

export interface TreeRowItemProps extends React.HTMLAttributes<HTMLDivElement> {
  depth: number;
  icon: ReactNode;
  label: string;

  // Visual states
  isSelected?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;
  isDragActive?: boolean;
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
   *   - `'into'` → NO caret. A collapsed Frame gets a solid info
   *     outline; an expanded Frame uses an indented insertion caret
   *     supplied as `'after'` by the drop resolver.
   *
   * `null` means no indicator. Set by `CanvasLayerTree` from its
   * `dnd-kit` `onDragOver` handler.
   */
  dropIntent?: 'before' | 'after' | 'into' | null;

  /**
   * Hierarchy depth the caret should anchor to — usually the depth of
   * the future parent's children at this slot. The caret's left offset
   * matches the content inset of a row at that depth. This makes it "live inside"
   * the destination frame: a deeper caret = nested deeper. When the
   * dragged node would land at top-level, pass `0`. Only meaningful
   * when `dropIntent` is `'before'` or `'after'`. Defaults to `depth`.
   */
  dropIntentDepth?: number;

  /**
   * Marks the destination parent. Only collapsed Frames draw a solid
   * outline; expanded Frames rely on their insertion caret.
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
    isDragActive = false,
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

    const bgColor = layerRowBackground({
      selected: isSelected,
      highlighted: isHighlighted,
      dragActive: isDragActive,
    });

    const mergedStyle: React.CSSProperties = {
      ...style,
      zIndex: isDragging ? 999 : 'auto',
      position: 'relative',
    };

    const canStartDrag = (target: EventTarget) =>
      !isEditing && !isExternal && !isKeyboardInteractiveTarget(target);

    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
      <div
        ref={forwardedRef}
        style={mergedStyle}
        data-layer-dragging={isDragging || undefined}
        onMouseDown={(event) => {
          if (canStartDrag(event.target)) {
            dndListeners?.onMouseDown?.(event);
          }
        }}
        onTouchStart={(event) => {
          if (canStartDrag(event.target)) {
            dndListeners?.onTouchStart?.(event);
          }
        }}
        onClick={onClick}
        onDoubleClick={handleDoubleClick}
        className={clsx(
          'group/layer-row bg-surface flex h-8.5 w-full items-center outline-none',
          LAYER_ROW_INSET_CLASS,
          isDragging ? 'cursor-grabbing' : 'cursor-pointer',
          className,
        )}
        {...rest}
      >
        {/* The caret follows the destination depth. Collapsed Frames use
            a solid outline instead; expanded Frames use this caret. */}
        {(dropIntent === 'before' || dropIntent === 'after') && (
          <span
            className={clsx(
              'pointer-events-none absolute right-2 z-10 h-0',
              dropIntent === 'before' ? 'top-0' : 'bottom-0',
            )}
            style={{
              left:
                ROW_INSET_PX * 2 + (dropIntentDepth ?? depth) * TREE_INDENT_PX,
            }}
            aria-hidden
          >
            <span className="bg-info absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full" />
          </span>
        )}
        <div
          style={{ paddingLeft: ROW_INSET_PX + depth * TREE_INDENT_PX }}
          className={clsx(
            'group group-focus-visible/layer-row:ring-info flex h-8 w-full min-w-0 items-center gap-2 px-2 text-sm font-normal group-focus-visible/layer-row:ring-2 group-focus-visible/layer-row:ring-inset',
            LAYER_ROW_SURFACE_CLASS,
            bgColor,
            isCollapsible &&
              isCollapsed &&
              (dropIntent === 'into' || isIntoFrameHighlight) &&
              'outline-info outline-1 -outline-offset-1 outline-solid',
          )}
        >
          {/* Chevron — always reserves space to keep sibling indentation stable */}
          <span className="flex h-6 w-4 shrink-0 items-center justify-center">
            {isCollapsible && (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                onClick={handleToggleCollapse}
                className="text-fg-subtle min-w-4 p-0! hover:bg-transparent!"
                aria-label={
                  isCollapsed ? t('actions.expand') : t('actions.collapse')
                }
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3! w-3!" />
                ) : (
                  <ChevronDown className="h-3! w-3!" />
                )}
              </Button>
            )}
          </span>

          {/* Node type icon */}
          <span
            className={clsx(
              'pointer-events-none flex shrink-0 items-center',
              isSelected && !isEditing
                ? LAYER_ROW_SELECTED_FOREGROUND_CLASS
                : LAYER_ROW_ICON_CLASS,
            )}
          >
            {icon}
          </span>

          {/* Label (editable or static) */}
          {isEditing ? (
            <TextInput
              ref={inputRef}
              name="layer-name"
              autoComplete="off"
              // Rename is entered deliberately; focus must follow.
              autoFocus
              aria-label={label}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="focus:border-info focus:ring-info/20 h-6 w-full min-w-0 flex-1 px-1 py-0 text-sm font-normal focus:ring-2"
            />
          ) : (
            <span
              className={clsx(
                'min-w-0 flex-1 truncate select-none',
                isSelected
                  ? LAYER_ROW_SELECTED_FOREGROUND_CLASS
                  : isExternal
                    ? 'text-fg-subtle italic'
                    : 'text-fg-default',
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
                className={LAYER_ROW_ACTION_CLASS}
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
                    : LAYER_ROW_ACTION_CLASS,
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
