import { useEffect, useRef, useState } from 'react';

import { Button } from './Button';
import { cn } from './cn';
import { ColorPicker, type ColorPreset } from './ColorPicker';
import {
  Select as BaseSelect,
  type SelectOption as BaseSelectOption,
} from './Select';

import type { ReactNode } from 'react';

// ─── Shared style tokens ──────────────────────────────────────────────────────

/** Base class string shared by every toolbar surface (node, edge, multi-select). */
export const FLOATING_TOOLBAR_CLASS =
  'text-fg-muted shadow-bottom bg-surface flex items-center gap-1 rounded-lg p-1.5';

// ─── Root ─────────────────────────────────────────────────────────────────────

interface RootProps {
  children: ReactNode;
  className?: string;
}

/**
 * Unified toolbar chrome used by edge toolbar and multi-select toolbar.
 * For node toolbars, prefer applying `FLOATING_TOOLBAR_CLASS` directly
 * to `<NodeToolbar className>` to avoid an extra wrapper div.
 */
function Root({ children, className }: RootProps) {
  return (
    <div className={cn(FLOATING_TOOLBAR_CLASS, className)}>{children}</div>
  );
}

// ─── Divider ──────────────────────────────────────────────────────────────────

/** Vertical separator between toolbar sections. */
function Divider() {
  return <div className="bg-border mx-0.5 h-4 w-px" />;
}

// ─── ToggleButton ─────────────────────────────────────────────────────────────

interface ToggleButtonProps {
  /** Whether the toggle is currently active. */
  active: boolean;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * A toolbar button with a consistent active / inactive highlight.
 *
 * Active:   `text-info bg-info-bg`
 * Inactive: `text-fg-muted hover:bg-bg-default`
 */
function ToggleButton({
  active,
  title,
  onClick,
  children,
  className,
  disabled,
}: ToggleButtonProps) {
  return (
    <Button
      variant="ghost"
      iconOnly
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        active
          ? 'text-info bg-info-bg enabled:hover:bg-info-bg'
          : 'text-fg-muted hover:bg-bg-default',
        className,
      )}
    >
      {children}
    </Button>
  );
}

// ─── ActionButton ─────────────────────────────────────────────────────────────

interface ActionButtonProps {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
  className?: string;
  /** Visual tone — `danger` is used for destructive actions like Delete. */
  tone?: 'neutral' | 'danger';
  disabled?: boolean;
}

/** A stateless action button (e.g. Fullscreen, Download, Copy, Delete). */
function ActionButton({
  title,
  onClick,
  children,
  className,
  tone = 'neutral',
  disabled,
}: ActionButtonProps) {
  return (
    <Button
      variant="ghost"
      tone={tone}
      iconOnly
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      {children}
    </Button>
  );
}

// ─── Group ────────────────────────────────────────────────────────────────────

interface GroupProps {
  children: ReactNode;
  className?: string;
}

/** Logical grouping of buttons inside a toolbar. */
function Group({ children, className }: GroupProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>{children}</div>
  );
}

// ─── ToolbarSelect ────────────────────────────────────────────────────────────

interface ToolbarSelectProps<T extends string = string> {
  options: BaseSelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** Show only the icon in the trigger (label hidden). */
  iconOnly?: boolean;
  /** Optional short text label rendered before the select trigger. */
  label?: string;
}

/**
 * A Select pre-configured for toolbar usage: ghost variant, sm size,
 * opens upward (top-left).
 */
function ToolbarSelect<T extends string = string>({
  options,
  value,
  onChange,
  className,
  iconOnly,
  label,
}: ToolbarSelectProps<T>) {
  return (
    <div className="flex items-center">
      {label && <span className="text-fg-subtle px-0.5 text-xs">{label}</span>}
      <BaseSelect
        options={options}
        value={value}
        onChange={onChange}
        variant="ghost"
        size="sm"
        align="top-left"
        className={className}
        iconOnly={iconOnly}
      />
    </div>
  );
}

// ─── ToolbarColorPicker ───────────────────────────────────────────────────────

interface ToolbarColorPickerProps {
  /** Palette of selectable colors. */
  colors: readonly ColorPreset[];
  /**
   * Currently selected token. Legacy hex strings (pre-token data) are also
   * accepted and used directly as the trigger swatch's CSS color.
   */
  value: string | null | undefined;
  /** Called with the picked token. */
  onSelect: (token: string) => void;
  /** Tooltip label for the trigger button. */
  title?: string;
  /**
   * Custom trigger content. When omitted, a circular swatch showing the
   * current color is rendered.
   */
  children?: ReactNode;
}

/**
 * A color-picker trigger + popover, pre-styled for toolbar usage.
 * Manages its own open/close state and outside-click dismissal.
 */
function ToolbarColorPicker({
  colors,
  value,
  onSelect,
  title = 'Change color',
  children,
}: ToolbarColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as HTMLElement)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Resolve the token to a CSS color for the trigger swatch.
  // Legacy hex / CSS keyword passes through unchanged.
  const triggerColor =
    colors.find((c) => c.token === value)?.value ?? value ?? 'transparent';
  const isTransparent = !triggerColor || triggerColor === 'transparent';

  // Mirror the checkerboard rendering used by the picker swatches so a
  // "transparent" selection is visually distinct from a solid white swatch.
  const defaultTrigger = (
    <div
      className="border-edge-default h-3.5 w-3.5 rounded-full border"
      style={
        isTransparent
          ? {
              backgroundColor: 'var(--bg-surface)',
              backgroundImage:
                'linear-gradient(45deg, var(--fg-subtle) 25%, transparent 25%, transparent 75%, var(--fg-subtle) 75%), linear-gradient(45deg, var(--fg-subtle) 25%, transparent 25%, transparent 75%, var(--fg-subtle) 75%)',
              backgroundSize: '6px 6px',
              backgroundPosition: '0 0, 3px 3px',
            }
          : { backgroundColor: triggerColor }
      }
    />
  );

  return (
    <div ref={containerRef} className="relative flex items-center">
      <Button
        variant="outline"
        iconOnly
        size="sm"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="h-6 rounded-sm"
      >
        {children ?? defaultTrigger}
      </Button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
            }}
          />
          <div
            className="border-edge-default shadow-bottom animate-in fade-in zoom-in bg-surface absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-full border px-2 py-1.5 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <ColorPicker
              colors={colors}
              activeToken={value}
              onSelect={(t) => {
                onSelect(t);
                setIsOpen(false);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Compound export ──────────────────────────────────────────────────────────

export const FloatingToolbar = Object.assign(Root, {
  Divider,
  ToggleButton,
  ActionButton,
  Group,
  Select: ToolbarSelect,
  ColorPicker: ToolbarColorPicker,
});
