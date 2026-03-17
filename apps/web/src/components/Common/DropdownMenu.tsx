import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Button } from './Button';
import { cn } from './cn';

import type { ButtonHTMLAttributes, ReactNode, RefObject } from 'react';

// ─── DropdownMenu ────────────────────────────────────────────────────────────

type DropdownMenuProps = {
  /** Ref of the element used to anchor the menu position. */
  triggerRef: RefObject<HTMLElement>;
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Vertical gap (px) between the trigger bottom and the menu top. */
  offset?: number;
  /** Minimum width (px) of the menu. Defaults to max-content. */
  minWidth?: number;
};

/**
 * Portal-based dropdown menu anchored below a trigger element.
 * Handles outside-click dismissal internally via `onClose`.
 */
export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  triggerRef,
  isOpen,
  onClose,
  children,
  offset = 4,
  minWidth,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (
        menuRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  const getStyle = (): React.CSSProperties => {
    if (!triggerRef.current) return {};
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      position: 'fixed',
      top: rect.bottom + offset,
      left: rect.left,
      zIndex: 9999,
      width: 'max-content',
      ...(minWidth !== undefined && { minWidth }),
    };
  };

  return createPortal(
    <div
      ref={menuRef}
      style={getStyle()}
      role="menu"
      className="flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-xl"
    >
      {children}
    </div>,
    document.body,
  );
};

// ─── DropdownMenuItem ─────────────────────────────────────────────────────────

type DropdownMenuItemProps = {
  icon?: ReactNode;
  children: ReactNode;
  /** Optional keyboard shortcut hint rendered on the right side. */
  shortcut?: string;
  className?: string;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'role'
>;

/**
 * A single item inside a `DropdownMenu`. Uses `Button` with ghost variant as its base.
 */
export const DropdownMenuItem: React.FC<DropdownMenuItemProps> = ({
  icon,
  children,
  shortcut,
  className,
  ...props
}) => (
  <Button
    variant="ghost"
    role="menuitem"
    className={cn(
      'w-full justify-start gap-3 rounded-none px-4 py-2 text-sm text-gray-700',
      className,
    )}
    {...props}
  >
    {icon && <span className="shrink-0 text-gray-400">{icon}</span>}
    <span className="flex-1 text-left">{children}</span>
    {shortcut && (
      <span className="ml-4 shrink-0 text-xs text-gray-400">{shortcut}</span>
    )}
  </Button>
);
