// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { Button, type ButtonProps } from './Button';
import { cn } from './cn';
import { Popover } from './Popover';

export interface SplitSelectOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  buttonLabel?: string;
  /**
   * Optional keyboard shortcut hint shown muted on the right side of the
   * option in the dropdown menu. Purely visual; the parent
   * is responsible for actually binding the key.
   */
  shortcut?: React.ReactNode;
}

type SplitSelectProps<T extends string = string> = {
  options: SplitSelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  onPrimaryAction?: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  menuClassName?: string;
  primaryButtonClassName?: string;
  menuButtonClassName?: string;
  hideMenuButton?: boolean;
  variant?: ButtonProps['variant'];
  tone?: ButtonProps['tone'];
  size?: ButtonProps['size'];
  shape?: ButtonProps['shape'];
  align?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  iconOnly?: boolean;
  primaryTitle?: string;
  menuTitle?: string;
  /**
   * Optional single-character keyboard hint rendered as a tiny subscript
   * in the bottom-right corner of the primary (left) button. Mirrors
   * `Button#shortcutBadge`.
   */
  primaryShortcutBadge?: React.ReactNode;
  /** Highlights `primaryShortcutBadge` in the accent color when `true`. */
  primaryShortcutBadgeActive?: boolean;
};

const splitShapeClasses: Record<NonNullable<ButtonProps['shape']>, string> = {
  default: 'rounded-md',
  pill: 'rounded-full',
};

const leftShapeClasses: Record<NonNullable<ButtonProps['shape']>, string> = {
  default: 'rounded-l-md rounded-r-none',
  pill: 'rounded-l-full rounded-r-none',
};

const rightShapeClasses: Record<NonNullable<ButtonProps['shape']>, string> = {
  default: 'rounded-l-none rounded-r-md',
  pill: 'rounded-l-none rounded-r-full',
};

const smallerButtonSize: Record<
  NonNullable<ButtonProps['size']>,
  ButtonProps['size']
> = {
  sm: 'sm',
  md: 'sm',
  lg: 'md',
};

export function SplitSelect<T extends string = string>({
  options,
  value,
  onChange,
  onPrimaryAction,
  disabled = false,
  placeholder = 'Select…',
  className,
  menuClassName,
  primaryButtonClassName,
  menuButtonClassName,
  hideMenuButton = false,
  variant = 'outline',
  tone = 'neutral',
  size = 'sm',
  shape = 'default',
  align = 'bottom-left',
  iconOnly = false,
  primaryTitle,
  menuTitle,
  primaryShortcutBadge,
  primaryShortcutBadgeActive,
}: SplitSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);
  const menuButtonSize = smallerButtonSize[size];
  const isSeparated = variant === 'ghost';

  const isRight = align === 'bottom-right' || align === 'top-right';
  const isTop = align === 'top-left' || align === 'top-right';
  const anchor =
    `${isTop ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as const;

  const current = options.find((option) => option.value === value);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    if (justDismissedRef.current) return;
    setIsOpen((prev) => !prev);
  }, [disabled]);

  const handleDismiss = useCallback(() => {
    justDismissedRef.current = true;
    setIsOpen(false);
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, []);

  const handlePrimaryAction = useCallback(() => {
    if (disabled || !current || !onPrimaryAction) return;
    onPrimaryAction(current.value);
  }, [current, disabled, onPrimaryAction]);

  const handleSelect = useCallback(
    (optionValue: T) => {
      onChange(optionValue);
      setIsOpen(false);
    },
    [onChange],
  );

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return { x: 0, y: 0 };
    const rect = triggerRef.current.getBoundingClientRect();
    return {
      x: isRight ? rect.right : rect.left,
      y: isTop ? rect.top : rect.bottom,
    };
  }, [isRight, isTop]);

  return (
    <>
      <div
        ref={triggerRef}
        role="group"
        className={cn(
          'inline-flex items-stretch',
          isSeparated && 'gap-px',
          splitShapeClasses[shape],
          className,
        )}
      >
        <Button
          variant={variant}
          tone={tone}
          size={size}
          shape={shape}
          disabled={disabled}
          onClick={handlePrimaryAction}
          title={primaryTitle}
          aria-label={
            iconOnly
              ? (primaryTitle ??
                current?.buttonLabel ??
                current?.label ??
                placeholder)
              : undefined
          }
          shortcutBadge={primaryShortcutBadge}
          shortcutBadgeActive={primaryShortcutBadgeActive}
          className={cn(
            isSeparated ? splitShapeClasses[shape] : leftShapeClasses[shape],
            !isSeparated && variant === 'outline' && 'border-r-0',
            iconOnly && 'gap-0 px-2',
            primaryButtonClassName,
          )}
        >
          {current?.icon}
          {!iconOnly && (
            <span>{current?.buttonLabel ?? current?.label ?? placeholder}</span>
          )}
        </Button>
        {!hideMenuButton && (
          <Button
            variant={variant}
            tone={tone}
            size={menuButtonSize}
            shape={shape}
            iconOnly
            disabled={disabled}
            onClick={handleToggle}
            title={menuTitle}
            aria-label={menuTitle ?? `${current?.label ?? placeholder} options`}
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            className={cn(
              isSeparated ? splitShapeClasses[shape] : rightShapeClasses[shape],
              isOpen && 'bg-bg-default',
              'px-0.5',
              menuButtonClassName,
            )}
          >
            <ChevronDown
              className={clsx('transition-transform', isOpen && 'rotate-180')}
            />
          </Button>
        )}
      </div>
      {isOpen && !hideMenuButton && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          anchor={anchor}
          offset={{ x: 0, y: isTop ? -4 : 4 }}
          className={cn('flex flex-col overflow-hidden py-1', menuClassName)}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <Button
                key={option.value}
                variant="ghost"
                tone="neutral"
                size={size}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(option.value)}
                className={cn(
                  'w-full justify-start rounded-none px-3 py-1.5 text-left',
                  isSelected ? 'text-info' : 'text-fg-muted',
                )}
              >
                {option.icon && <span className="shrink-0">{option.icon}</span>}
                <span className="flex-1">{option.label}</span>
                {option.shortcut !== null &&
                  option.shortcut !== undefined &&
                  option.shortcut !== '' && (
                    <span className="text-fg-subtle ml-3 shrink-0 text-xs font-medium">
                      {option.shortcut}
                    </span>
                  )}
              </Button>
            );
          })}
        </Popover>
      )}
    </>
  );
}
