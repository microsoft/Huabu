// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import clsx from 'clsx';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';

import { Button, type ButtonProps } from './Button';
import { cn } from './cn';
import {
  MENU_CHECK_CLASS,
  MENU_GROUP_CLASS,
  MENU_ICON_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_SECTION_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SURFACE_CLASS,
} from './menuStyles';
import { Popover } from './Popover';
import { textInputClassName } from './TextInput';
import { Tooltip } from './Tooltip';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  description?: string;
  /**
   * When set, a left-aligned section header is rendered
   * in the dropdown panel immediately ABOVE this option. Used to group
   * related entries. Has no effect on selection
   * behaviour or the trigger label.
   */
  sectionLabel?: string;
  /** Render a separator immediately before this option's section or row. */
  separatorBefore?: boolean;
  /**
   * When true, the option is rendered greyed out and cannot be selected.
   * Useful for placeholder states like "no agents connected".
   */
  disabled?: boolean;
}

type SelectProps<T extends string = string> = {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Placeholder shown when value is empty. */
  placeholder?: string;
  /** Extra className on the trigger button. */
  className?: string;
  /** Optional styling for the option panel, independent of the trigger. */
  menuClassName?: string;
  /** Tooltip text wrapped around the trigger button via `Button`'s `title`. */
  title?: string;
  /** Accessible name when the visual row label is not a native label. */
  ariaLabel?: string;
  'aria-describedby'?: string;
  /** Trigger button props forwarded to `<Button>`. Defaults to outline/neutral/sm. */
  variant?: ButtonProps['variant'];
  tone?: ButtonProps['tone'];
  size?: ButtonProps['size'];
  shape?: ButtonProps['shape'];
  /** Field appearance matches text inputs; default preserves the compact trigger. */
  appearance?: 'default' | 'field';
  /**
   * Which edge of the trigger to align the panel to.
   * `"bottom-left"` (default) opens below, left-aligned.
   * `"bottom-right"` opens below, right-aligned.
   * `"top-left"` opens above, left-aligned.
   * `"top-right"` opens above, right-aligned.
   */
  align?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  /**
   * When true, the trigger button only shows the current option's icon
   * (plus the appearance's indicator). The label text in the dropdown is unaffected.
   */
  iconOnly?: boolean;
  /**
   * Fired exactly when the dropdown transitions from closed → open
   * (clicking the trigger while open closes it and does NOT fire this).
   * Use this to lazily refresh dynamic option lists instead of polling.
   */
  onOpen?: () => void;
  /**
   * Optional node rendered at the bottom of the dropdown panel,
   * separated from the options by a thin divider. Use for things like
   * a manual "Refresh" button or a link to a configure dialog.
   * Receives `dismiss` so the slot's controls can close the panel
   * after they fire (e.g. "Refresh" should leave the dropdown open,
   * "Manage agents…" probably wants to close it before opening a modal).
   */
  footerSlot?: ReactNode | ((ctx: { dismiss: () => void }) => ReactNode);
};

const selectShapeClasses: Record<NonNullable<ButtonProps['shape']>, string> = {
  default: 'rounded',
  pill: 'rounded-full',
};

// ─── Select ───────────────────────────────────────────────────────────────────

/**
 * Select — a custom select control that renders a `Button` trigger
 * and a `Popover`-based option panel. Replaces native `<select>` elements
 * and hand-rolled select patterns.
 *
 * Usage:
 * ```tsx
 * <Select
 *   options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
 *   value={selected}
 *   onChange={setSelected}
 * />
 * ```
 */
