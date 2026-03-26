import { clsx } from 'clsx';
import React from 'react';

import type { ShadCNComponents } from '@blocknote/shadcn';

type ButtonVariant =
  | 'default'
  | 'destructive'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'link';

type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

type BlockNoteButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
  destructive:
    'bg-destructive text-fg-inverse shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
  outline:
    'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
  secondary:
    'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
  ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
  link: 'text-primary underline-offset-4 hover:underline',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  default: 'h-9 px-4 py-2 has-[>svg]:px-3',
  sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
  lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
  icon: 'size-9',
};

export const BlockNoteShadcnButton = React.forwardRef<
  HTMLButtonElement,
  BlockNoteButtonProps
>(
  (
    { className, variant = 'default', size = 'default', asChild, ...props },
    ref,
  ) => {
    // NOTE: `asChild` is not supported here. BlockNote's internal usage doesn't rely on it.
    void asChild;

    return (
      <button
        ref={ref}
        type={props.type ?? 'button'}
        className={clsx(
          BUTTON_BASE,
          BUTTON_VARIANTS[variant],
          BUTTON_SIZES[size],
          className,
        )}
        {...props}
      />
    );
  },
);

BlockNoteShadcnButton.displayName = 'BlockNoteShadcnButton';

type ToggleVariant = 'default' | 'outline';
type ToggleSize = 'default' | 'sm' | 'lg';

type BlockNoteToggleProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ToggleVariant;
  size?: ToggleSize;
  pressed?: boolean;
  'data-state'?: string;
};

const TOGGLE_BASE =
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4 [&_svg]:shrink-0 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive whitespace-nowrap';

const TOGGLE_VARIANTS: Record<ToggleVariant, string> = {
  default: 'bg-transparent',
  outline:
    'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground',
};

const TOGGLE_SIZES: Record<ToggleSize, string> = {
  default: 'h-9 px-2 min-w-9',
  sm: 'h-8 px-1.5 min-w-8',
  lg: 'h-10 px-2.5 min-w-10',
};

export const BlockNoteShadcnToggle = React.forwardRef<
  HTMLButtonElement,
  BlockNoteToggleProps
>(
  (
    { className, variant = 'default', size = 'default', pressed, ...props },
    ref,
  ) => {
    const dataState =
      typeof props['data-state'] === 'string'
        ? props['data-state']
        : pressed
          ? 'on'
          : 'off';

    return (
      <button
        ref={ref}
        type={props.type ?? 'button'}
        aria-pressed={pressed}
        data-state={dataState}
        className={clsx(
          TOGGLE_BASE,
          TOGGLE_VARIANTS[variant],
          TOGGLE_SIZES[size],
          className,
        )}
        {...props}
      />
    );
  },
);

BlockNoteShadcnToggle.displayName = 'BlockNoteShadcnToggle';

export const blockNoteShadcnOverrides: Partial<ShadCNComponents> = {
  Button: {
    Button:
      BlockNoteShadcnButton as unknown as ShadCNComponents['Button']['Button'],
  },
  Toggle: {
    Toggle:
      BlockNoteShadcnToggle as unknown as ShadCNComponents['Toggle']['Toggle'],
  },
};
