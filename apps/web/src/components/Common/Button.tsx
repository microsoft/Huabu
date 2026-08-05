// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { forwardRef } from 'react';

import { cn } from './cn';
import { Tooltip, type TooltipPlacement } from './Tooltip';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'solid' | 'outline' | 'ghost';
type ButtonShape = 'default' | 'pill';
/**
 * Semantic color family shared across surface components (e.g. `Button`,
 * `Toast`) so a container's tone can map 1:1 onto an inner button's
 * tone. Standardized vocabulary: `neutral | info | success | warning |
 * danger`.
 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type ButtonProps = {
  children: ReactNode;
  variant?: ButtonVariant;
  shape?: ButtonShape;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  iconOnly?: boolean;
  className?: string;
  tooltipWrapperClassName?: string;
  /**
   * Preferred placement for the tooltip rendered when `title` is set.
   * Defaults to `'auto'` (start on top, flip to bottom when there is no
   * room) — same as `<Tooltip>` itself. Pass `'bottom'` for buttons
   * that live at the top edge of the window (e.g. the custom title bar
   * on Electron) where there is no room above to render the tooltip.
   */
  tooltipPlacement?: TooltipPlacement;
  /**
   * Optional single-character keyboard hint rendered as a tiny subscript
   * in the button's bottom-right corner.
   * Purely cosmetic — the caller is responsible for wiring the actual
   * keyboard listener.
   */
  shortcutBadge?: ReactNode;
  /**
   * When `true`, the shortcut badge is rendered in the brand accent
   * color to signal that the associated tool is currently active.
   */
  shortcutBadgeActive?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>;

const variantToneClasses: Record<ButtonVariant, Record<Tone, string>> = {
  solid: {
    neutral:
      'border border-transparent bg-inverse text-fg-inverse enabled:hover:bg-inverse/80',
    info: 'border border-transparent bg-info text-fg-inverse enabled:hover:bg-info/80',
    success:
      'border border-transparent bg-success text-fg-inverse enabled:hover:bg-success/80',
    warning:
      'border border-transparent bg-warning text-fg-inverse enabled:hover:bg-warning/80',
    danger:
      'border border-transparent bg-danger text-fg-inverse enabled:hover:bg-danger/80',
  },
  outline: {
    neutral:
      'border border-edge-default bg-surface text-fg-muted enabled:hover:bg-hover',
    info: 'border border-info bg-surface text-info enabled:hover:bg-info-bg',
    success:
      'border border-success bg-surface text-success enabled:hover:bg-success-bg',
    warning:
      'border border-warning bg-surface text-warning enabled:hover:bg-warning-bg',
    danger:
      'border border-danger bg-surface text-danger enabled:hover:bg-danger-bg',
  },
  ghost: {
    neutral:
      'cursor-pointer border-none bg-transparent text-fg-muted enabled:hover:bg-hover',
    info: 'cursor-pointer border-none bg-transparent text-info enabled:hover:bg-info-bg',
    success:
      'cursor-pointer border-none bg-transparent text-success enabled:hover:bg-success-bg',
    warning:
      'cursor-pointer border-none bg-transparent text-warning enabled:hover:bg-warning-bg',
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
  lg: 'px-4 py-2.5 text-base gap-2 font-medium',
};

const iconSizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: '[&_svg]:h-3.25 [&_svg]:w-3.25',
  md: '[&_svg]:h-4 [&_svg]:w-4',
  lg: '[&_svg]:h-5 [&_svg]:w-5',
};

const iconOnlySizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'min-h-6 min-w-6 p-1',
  md: 'p-1.5',
  lg: 'p-2',
};

/**
 * When a corner `shortcutBadge` is present, asymmetric padding shifts the
 * icon up-left so the badge sits in a clear bottom-right corner instead
 * of colliding with the icon's pixels. Total button size is preserved:
 * we just trade padding between top/left and bottom/right.
 */
const iconOnlyBadgeShiftClasses: Record<
  NonNullable<ButtonProps['size']>,
  string
> = {
  sm: 'pt-0.5 pl-0.5 pr-1.5 pb-1.5',
  md: 'pt-1 pl-1 pr-2 pb-2',
  lg: 'pt-1.5 pl-1.5 pr-2.5 pb-2.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'solid',
      shape = 'default',
      tone = 'neutral',
      size = 'md',
      iconOnly,
      className,
      tooltipWrapperClassName,
      tooltipPlacement,
      type = 'button',
      title,
      'aria-label': ariaLabel,
      shortcutBadge,
      shortcutBadgeActive,
      ...props
    },
    ref,
  ) => {
    const buttonEl = (
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel ?? (iconOnly ? title : undefined)}
        className={cn(
          'flex items-center justify-center transition-colors',
          '[&_svg]:shrink-0',
          'disabled:cursor-not-allowed disabled:opacity-50',
          shapeClasses[shape],
          variantToneClasses[variant][tone],
          iconOnly ? iconOnlySizeClasses[size] : sizeClasses[size],
          iconSizeClasses[size],
          shortcutBadge != null && 'relative',
          shortcutBadge != null && iconOnly && iconOnlyBadgeShiftClasses[size],
          className,
        )}
        {...props}
      >
        {children}
        {shortcutBadge != null && (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute right-1 bottom-0.5 select-none',
              'text-[9px] leading-none font-medium',
              shortcutBadgeActive ? 'text-info' : 'text-fg-subtle',
            )}
          >
            {shortcutBadge}
          </span>
        )}
      </button>
    );

    return title ? (
      <Tooltip
        content={title}
        wrapperClassName={tooltipWrapperClassName}
        placement={tooltipPlacement}
      >
        {buttonEl}
      </Tooltip>
    ) : (
      buttonEl
    );
  },
);

Button.displayName = 'Button';
