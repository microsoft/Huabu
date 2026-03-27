import { Button } from './Button';
import { cn } from './cn';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

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
