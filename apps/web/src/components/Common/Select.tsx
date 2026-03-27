import clsx from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { Button, type ButtonProps } from './Button';
import { cn } from './cn';
import { Popover } from './Popover';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  description?: string;
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
   * Panel opening direction.
   * `"down"` (default) opens below the trigger.
   * `"up"` opens above the trigger.
   */
  direction?: 'up' | 'down';
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
  direction = 'down',
}: SelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const justDismissedRef = useRef(false);

  const current = options.find((o) => o.value === value);

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
    if (direction === 'up') {
      return { x: rect.left, y: rect.top };
    }
    return { x: rect.left, y: rect.bottom };
  }, [direction]);

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
          className={cn(isOpen && 'bg-bg-default', className)}
        >
          {current?.icon}
          <span>{current?.label ?? placeholder}</span>
          <ChevronDown
            className={clsx('transition-transform', isOpen && 'rotate-180')}
          />
        </Button>
      </div>
      {isOpen && (
        <Popover
          position={computePosition()}
          onDismiss={handleDismiss}
          offset={direction === 'up' ? { x: 0, y: -4 } : { x: 0, y: 4 }}
          className="flex flex-col overflow-hidden py-1"
        >
          {options.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              tone="neutral"
              size="sm"
              role="option"
              aria-selected={option.value === value}
              onClick={() => handleSelect(option.value)}
              className={cn(
                'w-full justify-start rounded-none px-3 py-1.5 text-left',
                option.value === value ? 'text-info' : 'text-fg-default',
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
          ))}
        </Popover>
      )}
    </>
  );
}
