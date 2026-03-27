import { forwardRef } from 'react';

import { cn } from './cn';
import { Tooltip } from './Tooltip';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'solid' | 'outline' | 'ghost';
type ButtonShape = 'default' | 'pill';
type ButtonTone = 'neutral' | 'info' | 'danger';

export type ButtonProps = {
  children: ReactNode;
  variant?: ButtonVariant;
  shape?: ButtonShape;
  tone?: ButtonTone;
  size?: 'sm' | 'md';
  className?: string;
  tooltipWrapperClassName?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

const variantToneClasses: Record<ButtonVariant, Record<ButtonTone, string>> = {
  solid: {
    neutral:
      'border border-transparent bg-inverse text-fg-inverse enabled:hover:bg-inverse/80',
    info: 'border border-transparent bg-info text-fg-inverse enabled:hover:bg-info/80',
    danger:
      'border border-transparent bg-danger text-fg-inverse enabled:hover:bg-danger/80',
  },
  outline: {
    neutral:
      'border border-border bg-surface text-fg-muted enabled:hover:bg-hover',
    info: 'border border-info-light bg-surface text-info enabled:hover:bg-info-bg',
    danger:
      'border border-danger-light bg-surface text-danger enabled:hover:bg-danger-bg',
  },
  ghost: {
    neutral:
      'cursor-pointer border-none bg-transparent text-fg-muted enabled:hover:bg-hover',
    info: 'cursor-pointer border-none bg-transparent text-info enabled:hover:bg-info-bg',
    danger:
      'cursor-pointer border-none bg-transparent text-danger enabled:hover:bg-danger-bg',
  },
};

const shapeClasses: Record<ButtonShape, string> = {
  default: 'rounded-md',
  pill: 'rounded-full',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2.5 py-1 text-xs gap-1.5',
  md: 'px-3 py-2 text-sm gap-2 font-medium',
};

const iconSizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: '[&_svg]:h-3.25 [&_svg]:w-3.25',
  md: '[&_svg]:h-4 [&_svg]:w-4',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'solid',
      shape = 'default',
      tone = 'neutral',
      size = 'md',
      className,
      tooltipWrapperClassName,
      type = 'button',
      title,
      ...props
    },
    ref,
  ) => {
    const buttonEl = (
      <button
        ref={ref}
        type={type}
        className={cn(
          'flex items-center justify-center transition-colors',
          '[&_svg]:shrink-0',
          'disabled:cursor-not-allowed disabled:opacity-50',
          shapeClasses[shape],
          variantToneClasses[variant][tone],
          sizeClasses[size],
          iconSizeClasses[size],
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
