import { cn } from './cn';
import { Tooltip } from './Tooltip';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonProps = {
  children: ReactNode;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'outline' | 'solid';
  className?: string;
  tooltipWrapperClassName?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

const variantClasses: Record<
  NonNullable<IconButtonProps['variant']>,
  string
> = {
  ghost:
    'cursor-pointer rounded border-none bg-transparent p-1 enabled:hover:bg-bg-default disabled:opacity-50 text-fg-muted',
  outline:
    'rounded-full border border-border text-fg-muted hover:bg-hover disabled:opacity-50',
  solid:
    'rounded-full bg-inverse text-fg-inverse hover:bg-inverse/90 disabled:opacity-40',
};

export const IconButton = ({
  children,
  size = 'md',
  variant = 'ghost',
  className,
  tooltipWrapperClassName,
  type = 'button',
  title,
  ...props
}: IconButtonProps) => {
  const sizeClass =
    variant !== 'ghost' ? (size === 'sm' ? 'h-6.5 w-6.5' : 'h-9 w-9') : '';

  const buttonEl = (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center',
        'disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClass,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );

  return title ? (
    <Tooltip content={title} wrapperClassName={tooltipWrapperClassName}>
      {buttonEl}
    </Tooltip>
  ) : (
    buttonEl
  );
};
