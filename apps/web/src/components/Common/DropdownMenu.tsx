import {
  cloneElement,
  useCallback,
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
    tone="neutral"
    role="menuitem"
    className={cn(
      'text-fg-muted w-full justify-start gap-3 rounded-none px-4 py-2 text-sm',
      className,
    )}
    {...props}
  >
    {icon && <span className="text-fg-subtle shrink-0">{icon}</span>}
    <span className="flex-1 text-left">{children}</span>
    {shortcut && (
      <span className="text-fg-subtle ml-4 shrink-0 text-xs">{shortcut}</span>
    )}
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
   */
  align?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
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

  const isRight = align === 'bottom-right' || align === 'top-right';
  const isTop = align === 'top-left' || align === 'top-right';

  // Map DropdownMenu align → Popover anchor (vertical direction inverts)
  const anchor =
    `${isTop ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as const;

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      x: isRight ? rect.right : rect.left,
      y: isTop ? rect.top : rect.bottom,
    };
  }, [isRight, isTop]);

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
          offset={offset ?? { x: 0, y: isTop ? -4 : 4 }}
          className={cn('flex flex-col overflow-hidden py-1', className)}
        >
          {children}
        </Popover>
      )}
    </>
  );
};
