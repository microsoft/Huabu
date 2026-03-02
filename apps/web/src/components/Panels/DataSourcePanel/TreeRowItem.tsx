import { ChevronDown, ChevronRight, Lock, Unlock } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

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
  onRename?: (newName: string) => void;

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
        onRename?.(editValue.trim());
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
      ? 'bg-theme-100'
      : isHighlighted
        ? 'bg-theme-50'
        : 'hover:bg-background';

    const mergedStyle: React.CSSProperties = {
      ...style,
      paddingLeft: 12 + depth * 16,
      opacity: isDragging ? 0.3 : 1,
      zIndex: isDragging ? 999 : 'auto',
      position: 'relative',
    };

    const iconSize = 12;
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
        className={`flex h-9 w-full cursor-pointer touch-none items-center gap-2 bg-white px-2 ${
          className || ''
        }`}
        {...rest}
      >
        <div
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${bgColor}`}
        >
          {/* Chevron icon for collapsible items (frames/groups) */}
          {isCollapsible && (
            <button
              onClick={handleToggleCollapse}
              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center transition-colors"
              aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight size={iconSize} strokeWidth={iconStroke} />
              ) : (
                <ChevronDown size={iconSize} strokeWidth={iconStroke} />
              )}
            </button>
          )}

          {/* Node type icon */}
          <span className="text-muted-foreground pointer-events-none flex shrink-0 items-center">
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
              className="h-6 w-full min-w-0 flex-1 rounded-sm border bg-white px-1 text-xs outline-none"
            />
          ) : (
            <span className="text-main truncate select-none">{label}</span>
          )}

          {/* Action buttons on the right */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* Lock button - always visible if locked, hover visible if unlocked */}
            {(isLocked || isHovered) && onToggleLock && (
              <button
                onClick={handleToggleLock}
                className={`flex items-center transition-colors ${
                  isLocked
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {isLocked ? (
                  <Lock size={iconSize} strokeWidth={iconStroke} />
                ) : (
                  <Unlock size={iconSize} strokeWidth={iconStroke} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

TreeRowItem.displayName = 'TreeRowItem';
