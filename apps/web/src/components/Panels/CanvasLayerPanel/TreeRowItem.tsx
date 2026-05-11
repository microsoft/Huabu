import clsx from 'clsx';
import { ChevronDown, ChevronRight, Lock, Unlock } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { Button } from '../../Common/Button';

import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core';
import type { ReactNode } from 'react';

export interface TreeRowItemProps extends React.HTMLAttributes<HTMLDivElement> {
  depth: number;
  icon: ReactNode;
  label: string;

  // Visual states
  isSelected?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;

  // Frame/Group specific
  isCollapsible?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;

  // Lock state
  isLocked?: boolean;
  onToggleLock?: () => void;

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
  dndAttributes?: DraggableAttributes;
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
    isCollapsible = false,
    isCollapsed = false,
    onToggleCollapse,
    isLocked = false,
    onToggleLock,
    onClick,
    onDoubleClick,
    editable = false,
    onRename,
    forwardedRef,
    dndAttributes,
    dndListeners,
    style,
    className,
    ...rest
  }: TreeRowItemProps) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(label);
    const [isHovered, setIsHovered] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      setEditValue(label);
    }, [label]);

    const handleDoubleClick = (e: React.MouseEvent) => {
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

    const iconStroke = 1.5;

    return (
      <div
        ref={forwardedRef}
        style={mergedStyle}
        {...dndAttributes}
        {...(!isEditing ? dndListeners : {})}
        onClick={onClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={clsx(
          'bg-surface flex h-9 w-full cursor-pointer touch-none items-center gap-1 px-2',
          className,
        )}
        {...rest}
      >
        <div
          className={clsx(
            'flex w-full items-center gap-1 rounded px-1 py-1 text-sm transition-colors',
            bgColor,
          )}
        >
          {/* Chevron icon for collapsible items (frames/groups) */}
          {isCollapsible && (
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              onClick={handleToggleCollapse}
              className="shrink-0 hover:!bg-transparent"
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight strokeWidth={iconStroke} />
              ) : (
                <ChevronDown strokeWidth={iconStroke} />
              )}
            </Button>
          )}

          {/* Node type icon */}
          <span className="text-fg-subtle pointer-events-none flex shrink-0 items-center">
            {icon}
          </span>

          {/* Label (editable or static) */}
          {isEditing ? (
            <input
              ref={inputRef}
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
            <span className="text-fg-default truncate select-none">
              {label}
            </span>
          )}

          {/* Action buttons on the right */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* Lock button - always visible if locked, hover visible if unlocked */}
            {(isLocked || isHovered) && onToggleLock && (
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                onClick={handleToggleLock}
                className={clsx(
                  isLocked ? 'text-fg-default' : 'hover:text-fg-default',
                )}
                aria-label={isLocked ? 'Unlock' : 'Lock'}
              >
                {isLocked ? (
                  <Lock strokeWidth={iconStroke} />
                ) : (
                  <Unlock strokeWidth={iconStroke} />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

TreeRowItem.displayName = 'TreeRowItem';
