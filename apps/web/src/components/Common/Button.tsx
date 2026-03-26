import { forwardRef } from 'react';

import { cn } from './cn';
import { Tooltip } from './Tooltip';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonProps = {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'pill';
  size?: 'sm' | 'md';
  className?: string;
  tooltipWrapperClassName?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'rounded-md font-medium bg-info-bg text-info hover:bg-info-bg-hover border border-transparent',
  secondary:
    'rounded-md font-medium border border-border text-muted-foreground bg-card hover:bg-hover-subtle',
  danger:
    'rounded-md font-medium bg-destructive text-surface-invert-foreground hover:bg-destructive/90 border border-transparent',
  ghost:
    'cursor-pointer rounded border-none bg-transparent p-1 enabled:hover:bg-background',
  pill: 'gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-hover-subtle',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'primary',
      size = 'md',
      className,
      tooltipWrapperClassName,
      type = 'button',
      title,
      ...props
    },
    ref,
  ) => {
    const hasSizeClass = variant !== 'ghost' && variant !== 'pill';

    const buttonEl = (
      <button
        ref={ref}
        type={type}
        className={cn(
          'inline-flex items-center justify-center transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
          variantClasses[variant],
          hasSizeClass && sizeClasses[size],
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
  },
);

Button.displayName = 'Button';
