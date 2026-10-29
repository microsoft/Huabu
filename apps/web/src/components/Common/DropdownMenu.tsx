// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronRight } from 'lucide-react';
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';

import { isEditableTarget } from '@/hooks/shortcuts/isEditableTarget';

import { Button } from './Button';
import { cn } from './cn';
import {
  MENU_HINT_CLASS,
  MENU_ICON_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SURFACE_CLASS,
} from './menuStyles';
import {
  Popover,
  type PopoverDismissReason,
  type PopoverProps,
} from './Popover';

import type { AriaAttributes, ButtonHTMLAttributes } from 'react';
import type { LinkProps } from 'react-router-dom';

function getMenuItems(menu: HTMLElement | null) {
  return Array.from(
    menu?.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    ) ?? [],
  ).filter(
    (item) =>
      item.closest('[role="menu"]') === menu &&
      !item.matches(':disabled, [aria-disabled="true"]') &&
      !item.closest('[hidden], [inert]'),
  );
}

function focusMenuEdge(menu: HTMLElement | null, edge: 'first' | 'last') {
  const items = getMenuItems(menu);
  const item = edge === 'last' ? items.at(-1) : items[0];
  (item ?? menu)?.focus({ preventScroll: true });
  item?.scrollIntoView({ block: 'nearest' });
}

// ─── DropdownMenuItem ─────────────────────────────────────────────────────────

