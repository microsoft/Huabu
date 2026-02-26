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

    return (
      <div
        ref={forwardedRef}
        style={mergedStyle}
        {...dndAttributes}
        {...(!isEditing ? dndListeners : {})}
        onClick={onClick}
        onDoubleClick={handleDoubleClick}
        className={`flex h-9 w-full cursor-pointer touch-none items-center gap-2 bg-white px-2 ${
          className || ''
        }`}
        {...rest}
      >
        <div
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-sm transition-colors ${bgColor}`}
        >
          <span className="text-muted-foreground pointer-events-none flex shrink-0 items-center">
            {icon}
          </span>
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
        </div>
      </div>
    );
  },
);

TreeRowItem.displayName = 'TreeRowItem';
