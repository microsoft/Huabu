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
    'cursor-pointer rounded border-none bg-transparent p-1 enabled:hover:bg-background disabled:opacity-50',
  outline:
    'rounded-full border border-border text-gray-600 hover:bg-gray-50 disabled:opacity-50',
  solid:
    'rounded-full bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40',
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
