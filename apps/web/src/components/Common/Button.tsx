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
      'border border-transparent bg-inverse text-fg-inverse enabled:hover:bg-inverse/90',
    info: 'border border-transparent bg-info-bg text-info hover:bg-info-bg-hover',
    danger:
      'border border-transparent bg-danger text-fg-inverse hover:bg-danger/90',
  },
  outline: {
    neutral: 'border border-border bg-surface text-fg-muted hover:bg-hover',
    info: 'border border-border bg-surface text-info hover:bg-info-bg',
    danger: 'border border-border bg-surface text-danger hover:bg-danger-bg',
  },
  ghost: {
    neutral:
      'cursor-pointer border-none bg-transparent p-1 text-fg-muted enabled:hover:bg-bg-default',
    info: 'cursor-pointer border-none bg-transparent p-1 text-info enabled:hover:bg-info-bg',
    danger:
      'cursor-pointer border-none bg-transparent p-1 text-danger enabled:hover:bg-danger-bg',
  },
};

const shapeClasses: Record<ButtonShape, string> = {
  default: 'rounded-md font-medium',
  pill: 'gap-1 rounded-full px-3 py-1.5 text-xs font-medium',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

const iconSizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: '[&_svg]:h-3.5 [&_svg]:w-3.5',
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
    const hasSizeClass = shape !== 'pill';
    const iconSizeClass =
      shape === 'pill' ? '[&_svg]:h-3.5 [&_svg]:w-3.5' : iconSizeClasses[size];

    const buttonEl = (
      <button
        ref={ref}
        type={type}
        className={cn(
          'inline-flex items-center justify-center transition-colors',
          '[&_svg]:shrink-0',
          'disabled:cursor-not-allowed disabled:opacity-50',
          shapeClasses[shape],
          variantToneClasses[variant][tone],
          hasSizeClass && sizeClasses[size],
          iconSizeClass,
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
