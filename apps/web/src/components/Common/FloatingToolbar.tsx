import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  MoveVertical,
  Ungroup,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from './Button';
import { cn } from './cn';
import { ColorPicker, type ColorPreset } from './ColorPicker';
import {
  Select as BaseSelect,
  type SelectOption as BaseSelectOption,
} from './Select';

import type { ReactNode } from 'react';

/**
 * Alignment directions supported by `ToolbarAlignPicker`.
 *
 * Mirrors the canvas store's `AlignDirection` union so the picker stays
 * decoupled from `@/handler/...` (which would create a Common → app
 * import cycle). The two definitions must stay in sync.
 */
export type ToolbarAlignDirection =
  | 'left'
  | 'center-h'
  | 'right'
  | 'top'
  | 'center-v'
  | 'bottom';

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
  return <div className="bg-edge-default mx-0.5 h-4 w-px" />;
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
  /** Underlying button size; defaults to `'sm'` for compact toolbars. */
  size?: 'sm' | 'md';
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
  size = 'sm',
}: ToggleButtonProps) {
  return (
    <Button
      variant="ghost"
      iconOnly
      size={size}
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

// ─── ToolbarSizePicker ────────────────────────────────────────────────────────

interface ToolbarSizePickerProps {
  /**
   * Current width in canvas pixels. `null` means "mixed / unknown"
   * (e.g. multi-selection where selected nodes have different widths).
   */
  width: number | null;
  /**
   * Current height in canvas pixels. `null` means "mixed / unknown".
   */
  height: number | null;
  /**
   * Called with the committed width or height. Only the edited
   * dimension is included so the host can preserve the other one's
   * current value (e.g. fall back to each node's own height in a
   * multi-selection).
   */
  onApply: (size: { width?: number; height?: number }) => void;
  /** Lower bound enforced on both inputs. Defaults to 20. */
  minSize?: number;
  /**
   * When provided, renders a small toggle next to the H input that
   * flips the node between fixed (pinned) and auto-fit height modes.
   *
   * - `active: true`  → currently in auto-fit mode; the H input is
   *   styled as a hint (subtle text) and any value the user types
   *   automatically pins the height.
   * - `active: false` → currently fixed; toggle hands control back to
   *   auto-fit.
   */
  heightAuto?: {
    active: boolean;
    onToggle: () => void;
    title?: string;
  };
}

const SIZE_INPUT_CLASS =
  'border-edge-default focus:border-info nodrag w-12 rounded border bg-transparent px-1.5 py-0.5 text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

/**
 * Inline width / height editor for a node's geometry.
 *
 * Renders directly into the toolbar row (no popover) so the user can
 * see the current dimensions at a glance and edit either value with
 * one click.
 *
 * Apply semantics:
 *  - Commits on Enter or input blur.
 *  - Empty input restores the displayed value (no dispatch).
 *  - Each dimension is dispatched independently — the host should fall
 *    back to the node's existing value for the dimension that wasn't
 *    edited.
 *  - Out-of-range values are clamped to `minSize`.
 *
 * When `heightAuto` is provided, the H input doubles as the auto-fit
 * toggle's value display: typing pins the height and the toggle button
 * lets the user flip back to content-driven sizing.
 */
function ToolbarSizePicker({
  width,
  height,
  onApply,
  minSize = 20,
  heightAuto,
}: ToolbarSizePickerProps) {
  // Local draft state per input. Synced from the canonical canvas value
  // whenever it changes externally (drag-resize, undo, auto/fixed toggle).
  // Kept separate from the prop so the user can type freely without the
  // value reformatting itself on every keystroke.
  const [wText, setWText] = useState('');
  const [hText, setHText] = useState('');

  useEffect(() => {
    setWText(typeof width === 'number' ? String(Math.round(width)) : '');
  }, [width]);

  useEffect(() => {
    setHText(typeof height === 'number' ? String(Math.round(height)) : '');
  }, [height]);

  const commitW = () => {
    const trimmed = wText.trim();
    if (trimmed === '') {
      // Empty: restore the displayed value rather than dispatching.
      setWText(typeof width === 'number' ? String(Math.round(width)) : '');
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      setWText(typeof width === 'number' ? String(Math.round(width)) : '');
      return;
    }
    const next = Math.max(minSize, Math.round(parsed));
    setWText(String(next));
    if (typeof width !== 'number' || next !== Math.round(width)) {
      onApply({ width: next });
    }
  };

  const commitH = () => {
    const trimmed = hText.trim();
    if (trimmed === '') {
      setHText(typeof height === 'number' ? String(Math.round(height)) : '');
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      setHText(typeof height === 'number' ? String(Math.round(height)) : '');
      return;
    }
    const next = Math.max(minSize, Math.round(parsed));
    setHText(String(next));
    // In auto-fit mode, always dispatch so typing pins the height even
    // when the typed value matches the current measured size.
    const isAuto = heightAuto?.active === true;
    if (isAuto || typeof height !== 'number' || next !== Math.round(height)) {
      onApply({ height: next });
    }
  };

  const isAuto = heightAuto?.active === true;

  return (
    <div className="flex items-center gap-1">
      <label className="flex items-center gap-1">
        <span className="text-fg-subtle text-xs" aria-hidden="true">
          W
        </span>
        <input
          type="number"
          inputMode="numeric"
          aria-label="Width"
          min={minSize}
          step={1}
          value={wText}
          placeholder={typeof width === 'number' ? '' : '—'}
          onChange={(e) => setWText(e.target.value)}
          onBlur={commitW}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              commitW();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setWText(
                typeof width === 'number' ? String(Math.round(width)) : '',
              );
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={SIZE_INPUT_CLASS}
        />
      </label>
      <label className="flex items-center gap-1">
        <span className="text-fg-subtle text-xs" aria-hidden="true">
          H
        </span>
        <input
          type="number"
          inputMode="numeric"
          aria-label="Height"
          min={minSize}
          step={1}
          value={hText}
          placeholder={typeof height === 'number' ? '' : '—'}
          onChange={(e) => setHText(e.target.value)}
          onBlur={commitH}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              commitH();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setHText(
                typeof height === 'number' ? String(Math.round(height)) : '',
              );
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={cn(SIZE_INPUT_CLASS, isAuto && 'text-fg-subtle italic')}
        />
      </label>
      {heightAuto && (
        <ToggleButton
          active={isAuto}
          title={
            heightAuto.title ??
            (isAuto ? 'Switch to fixed height' : 'Fit height to content')
          }
          onClick={heightAuto.onToggle}
        >
          <MoveVertical />
        </ToggleButton>
      )}
    </div>
  );
}

// ─── ToolbarAlignPicker ───────────────────────────────────────────────────────

interface ToolbarAlignPickerProps {
  /** Called when the user picks a horizontal or vertical alignment. */
  onAlign: (direction: ToolbarAlignDirection) => void;
  /** Called when the user clicks "Spread Apart". */
  onSpread: () => void;
  /** Tooltip on the trigger button. */
  title?: string;
}

/**
 * A single-trigger picker that collapses the 6 alignment actions and
 * the "Spread Apart" action into one toolbar button.
 *
 * Trigger:  one ghost icon-only button (saves ~180px on the parent
 *           toolbar versus rendering all 7 actions inline).
 * Popover:  a single flex row split into 3 groups by vertical
 *           dividers — horizontal aligns (left/center/right),
 *           vertical aligns (top/middle/bottom), and Spread Apart.
 *
 * Behaviour mirrors `ToolbarColorPicker`:
 *  - Opens on trigger click, closes on outside click, Escape, or after
 *    any action is picked.
 *  - Uses `bottom-full ... mb-2` so the popover floats above the
 *    toolbar — matches the multi-select toolbar's "lives above the
 *    selection" placement.
 */
function ToolbarAlignPicker({
  onAlign,
  onSpread,
  title = 'Align & Distribute',
}: ToolbarAlignPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Mirrors the dismissal model used by
  // `ToolbarColorPicker` so all toolbar popovers behave identically.
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

  // Close on Escape — the popover sits over the canvas, so Escape
  // should dismiss the picker without deselecting nodes.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  const pick = (direction: ToolbarAlignDirection) => {
    onAlign(direction);
    setIsOpen(false);
  };

  const spread = () => {
    onSpread();
    setIsOpen(false);
  };

  // Static config — kept inside the component so the icons resolve at
  // render time (lucide tree-shakes per-icon imports).
  const alignButtons: ReadonlyArray<{
    direction: ToolbarAlignDirection;
    title: string;
    Icon: typeof AlignStartVertical;
  }> = [
    { direction: 'left', title: 'Align Left', Icon: AlignStartVertical },
    {
      direction: 'center-h',
      title: 'Align Center',
      Icon: AlignCenterVertical,
    },
    { direction: 'right', title: 'Align Right', Icon: AlignEndVertical },
    { direction: 'top', title: 'Align Top', Icon: AlignStartHorizontal },
    {
      direction: 'center-v',
      title: 'Align Middle',
      Icon: AlignCenterHorizontal,
    },
    { direction: 'bottom', title: 'Align Bottom', Icon: AlignEndHorizontal },
  ];

  return (
    <div ref={containerRef} className="relative flex items-center">
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className="text-fg-muted hover:bg-bg-default"
      >
        <AlignHorizontalDistributeCenter />
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
            className="border-edge-default shadow-bottom animate-in fade-in zoom-in bg-surface absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 rounded-lg border p-1.5 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Single flex row: horizontal aligns, vertical divider,
                vertical aligns, vertical divider, Spread. Flex lets
                each button render at its natural ~21px width with
                consistent gaps, matching the outer toolbar. */}
            <div className="flex items-center gap-1">
              {alignButtons
                .slice(0, 3)
                .map(({ direction, title: btnTitle, Icon }) => (
                  <Button
                    key={direction}
                    variant="ghost"
                    iconOnly
                    size="sm"
                    title={btnTitle}
                    onClick={() => pick(direction)}
                    className="text-fg-muted hover:bg-bg-default"
                  >
                    <Icon />
                  </Button>
                ))}
              <div className="bg-edge-default mx-1 h-5 w-px" />
              {alignButtons
                .slice(3, 6)
                .map(({ direction, title: btnTitle, Icon }) => (
                  <Button
                    key={direction}
                    variant="ghost"
                    iconOnly
                    size="sm"
                    title={btnTitle}
                    onClick={() => pick(direction)}
                    className="text-fg-muted hover:bg-bg-default"
                  >
                    <Icon />
                  </Button>
                ))}
              <div className="bg-edge-default mx-1 h-5 w-px" />
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                title="Spread Apart"
                onClick={spread}
                className="text-fg-muted hover:bg-bg-default"
              >
                <Ungroup />
              </Button>
            </div>
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
  SizePicker: ToolbarSizePicker,
  AlignPicker: ToolbarAlignPicker,
});
