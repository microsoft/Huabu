import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';

import { Button, type ButtonProps } from './Button';
import { cn } from './cn';
import { Popover } from './Popover';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  description?: string;
  /**
   * When set, a section header (`─── {sectionLabel} ───`) is rendered
   * in the dropdown panel immediately ABOVE this option. Used to group
   * related entries (e.g. the ChatPanel ModeSelector splits built-in
   * modes from connected external agents). Has no effect on selection
   * behaviour or the trigger label.
   */
  sectionLabel?: string;
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
  /** Trigger button props forwarded to `<Button>`. Defaults to outline/neutral/sm. */
  variant?: ButtonProps['variant'];
  tone?: ButtonProps['tone'];
  size?: ButtonProps['size'];
  shape?: ButtonProps['shape'];
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
   * (plus the chevron). The label text in the dropdown is unaffected.
   */
  iconOnly?: boolean;
  /**
   * Fired exactly when the dropdown transitions from closed → open
   * (clicking the trigger while open closes it and does NOT fire this).
   * Use this to lazily refresh dynamic option lists—e.g. the
   * ChatPanel ModeSelector pulls the latest ACP agents on each open
   * instead of polling on a timer.
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
  variant = 'outline',
  tone = 'neutral',
  size = 'sm',
  shape = 'default',
  align = 'bottom-left',
  iconOnly = false,
  onOpen,
  footerSlot,
}: SelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);

  const isRight = align === 'bottom-right' || align === 'top-right';
  const isTop = align === 'top-left' || align === 'top-right';

  // Map Select align → Popover anchor (vertical direction inverts)
  const anchor =
    `${isTop ? 'bottom' : 'top'}-${isRight ? 'right' : 'left'}` as const;

  const current = options.find((o) => o.value === value);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    if (justDismissedRef.current) return;
    setIsOpen((prev) => {
      const next = !prev;
      // Only fire on the closed → open transition. Fired *outside* the
      // setState updater would also work but this keeps the logic
      // co-located with the state change that triggers it.
      if (next && onOpen) onOpen();
      return next;
    });
  }, [disabled, onOpen]);

  const handleDismiss = useCallback(() => {
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
      <div ref={triggerRef}>
        <Button
          variant={variant}
          tone={tone}
          size={size}
          shape={shape}
          disabled={disabled}
          onClick={handleToggle}
          aria-expanded={isOpen}
          className={cn(
            selectShapeClasses[shape],
            isOpen && 'bg-bg-default',
            iconOnly && 'gap-0.5 px-1',
            className,
          )}
        >
          {current?.icon}
          {!iconOnly && <span>{current?.label ?? placeholder}</span>}
          <ChevronDown
            className={clsx('transition-transform', isOpen && 'rotate-180')}
          />
        </Button>
      </div>
      {isOpen && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          anchor={anchor}
          offset={{ x: 0, y: isTop ? -4 : 4 }}
          className="flex flex-col overflow-hidden py-1"
        >
          {options.map((option) => (
            <Fragment key={option.value}>
              {option.sectionLabel && (
                <div
                  role="presentation"
                  className="text-fg-muted mt-1 flex items-center gap-2 px-3 pt-1 pb-0.5 text-[10px] tracking-wider uppercase select-none"
                >
                  <span className="bg-edge-default h-px flex-1" />
                  <span>{option.sectionLabel}</span>
                  <span className="bg-edge-default h-px flex-1" />
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
                className={cn(
                  'w-full justify-start rounded-none px-3 py-1.5 text-left',
                  option.disabled
                    ? 'text-fg-muted cursor-not-allowed'
                    : option.value === value
                      ? 'text-info'
                      : 'text-fg-default',
                )}
              >
                {option.icon && <span className="shrink-0">{option.icon}</span>}
                <span className="flex-1">{option.label}</span>
                {option.description && (
                  <span className="text-fg-muted text-xs">
                    {option.description}
                  </span>
                )}
                {option.value === value && <Check size={14} />}
              </Button>
            </Fragment>
          ))}
          {footerSlot && (
            <>
              <div
                role="presentation"
                className="bg-edge-default mt-1 h-px w-full"
              />
              <div className="px-1 py-1">
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