type DropdownMenuItemProps = {
  icon?: ReactNode;
  children: ReactNode;
  /** Optional keyboard shortcut hint rendered on the right side. */
  shortcut?: string;
  /** Optional trailing affordance such as a submenu chevron. */
  trailing?: ReactNode;
  className?: string;
  role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'role'
>;

type DropdownMenuItemContentProps = Pick<
  DropdownMenuItemProps,
  'icon' | 'children' | 'shortcut' | 'trailing'
>;

const DropdownMenuItemContent: React.FC<DropdownMenuItemContentProps> = ({
  icon,
  children,
  shortcut,
  trailing,
}) => (
  <>
    {icon && <span className={MENU_ICON_CLASS}>{icon}</span>}
    <span className={MENU_LABEL_CLASS}>{children}</span>
    {shortcut && <span className={MENU_HINT_CLASS}>{shortcut}</span>}
    {trailing}
  </>
);

/**
 * A single item inside a `DropdownMenu`. Uses `Button` with ghost variant as its base.
 */
export const DropdownMenuItem: React.FC<DropdownMenuItemProps> = ({
  icon,
  children,
  shortcut,
  trailing,
  className,
  role = 'menuitem',
  ...props
}) => (
  <Button
    variant="ghost"
    tone="neutral"
    role={role}
    tabIndex={-1}
    className={cn(MENU_ITEM_CLASS, className)}
    {...props}
  >
    <DropdownMenuItemContent
      icon={icon}
      shortcut={shortcut}
      trailing={trailing}
    >
      {children}
    </DropdownMenuItemContent>
  </Button>
);

type DropdownMenuLinkProps = DropdownMenuItemContentProps &
  Omit<LinkProps, 'children' | 'className' | 'role'> & {
    className?: string;
  };

/**
 * A router link presented as a menu item. Native anchor semantics preserve
 * browser new-tab gestures while React Router handles an ordinary click.
 */
export const DropdownMenuLink: React.FC<DropdownMenuLinkProps> = ({
  icon,
  children,
  shortcut,
  trailing,
  className,
  ...props
}) => (
  <Link
    role="menuitem"
    tabIndex={-1}
    className={cn(
      MENU_ITEM_CLASS,
      'hover:bg-hover cursor-pointer border-none bg-transparent',
      className,
    )}
    {...props}
  >
    <DropdownMenuItemContent
      icon={icon}
      shortcut={shortcut}
      trailing={trailing}
    >
      {children}
    </DropdownMenuItemContent>
  </Link>
);

// ─── DropdownMenu (container) ─────────────────────────────────────────────────

type DropdownMenuProps = {
  'aria-label'?: string;
  'aria-describedby'?: string;
  floating?: boolean;
  placement?: PopoverProps['placement'];
  onOpenAutoFocus?: PopoverProps['onOpenAutoFocus'];
  /** Use dialog for form panels, or presentation when children own menu semantics and navigation. */
  contentRole?: 'menu' | 'dialog' | 'presentation';
  /** The trigger element (typically a `<Button>`). Receives onClick and aria-expanded. */
  trigger: ReactElement<{
    onClick?: (e: React.MouseEvent) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
    id?: string;
    'aria-haspopup'?: AriaAttributes['aria-haspopup'];
    'aria-controls'?: string;
    'aria-expanded'?: boolean;
    'aria-describedby'?: string;
  }>;
  /** Menu content — typically `<DropdownMenuItem>` elements and dividers. */
  children: ReactNode;
  /** Extra className(s) for the Popover panel. */
  className?: string;
  /** Offset from the trigger edge (px). Defaults to `{ x: 0, y: 4 }`. */
  offset?: Partial<{ x: number; y: number }>;
  /** Layout classes for the trigger wrapper, without changing menu styling. */
  triggerWrapperClassName?: string;
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
  'aria-label': label,
  'aria-describedby': describedBy,
  floating = false,
  placement,
  onOpenAutoFocus,
  contentRole = 'menu',
  trigger,
  children,
  className,
  offset,
  triggerWrapperClassName,
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
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const triggerId = trigger.props.id ?? `${id}-trigger`;
  const menuId = `${id}-menu`;
  const initialFocusRef = useRef<'first' | 'last'>('first');
  const justDismissedRef = useRef(false);
  const wasOpenRef = useRef(isOpen);
  const restoreFocusRef = useRef(true);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen) {
      restoreFocusRef.current = true;
    } else if (wasOpen && restoreFocusRef.current) {
      const frame = requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          document.getElementById(triggerId)?.focus({ preventScroll: true });
        }
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [isOpen, triggerId]);

  const handleToggle = useCallback(() => {
    if (justDismissedRef.current) return;
    initialFocusRef.current = 'first';
    setIsOpen((prev) => !prev);
  }, [setIsOpen]);

  const handleDismiss = useCallback(
    (reason: PopoverDismissReason) => {
      justDismissedRef.current = true;
      restoreFocusRef.current = reason === 'escape';
      setIsOpen(false);
      requestAnimationFrame(() => {
        justDismissedRef.current = false;
      });
    },
    [setIsOpen],
  );

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
    id: triggerId,
    'aria-haspopup':
      trigger.props['aria-haspopup'] ??
      (contentRole === 'presentation' ? undefined : contentRole),
    'aria-controls':
      trigger.props['aria-controls'] ?? (isOpen ? menuId : undefined),
    ...(describedBy
      ? {
          'aria-describedby': [trigger.props['aria-describedby'], describedBy]
            .filter(Boolean)
            .join(' '),
        }
      : {}),
    onClick: (event) => {
      if (typeof trigger.props.onClick === 'function') {
        trigger.props.onClick(event);
      }
      if (!event.defaultPrevented) {
        handleToggle();
      }
    },
    onKeyDown: (event) => {
      trigger.props.onKeyDown?.(event);
      if (
        event.defaultPrevented ||
        event.target !== event.currentTarget ||
        contentRole !== 'menu' ||
        (opensSideways
          ? event.key !== 'ArrowRight'
          : event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const edge = event.key === 'ArrowUp' ? 'last' : 'first';
      initialFocusRef.current = edge;
      if (isOpen) focusMenuEdge(menuRef.current, edge);
      else setIsOpen(true);
    },
    'aria-expanded': isOpen,
  });

  return (
    <>
      <div ref={triggerRef} className={triggerWrapperClassName}>
        {clonedTrigger}
      </div>
      {isOpen && (
        <Popover
          id={menuId}
          role={contentRole}
          aria-label={label}
          aria-labelledby={
            contentRole === 'presentation' || label ? undefined : triggerId
          }
          contentRef={menuRef}
          onOpenAutoFocus={() => {
            if (onOpenAutoFocus) onOpenAutoFocus();
            else if (contentRole === 'menu')
              focusMenuEdge(menuRef.current, initialFocusRef.current);
            else if (contentRole === 'dialog')
              menuRef.current
                ?.querySelector<HTMLElement>(
                  'input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
                )
                ?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (
              contentRole !== 'menu' ||
              event.defaultPrevented ||
              !(event.target instanceof Element) ||
              isEditableTarget(event.target)
            )
              return;
            if (event.key === 'Tab') {
              setIsOpen(false);
              document
                .getElementById(triggerId)
                ?.focus({ preventScroll: true });
              return;
            }
            if (event.target.closest('[role="menu"]') !== event.currentTarget)
              return;
            if (event.key === 'ArrowLeft' && opensSideways) {
              event.preventDefault();
              event.stopPropagation();
              handleDismiss('escape');
              return;
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.stopPropagation();
              return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            event.stopPropagation();
            const items = getMenuItems(menuRef.current);
            if (!items.length) return;
            const index = items.findIndex(
              (item) => item === document.activeElement,
            );
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : index < 0
                    ? event.key === 'ArrowUp'
                      ? items.length - 1
                      : 0
                    : (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        items.length) %
                      items.length;
            items[next]?.focus({ preventScroll: true });
            items[next]?.scrollIntoView({ block: 'nearest' });
          }}
          reference={floating ? triggerRef.current : undefined}
          owner={triggerRef.current}
          placement={placement ?? (isRight ? 'bottom-end' : 'bottom-start')}
          position={computePosition()}
          onDismiss={handleDismiss}
          anchor={anchor}
          offset={
            offset ??
            (opensSideways ? { x: 0, y: 0 } : { x: 0, y: isTop ? -4 : 4 })
          }
          className={cn(
            MENU_SURFACE_CLASS,
            'flex w-max flex-col overflow-hidden',
            className,
          )}
        >
          {contentRole === 'menu' ? (
            // Keep nested portals outside the scrolling list.
            <div className="max-h-[max(0px,calc(var(--popover-available-height,calc(100dvh-24px))-10px))] overflow-y-auto overscroll-contain">
              {children}
            </div>
          ) : (
            children
          )}
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
  const keyboardOpenRef = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      if (!contentRef.current?.contains(document.activeElement)) setOpen(false);
    }, 120);
  }, [cancelClose]);

  const openSubmenu = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  return (
    <div
      onPointerEnter={() => {
        keyboardOpenRef.current = false;
        openSubmenu();
      }}
      onPointerLeave={scheduleClose}
    >
      <DropdownMenu
        floating
        placement="right-start"
        open={open}
        onOpenChange={setOpen}
        align="right-top"
        onOpenAutoFocus={keyboardOpenRef.current ? undefined : () => undefined}
        className={className}
        trigger={
          <DropdownMenuItem
            aria-haspopup="menu"
            trailing={
              <ChevronRight
                aria-hidden="true"
                size={14}
                className="text-fg-subtle ml-2 shrink-0"
              />
            }
            onKeyDown={(event) => {
              if (['ArrowRight', 'Enter', ' '].includes(event.key))
                keyboardOpenRef.current = true;
            }}
            onClick={(event) => {
              event.preventDefault();
              keyboardOpenRef.current = true;
              openSubmenu();
              if (open) {
                focusMenuEdge(
                  contentRef.current?.closest<HTMLElement>('[role="menu"]') ??
                    null,
                  'first',
                );
              }
            }}
          >
            {label}
          </DropdownMenuItem>
        }
      >
        <div
          ref={contentRef}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        >
          {children}
        </div>
      </DropdownMenu>
    </div>
  );
};
