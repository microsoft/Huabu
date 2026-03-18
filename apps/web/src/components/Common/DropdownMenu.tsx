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
