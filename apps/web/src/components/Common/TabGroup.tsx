import { cn } from './cn';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TabOption<T extends string = string> {
  value: T;
  label: string;
}

type TabGroupProps<T extends string = string> = {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

// ─── TabGroup ─────────────────────────────────────────────────────────────────

/**
 * TabGroup — a stateless segmented control for switching between views.
 * Follows the design system §3.4 styling conventions.
 *
 * Usage:
 * ```tsx
 * <TabGroup
 *   options={[{ value: 'canvas', label: 'Canvas' }, { value: 'sources', label: 'Sources' }]}
 *   value={tab}
 *   onChange={setTab}
 * />
 * ```
 */
export function TabGroup<T extends string = string>({
  options,
  value,
  onChange,
  className,
}: TabGroupProps<T>) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={
            option.value === value
              ? 'bg-bg-default text-fg-default rounded px-2 py-1 text-sm'
              : 'text-fg-muted hover:text-fg-default rounded px-2 py-1 text-sm'
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
