// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  Shrink,
  UnfoldVertical,
  Ungroup,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useCloseOnEscape } from '@/hooks/useCloseOnEscape';

import { Button } from './Button';
import { cn } from './cn';
import { ColorPicker, type ColorPreset } from './ColorPicker';
import { FLOATING_CHROME_PROPS } from './floatingChrome';
import {
  Select as BaseSelect,
  type SelectOption as BaseSelectOption,
} from './Select';
import { Tooltip } from './Tooltip';

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

/** Shared surface chrome for compact popovers opened from a toolbar. */
export const FLOATING_TOOLBAR_POPOVER_CLASS =
  'border-edge-default shadow-bottom bg-surface z-50 rounded-lg border px-2 py-1.5';

// ─── Root ─────────────────────────────────────────────────────────────────────

interface RootProps {
  children: ReactNode;
  className?: string;
  onMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

/**
 * Unified toolbar chrome used by edge toolbar and multi-select toolbar.
 * For node toolbars, prefer applying `FLOATING_TOOLBAR_CLASS` directly
 * to `<NodeToolbar className>` to avoid an extra wrapper div.
 */
function Root({ children, className, onMouseDown }: RootProps) {
  return (
    <div
      role="presentation"
      className={cn(FLOATING_TOOLBAR_CLASS, className)}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
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
      aria-pressed={active}
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
  /** Extra classes for the trigger button. */
  triggerClassName?: string;
  /** Optional controlled open state. When omitted, the picker manages itself. */
  open?: boolean;
  /** Called when the popover should open or close. */
  onOpenChange?: (open: boolean) => void;
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
  triggerClassName,
  open,
  onOpenChange,
  children,
}: ToolbarColorPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = open ?? uncontrolledOpen;
  const setIsOpen = (nextOpen: boolean) => {
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const { refs, floatingStyles, isPositioned } = useFloating({
    open: isOpen,
    placement: 'top',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useCloseOnEscape(isOpen, () => setIsOpen(false));

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
    <div
      ref={(node) => {
        refs.setReference(node);
      }}
      className="flex items-center"
    >
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={cn(
          'bg-bg-default enabled:hover:bg-hover h-6 w-7 rounded-md',
          isOpen && 'ring-info ring-1',
          triggerClassName,
        )}
      >
        {children ?? defaultTrigger}
      </Button>

      {isOpen
        ? createPortal(
            <>
              <div
                role="presentation"
                className="fixed inset-0 z-40"
                {...FLOATING_CHROME_PROPS}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                }}
              />
              <div
                ref={refs.setFloating}
                role="presentation"
                {...FLOATING_CHROME_PROPS}
                className={cn(FLOATING_TOOLBAR_POPOVER_CLASS, 'px-1.5 py-1')}
                style={{
                  ...floatingStyles,
                  visibility: isPositioned ? 'visible' : 'hidden',
                }}
                onMouseDown={(e) => e.preventDefault()}
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
            </>,
            document.body,
          )
        : null}
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
  /** Whether to render the H input. Defaults to true. */
  showHeight?: boolean;
  /**
   * When provided, renders a small toggle next to the H input that
   * flips the node between fixed (pinned) and auto-fit height modes.
   *
   * - `active: true`  → currently in auto-fit mode; the H input is
   *   styled as a hint (subtle text) and any value the user types
   *   automatically pins the height.
   * - `active: false` → currently fixed; toggle hands control back to
   *   auto-fit.
   *
   * Legacy shorthand for `autoSize={{ dimensions: 'height', ... }}`.
   * Prefer `autoSize` for new call sites; `heightAuto` is kept so
   * existing note callers stay untouched.
   */
  heightAuto?: {
    active: boolean;
    onToggle: () => void;
  };
  /**
   * Generalised auto-size toggle. Like `heightAuto` but also covers
   * the W input when `dimensions: 'both'` (e.g. frame hug-mode where
   * both axes track the content).
   *
   * When `active` is `true`:
   * - The affected inputs (`H` only for `'height'`; `W` AND `H` for
   *   `'both'`) render with a subtle italic hint style.
   * - Typing into an affected input always dispatches via `onApply`,
   *   even when the typed value matches the current measured size,
   *   so the host can treat the keystroke as an explicit "pin this
   *   dimension" request and flip the node out of auto-size mode.
   *
   * Mutually exclusive with {@link ToolbarSizePickerProps.heightAuto}:
   * `autoSize` is the canonical, generalised form and the legacy
   * `heightAuto` is just a shorthand for `{ dimensions: 'height' }`.
   * If a caller passes both, `autoSize` wins and `heightAuto` is
   * silently ignored — new call sites should only pass `autoSize`.
   * (TypeScript does not enforce this at the type level because
   * `heightAuto` is kept around for existing note callers; treat both
   * fields as the union of two opt-ins, not independent toggles.)
   */
  autoSize?: {
    /** Which axes are auto-sized when `active`. Defaults to `'height'`. */
    dimensions?: 'height' | 'both';
    active: boolean;
    onToggle: () => void;
  };
}

const SIZE_INPUT_CLASS =
  'nodrag h-6 w-10 bg-transparent text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

// Rounded filled "capsule" wrapping the label + input so `W 937`
// reads as one solid chip (more cohesive than a hairline-bordered
// field). Frame hug wraps its W/H pair in a single shared capsule
// instead, so those inner inputs opt out via `unstyled`.
const SIZE_CAPSULE_CLASS =
  'bg-bg-default hover:bg-hover focus-within:ring-info rounded-md px-1.5 py-0 transition-colors focus-within:ring-1';

interface ToolbarNumberInputProps {
  label: string;
  ariaLabel: string;
  name: string;
  value: number | null;
  onApply: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  inputClassName?: string;
  disabled?: boolean;
  title?: string;
  /**
   * Optional control rendered *inside* the input on its trailing edge
   * (e.g. an auto/fixed height toggle). When present the input widens
   * and reserves right padding so the value never overlaps the icon.
   */
  endAdornment?: ReactNode;
  /**
   * When set, the input displays this text read-only (e.g. "Auto")
   * instead of an editable number — used when the dimension is
   * content-driven and has no pinned value to edit.
   */
  autoText?: string;
  /**
   * Render without the rounded capsule background (transparent), for
   * cases where an outer container already provides the chip surface
   * (e.g. a frame's shared W/H capsule).
   */
  unstyled?: boolean;
}

function ToolbarNumberInput({
  label,
  ariaLabel,
  name,
  value,
  onApply,
  min = 1,
  max,
  step = 1,
  inputClassName,
  disabled = false,
  title,
  endAdornment,
  autoText,
  unstyled = false,
}: ToolbarNumberInputProps) {
  const isAuto = typeof autoText === 'string';
  const Container: 'div' | 'label' = isAuto ? 'div' : 'label';
  const [text, setText] = useState('');

  useEffect(() => {
    setText(typeof value === 'number' ? String(Math.round(value)) : '');
  }, [value]);

  const restore = () => {
    setText(typeof value === 'number' ? String(Math.round(value)) : '');
  };

  const commit = () => {
    if (disabled) {
      restore();
      return;
    }
    const trimmed = text.trim();
    if (trimmed === '') {
      restore();
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      restore();
      return;
    }
    const clamped = Math.max(
      min,
      max === undefined ? parsed : Math.min(max, parsed),
    );
    const next = Math.round(clamped);
    setText(String(next));
    if (typeof value !== 'number' || next !== Math.round(value)) {
      onApply(next);
    }
  };

  return (
    <Container
      className={cn(
        'nodrag flex items-center gap-1',
        !unstyled && SIZE_CAPSULE_CLASS,
      )}
      title={title}
    >
      <span className="text-fg-subtle text-xs" aria-hidden="true">
        {label}
      </span>
      <div className="relative flex items-center">
        {isAuto ? (
          <span
            className={cn(
              'nodrag inline-flex h-6 w-10 items-center bg-transparent text-xs',
              endAdornment && 'w-9',
              inputClassName,
            )}
          >
            <span className="sr-only">{ariaLabel}: </span>
            {autoText}
          </span>
        ) : (
          <input
            type="number"
            name={name}
            inputMode="numeric"
            aria-label={ariaLabel}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={text}
            placeholder={typeof value === 'number' ? '' : '—'}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                commit();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                restore();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className={cn(
              SIZE_INPUT_CLASS,
              endAdornment && 'w-9',
              disabled && 'cursor-not-allowed opacity-50',
              inputClassName,
            )}
          />
        )}
        {endAdornment && (
          <div className="flex items-center">{endAdornment}</div>
        )}
      </div>
    </Container>
  );
}

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
  showHeight = true,
  heightAuto,
  autoSize,
}: ToolbarSizePickerProps) {
  const { t } = useTranslation();
  // Normalise: `autoSize` wins over the legacy `heightAuto` shorthand
  // so a caller passing both gets predictable behaviour (instead of
  // them silently fighting).
  const auto =
    autoSize ??
    (heightAuto ? { dimensions: 'height' as const, ...heightAuto } : undefined);
  const autoActive = auto?.active === true;
  const heightIsAuto = autoActive;
  const isBothAxes = auto?.dimensions === 'both';
  const widthIsAuto = autoActive && isBothAxes;

  // Auto/fixed toggle rendered as a single icon whose position matches
  // its scope: for single-axis note height it embeds in the H input;
  // for a frame's both-axes hug it sits *before* the W/H pair as a
  // size-wide mode control (it governs W and H together, so it can't
  // belong to one dimension's input). The same glyph carries both
  // states — highlighted (info tone) when auto is active, muted when
  // pinned.
  const autoLabel = t('toolbar.size.auto');
  const modeToggle = (icon: ReactNode) => {
    if (!auto) return null;
    const description = autoActive
      ? isBothAxes
        ? t('toolbar.size.switchManual')
        : t('toolbar.size.switchFixedHeight')
      : isBothAxes
        ? t('toolbar.size.fitSize')
        : t('toolbar.size.fitHeight');
    return (
      <Tooltip content={description}>
        <button
          type="button"
          // An icon-only control needs a name of its own: a tooltip is
          // not one, and this is the only affordance that reports which
          // side owns the size.
          aria-label={description}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            auto.onToggle();
          }}
          className={cn(
            'nodrag flex h-6 w-6 items-center justify-center rounded transition-colors',
            autoActive ? 'text-info' : 'text-fg-subtle hover:text-fg-default',
          )}
        >
          {icon}
        </button>
      </Tooltip>
    );
  };

  const widthInput = (
    <ToolbarNumberInput
      label="W"
      ariaLabel="Width"
      name="node-width"
      value={width}
      min={minSize}
      unstyled={isBothAxes}
      autoText={widthIsAuto ? autoLabel : undefined}
      inputClassName={widthIsAuto ? 'text-fg-muted italic' : undefined}
      onApply={(next) => {
        if (
          widthIsAuto ||
          typeof width !== 'number' ||
          next !== Math.round(width)
        ) {
          onApply({ width: next });
        }
      }}
    />
  );

  const heightInput = showHeight ? (
    <ToolbarNumberInput
      label="H"
      ariaLabel="Height"
      name="node-height"
      value={height}
      min={minSize}
      unstyled={isBothAxes}
      autoText={heightIsAuto ? autoLabel : undefined}
      inputClassName={heightIsAuto ? 'text-fg-muted italic' : undefined}
      endAdornment={
        isBothAxes ? undefined : modeToggle(<UnfoldVertical size={12} />)
      }
      onApply={(next) => {
        if (
          heightIsAuto ||
          typeof height !== 'number' ||
          next !== Math.round(height)
        ) {
          onApply({ height: next });
        }
      }}
    />
  ) : null;

  // Frame hug governs W *and* H together. Wrap W + H + toggle in a
  // single shared capsule (inner inputs transparent) so the trio reads
  // as one unit and the trailing icon clearly switches the whole
  // group's mode. A hairline divider keeps W and H legible inside the
  // shared chip. Single-axis note needs no group — each input is its
  // own capsule and the toggle is embedded in the H input.
  if (isBothAxes) {
    return (
      <div className={cn('nodrag flex items-center gap-1', SIZE_CAPSULE_CLASS)}>
        {widthInput}
        <div className="bg-edge-default h-3.5 w-px" aria-hidden />
        {heightInput}
        {modeToggle(<Shrink size={12} />)}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {widthInput}
      {heightInput}
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
  title,
}: ToolbarAlignPickerProps) {
  const { t } = useTranslation();
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
  useCloseOnEscape(isOpen, () => setIsOpen(false));

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
    {
      direction: 'left',
      title: t('toolbar.align.left'),
      Icon: AlignStartVertical,
    },
    {
      direction: 'center-h',
      title: t('toolbar.align.center'),
      Icon: AlignCenterVertical,
    },
    {
      direction: 'right',
      title: t('toolbar.align.right'),
      Icon: AlignEndVertical,
    },
    {
      direction: 'top',
      title: t('toolbar.align.top'),
      Icon: AlignStartHorizontal,
    },
    {
      direction: 'center-v',
      title: t('toolbar.align.middle'),
      Icon: AlignCenterHorizontal,
    },
    {
      direction: 'bottom',
      title: t('toolbar.align.bottom'),
      Icon: AlignEndHorizontal,
    },
  ];

  return (
    <div ref={containerRef} className="relative flex items-center">
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={title ?? t('toolbar.align.title')}
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
            role="presentation"
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
            }}
          />
          <div
            role="presentation"
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
                title={t('toolbar.align.spreadApart')}
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
  NumberInput: ToolbarNumberInput,
  AlignPicker: ToolbarAlignPicker,
});
