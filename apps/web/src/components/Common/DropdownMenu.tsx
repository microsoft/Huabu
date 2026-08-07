// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronRight } from 'lucide-react';
import {
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Button } from './Button';
import { cn } from './cn';
import { Popover } from './Popover';

import type { ButtonHTMLAttributes } from 'react';

// ─── DropdownMenuItem ─────────────────────────────────────────────────────────

type DropdownMenuItemProps = {
  icon?: ReactNode;
  children: ReactNode;
  /** Optional keyboard shortcut hint rendered on the right side. */
  shortcut?: string;
  /** Optional trailing affordance such as a submenu chevron. */
  trailing?: ReactNode;
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
  trailing,
  className,
  ...props
}) => (
  <Button
    variant="ghost"
    tone="neutral"
    role="menuitem"
    className={cn(
      'text-fg-muted w-full justify-start gap-2 rounded-none px-3 py-1.5 text-xs',
      className,
    )}
    {...props}
  >
    {icon && <span className="text-fg-subtle shrink-0">{icon}</span>}
    <span className="flex-1 text-left">{children}</span>
    {shortcut && (
      <span className="text-fg-subtle ml-4 shrink-0 text-xs">{shortcut}</span>
    )}
    {trailing}
  </Button>
);

// ─── DropdownMenu (container) ─────────────────────────────────────────────────

type DropdownMenuProps = {
  /** The trigger element (typically a `<Button>`). Receives onClick and aria-expanded. */
  trigger: ReactElement<{
    onClick?: (e: React.MouseEvent) => void;
    'aria-expanded'?: boolean;
  }>;
  /** Menu content — typically `<DropdownMenuItem>` elements and dividers. */
  children: ReactNode;
  /** Extra className(s) for the Popover panel. */
  className?: string;
  /** Offset from the trigger edge (px). Defaults to `{ x: 0, y: 4 }`. */
  offset?: Partial<{ x: number; y: number }>;
  /**
   * Which edge of the trigger to align the panel to.
   * `"bottom-left"` (default) opens below, left-aligned.
   * `"bottom-right"` opens below, right-aligned.
   * `"top-left"` opens above, left-aligned.
   * `"top-right"` opens above, right-aligned.
   * `"right-top"` opens to the right, top-aligned.
   * `"left-top"` opens to the left, top-aligned.
   */
  align?:
    | 'bottom-left'
    | 'bottom-right'
    | 'top-left'
    | 'top-right'
    | 'right-top'
    | 'left-top';
  /** Controlled open state. When provided, the component becomes controlled. */
  open?: boolean;
  /** Called when the open state changes (controlled mode). */
  onOpenChange?: (open: boolean) => void;
};

/**
 * DropdownMenu — container that composes a trigger button with a
 * `Popover`-based menu panel. Handles open/close state, outside-click
 * dismiss, Escape dismiss, and the re-open guard (`justDismissedRef`).
 *
 * Usage:
 * ```tsx
 * <DropdownMenu trigger={<Button variant="ghost" iconOnly><MoreHorizontal /></Button>}>
 *   <DropdownMenuItem icon={<Edit size={14} />}>Edit</DropdownMenuItem>
 *   <DropdownMenuItem icon={<Trash size={14} />}>Delete</DropdownMenuItem>
 * </DropdownMenu>
 * ```
 */
export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  trigger,
  children,
  className,
  offset,
  align = 'bottom-left',
  open: controlledOpen,
  onOpenChange,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const setIsOpen = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof value === 'function' ? value(isOpen) : value;
      if (isControlled) {
        onOpenChange?.(next);
      } else {
        setUncontrolledOpen(next);
      }
    },
    [isControlled, isOpen, onOpenChange],
  );
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);

  const handleToggle = useCallback(() => {
    if (justDismissedRef.current) return;
    setIsOpen((prev) => !prev);
  }, [setIsOpen]);

  const handleDismiss = useCallback(() => {
    justDismissedRef.current = true;
    setIsOpen(false);
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, [setIsOpen]);

  const opensSideways = align === 'right-top' || align === 'left-top';
  const isRight = align === 'bottom-right' || align === 'top-right';
  const isTop = align === 'top-left' || align === 'top-right';

  // Map DropdownMenu align → Popover anchor (vertical direction inverts)
  const anchor = opensSideways
    ? align === 'right-top'
      ? ('top-left' as const)
      : ('top-right' as const)
    : (`${isTop ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as const);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    if (opensSideways) {
      return {
        x: align === 'right-top' ? rect.right : rect.left,
        y: rect.top,
      };
    }
    return {
      x: isRight ? rect.right : rect.left,
      y: isTop ? rect.top : rect.bottom,
    };
  }, [align, isRight, isTop, opensSideways]);

  const clonedTrigger = cloneElement(trigger, {
    onClick: (event) => {
      if (typeof trigger.props.onClick === 'function') {
        trigger.props.onClick(event);
      }
      if (!event.defaultPrevented) {
        handleToggle();
      }
    },
    'aria-expanded': isOpen,
  });

  return (
    <>
      <div ref={triggerRef}>{clonedTrigger}</div>
      {isOpen && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          anchor={anchor}
          offset={
            offset ??
            (opensSideways ? { x: 0, y: 0 } : { x: 0, y: isTop ? -4 : 4 })
          }
          className={cn('flex flex-col overflow-hidden py-1', className)}
        >
          {children}
        </Popover>
      )}
    </>
  );
};

type DropdownMenuSubmenuProps = {
  label: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * A desktop-style nested menu that opens beside its parent item. It supports
 * click, hover, and ArrowRight keyboard activation while composing the same
 * `DropdownMenu` and `DropdownMenuItem` primitives as a top-level menu.
 */
export const DropdownMenuSubmenu: React.FC<DropdownMenuSubmenuProps> = ({
  label,
  children,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 120);
  }, [cancelClose]);

  const openSubmenu = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  return (
    <div onPointerEnter={openSubmenu} onPointerLeave={scheduleClose}>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        align="right-top"
        className={cn('min-w-44', className)}
        trigger={
          <DropdownMenuItem
            aria-haspopup="menu"
            trailing={
              <ChevronRight
                aria-hidden="true"
                size={14}
                className="text-fg-subtle ml-4 shrink-0"
              />
            }
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                openSubmenu();
              }
            }}
          >
            {label}
          </DropdownMenuItem>
        }
      >
        <div onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
          {children}
        </div>
      </DropdownMenu>
    </div>
  );
};
