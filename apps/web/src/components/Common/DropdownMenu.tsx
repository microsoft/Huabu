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
   * `"bottom-left"` (default) opens below aligned to left edge.
   * `"bottom-right"` opens below aligned to right edge.
   */
  align?: 'bottom-left' | 'bottom-right';
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
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);

  const handleToggle = useCallback(() => {
    if (justDismissedRef.current) return;
    setIsOpen((prev) => !prev);
  }, []);

  const handleDismiss = useCallback(() => {
    justDismissedRef.current = true;
    setIsOpen(false);
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, []);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      x: align === 'bottom-right' ? rect.right : rect.left,
      y: rect.bottom,
    };
  }, [align]);

  const clonedTrigger = cloneElement(trigger, {
    onClick: handleToggle,
    'aria-expanded': isOpen,
  });

  return (
    <>
      <div ref={triggerRef}>{clonedTrigger}</div>
      {isOpen && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          offset={offset ?? { x: 0, y: 4 }}
          className={cn('flex flex-col overflow-hidden py-1', className)}
        >
          {children}
        </Popover>
      )}
    </>
  );
};