export function Select<T extends string = string>({
  options,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select…',
  className,
  menuClassName,
  title,
  ariaLabel,
  'aria-describedby': ariaDescribedBy,
  variant = 'outline',
  tone = 'neutral',
  size = 'sm',
  shape = 'default',
  appearance = 'default',
  align = 'bottom-left',
  iconOnly = false,
  onOpen,
  footerSlot,
}: SelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState<number | undefined>(
    undefined,
  );
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);

  const isRight = align === 'bottom-right' || align === 'top-right';
  const isTop = align === 'top-left' || align === 'top-right';

  const placement =
    `${isTop ? 'top' : 'bottom'}-${isRight ? 'end' : 'start'}` as const;

  const current = options.find((o) => o.value === value);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    if (justDismissedRef.current) return;
    if (!isOpen) {
      if (triggerRef.current) {
        setTriggerWidth(triggerRef.current.getBoundingClientRect().width);
      }
      onOpen?.();
    }
    setIsOpen(!isOpen);
  }, [disabled, isOpen, onOpen]);

  const handleDismiss = useCallback(() => {
    if (menuRef.current?.contains(document.activeElement)) {
      triggerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
    justDismissedRef.current = true;
    setIsOpen(false);
    requestAnimationFrame(() => {
      justDismissedRef.current = false;
    });
  }, []);

  const handleSelect = useCallback(
    (optionValue: T) => {
      onChange(optionValue);
      setIsOpen(false);
      triggerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    },
    [onChange],
  );

  return (
    <>
      <div ref={triggerRef} className="flex min-w-0 shrink">
        <Button
          variant={variant}
          tone={tone}
          size={appearance === 'field' ? 'field' : size}
          shape={shape}
          disabled={disabled}
          onClick={handleToggle}
          aria-expanded={isOpen}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          title={title}
          tooltipWrapperClassName="flex min-w-0 shrink"
          className={cn(
            selectShapeClasses[shape],
            isOpen && 'bg-bg-default',
            iconOnly ? 'gap-0.5 px-1' : 'w-full min-w-0 overflow-hidden',
            appearance === 'field' &&
              textInputClassName({
                size: 'field',
                className:
                  '[&>svg:last-child]:text-fg-subtle justify-between text-left',
              }),
            className,
          )}
        >
          {current?.icon}
          {!iconOnly && (
            <span className="min-w-0 truncate">
              {current?.label ?? placeholder}
            </span>
          )}
          {appearance === 'field' ? (
            <ChevronsUpDown aria-hidden />
          ) : (
            <ChevronDown
              aria-hidden
              className={clsx('transition-transform', isOpen && 'rotate-180')}
            />
          )}
        </Button>
      </div>
      {isOpen && (
        <Popover
          contentRef={menuRef}
          reference={triggerRef.current}
          placement={placement}
          onDismiss={handleDismiss}
          // Match the panel's minimum width to the trigger so a
          // full-width trigger (`w-full`) gets a dropdown of the same
          // width instead of one that shrinks to its longest option.
          // The `max-w-*` cap below still lets long descriptions grow
          // the panel up to the ceiling.
          style={
            triggerWidth
              ? {
                  minWidth: `min(${triggerWidth}px, 24rem, var(--popover-available-width, calc(100vw - 24px)))`,
                }
              : undefined
          }
          // Cap panel width so long descriptions truncate instead of
          // pushing the dropdown wider than the parent column (e.g.
          // ChatPanel). 24rem leaves room for a useful description
          // prefix while still fitting inside the default chat panel;
          // the `min(…, 100vw-1rem)` guard keeps it on-screen at narrow
          // widths. The `max-h` cap (paired with the inner scroll
          // region below) keeps the panel inside the viewport when the
          // option list is longer than the available space, so the
          // bottom rows remain reachable via scroll instead of being
          // clipped off-screen.
          className={cn(
            MENU_SURFACE_CLASS,
            'flex max-h-[min(28rem,calc(100vh-1.5rem))] w-max max-w-[min(24rem,var(--popover-available-width,calc(100vw-24px)))] flex-col overflow-hidden',
            menuClassName,
          )}
        >
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            {options.map((option) => (
              <Fragment key={option.value}>
                {option.separatorBefore && (
                  <div role="separator" className={MENU_SEPARATOR_CLASS} />
                )}
                {option.sectionLabel && (
                  <div
                    role="presentation"
                    className={cn(
                      MENU_SECTION_LABEL_CLASS,
                      !option.separatorBefore && MENU_GROUP_CLASS,
                    )}
                  >
                    {option.sectionLabel}
                  </div>
                )}
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  onClick={() => handleSelect(option.value)}
                  className={MENU_ITEM_CLASS}
                >
                  {option.icon && (
                    <span className={MENU_ICON_CLASS}>{option.icon}</span>
                  )}
                  <span className={MENU_LABEL_CLASS}>{option.label}</span>
                  {option.description && (
                    <Tooltip
                      content={option.description}
                      wrapperClassName="block min-w-0 flex-1"
                    >
                      <span className="text-fg-muted block truncate text-left text-xs">
                        {option.description}
                      </span>
                    </Tooltip>
                  )}
                  {/* Reserve a fixed-width slot for the check so the
                      description column stays aligned across rows whether
                      or not the row is selected. */}
                  <span className={MENU_CHECK_CLASS}>
                    {option.value === value && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </span>
                </Button>
              </Fragment>
            ))}
          </div>
          {footerSlot && (
            <>
              <div role="presentation" className={MENU_SEPARATOR_CLASS} />
              <div className="shrink-0 px-1 py-1">
                {typeof footerSlot === 'function'
                  ? footerSlot({ dismiss: handleDismiss })
                  : footerSlot}
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
