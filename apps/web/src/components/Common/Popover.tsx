// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoUpdate,
  flip,
  offset as floatingOffset,
  shift,
  size,
  useFloating,
  type Placement,
} from '@floating-ui/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type CSSProperties,
  type MutableRefObject,
  type Ref,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from './cn';
import { FLOATING_CHROME_PROPS } from './floatingChrome';

type FloatingPosition = { x: number; y: number };

const PopoverContainerContext = createContext<Element | null>(null);

interface EscapeLayer {
  parent: EscapeLayer | null;
}

const EscapeLayerContext = createContext<EscapeLayer | null>(null);
const escapeLayers = new Set<EscapeLayer>();

function topEscapeLayer(): EscapeLayer | undefined {
  const layers = [...escapeLayers];
  return layers.reverse().find(
    (candidate) =>
      !layers.some((layer) => {
        for (let parent = layer.parent; parent; parent = parent.parent) {
          if (parent === candidate) return true;
        }
        return false;
      }),
  );
}

export type PopoverDismissReason = 'outside-press' | 'escape';

/**
 * Tracks the latest mouse position so Popover can default to it
 * when no explicit `position` prop is provided.
 * Uses a single global listener (passive) to avoid per-instance overhead.
 */
const mousePosition: FloatingPosition = { x: 0, y: 0 };
let mouseListenerActive = false;

function ensureMouseTracking() {
  if (mouseListenerActive) return;
  mouseListenerActive = true;
  document.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      mousePosition.x = e.clientX;
      mousePosition.y = e.clientY;
    },
    { passive: true },
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;

  if (typeof ref === 'function') {
    ref(value);
    return;
  }

  (ref as MutableRefObject<T | null>).current = value;
}

export type PopoverProps = {
  reference?: Element | null;
  placement?: Placement;
  /**
   * Screen-space position (e.g. clientX/Y from the triggering event).
   * If omitted, the panel appears at the current mouse-cursor position.
   */
  position?: FloatingPosition;

  /**
   * Called when the floating panel should close.
   * Triggers on outside pointer-down and (optionally) on Escape key.
   */
  onDismiss?: (reason: PopoverDismissReason) => void;

  /** Whether pressing Escape dismisses the panel. Defaults to `true`. */
  dismissOnEscape?: boolean;

  /**
   * Offset applied to the position (px).
   * Positive values push the panel right/down. Defaults to `{ x: 4, y: 4 }`.
   */
  offset?: Partial<FloatingPosition>;

  /**
   * Which corner of the panel is pinned to the `position` coordinate.
   * - `"top-left"` (default) — panel extends right and down.
   * - `"top-right"` — panel extends left and down.
   * - `"bottom-left"` — panel extends right and up.
   * - `"bottom-right"` — panel extends left and up.
   */
  anchor?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

  /**
   * Minimum distance (px) from the boundary edge.
   * Used when clamping position to avoid overflow. Defaults to `12`.
   */
  viewportMargin?: number;

  /**
   * Optional boundary element. When provided the panel is clamped inside this
   * element's bounding rect instead of the full viewport. Useful to keep the
   * floating panel within a specific layout region (e.g. the center canvas area).
   */
  boundary?: Element | null;

  /** CSS z-index for the portal container. Defaults to `9999`. */
  zIndex?: number;

  /**
   * Extra className(s) merged onto the outer container `<div>`.
   * The default styled container provides border, shadow, rounded-md, and bg.
   */
  className?: string;

  /**
   * Extra inline styles merged onto the panel `<div>`. Positioning
   * fields (`left`/`top`/`visibility`/`zIndex`) are always applied last
   * and cannot be overridden. Use this for dynamic dimensions the
   * caller must compute at runtime — e.g. matching the panel's
   * `minWidth` to a trigger element's measured width.
   */
  style?: CSSProperties;

  /** Portal target. Defaults to `document.body`. */
  container?: Element;

  /** Optional ref for accessing the rendered popover container element. */
  contentRef?: Ref<HTMLDivElement>;

  /** Called once after the panel is positioned and visible, for initial focus. */
  onOpenAutoFocus?: () => void;

  children: ReactNode;
};

/**
 * Popover
 *
 * A reusable portal-based floating panel that:
 * - Renders children via `createPortal` (to `document.body` by default).
 * - Positions itself with `position: fixed` at the given screen-space coords.
 *   If no `position` is provided, defaults to the current mouse-cursor location.
 * - Clamps to the viewport (or an optional `boundary` element) so it never overflows.
 * - Dismisses on outside pointer-down and (optionally) Escape key.
 * - Provides a styled card container (border + shadow + bg) by default.
 */
export const Popover: FC<PopoverProps> = ({
  reference,
  placement = 'bottom',
  position: positionProp,
  onDismiss,
  dismissOnEscape = true,
  offset,
  anchor = 'top-left',
  viewportMargin = 12,
  boundary,
  zIndex = 9999,
  className,
  style,
  container,
  contentRef,
  onOpenAutoFocus,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [clamped, setClamped] = useState<FloatingPosition | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const parentContainer = useContext(PopoverContainerContext);
  const parentEscapeLayer = useContext(EscapeLayerContext);
  const escapeLayer = useMemo(
    () => ({ parent: parentEscapeLayer }),
    [parentEscapeLayer],
  );
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const canDismissOnEscape = Boolean(onDismiss) && dismissOnEscape;
  const floating = useFloating({
    open: Boolean(reference),
    elements: { reference },
    placement,
    strategy: 'fixed',
    transform: false,
    middleware: [
      floatingOffset(8),
      flip({ padding: viewportMargin, boundary: boundary ?? undefined }),
      shift({ padding: viewportMargin, boundary: boundary ?? undefined }),
      size({
        padding: viewportMargin,
        boundary: boundary ?? undefined,
        apply({ availableWidth, elements }) {
          elements.floating.style.setProperty(
            '--popover-available-width',
            `${Math.max(0, availableWidth)}px`,
          );
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // If no position is provided, snapshot the mouse position on first mount.
  // Using a lazy initializer keeps the side-effect out of the render body.
  const fallbackRef = useRef<FloatingPosition | null>(null);
  if (!positionProp && !fallbackRef.current) {
    ensureMouseTracking();
    fallbackRef.current = { ...mousePosition };
  }
  const position = positionProp ?? fallbackRef.current ?? { x: 0, y: 0 };

  const ox = offset?.x ?? 4;
  const oy = offset?.y ?? 4;

  // Measure the panel and clamp it within the boundary (or viewport)
  const updateClampedPosition = useCallback(() => {
    if (reference) return;
    const el = containerRef.current;
    if (!el) return;

    const boundaryRect = boundary?.getBoundingClientRect();
    const bounds = {
      left: Math.max(0, boundaryRect?.left ?? 0),
      top: Math.max(0, boundaryRect?.top ?? 0),
      right: Math.min(
        window.innerWidth,
        boundaryRect?.right ?? window.innerWidth,
      ),
      bottom: Math.min(
        window.innerHeight,
        boundaryRect?.bottom ?? window.innerHeight,
      ),
    };
    el.style.setProperty(
      '--popover-available-width',
      `${Math.max(0, bounds.right - bounds.left - viewportMargin * 2)}px`,
    );
    const panelRect = el.getBoundingClientRect();
    const anchorRight = anchor === 'top-right' || anchor === 'bottom-right';
    const anchorBottom = anchor === 'bottom-left' || anchor === 'bottom-right';
    const rawX = anchorRight
      ? position.x + ox - panelRect.width
      : position.x + ox;
    const rawY = anchorBottom
      ? position.y + oy - panelRect.height
      : position.y + oy;
    const minX = bounds.left + viewportMargin;
    const minY = bounds.top + viewportMargin;
    const maxX = bounds.right - panelRect.width - viewportMargin;
    const maxY = bounds.bottom - panelRect.height - viewportMargin;

    setClamped({
      x: Math.max(minX, Math.min(rawX, maxX)),
      y: Math.max(minY, Math.min(rawY, maxY)),
    });
  }, [
    position.x,
    position.y,
    ox,
    oy,
    viewportMargin,
    boundary,
    anchor,
    reference,
  ]);

  useLayoutEffect(() => {
    updateClampedPosition();
  }, [updateClampedPosition]);

  // Re-clamp on window resize so the panel stays within bounds
  useEffect(() => {
    window.addEventListener('resize', updateClampedPosition);
    if (boundary)
      window.addEventListener('scroll', updateClampedPosition, true);
    return () => {
      window.removeEventListener('resize', updateClampedPosition);
      if (boundary)
        window.removeEventListener('scroll', updateClampedPosition, true);
    };
  }, [boundary, updateClampedPosition]);

  // Re-clamp when the panel's own size changes (e.g. content switches from
  // a loading spinner to a longer list) so it doesn't overflow.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => updateClampedPosition());
    ro.observe(el);
    if (boundary) ro.observe(boundary);
    return () => ro.disconnect();
  }, [boundary, updateClampedPosition]);

  // Dismiss on outside pointer-down.
  //
  // Caveat: components opened FROM inside the popover (Modal, Toast,
  // nested Popover) typically use a `createPortal` to `document.body`,
  // so their DOM lives OUTSIDE `containerRef`. A naive
  // `!container.contains(target)` check would then mistake any click
  // inside such a portal for an "outside" click and dismiss the
  // popover, unmounting the React tree that owns the portal —
  // making any dialog opened from a popover seem to vanish on click.
  //
  // To handle that, we also treat the click as "inside" when it
  // happens within any open `[role="dialog"]` or any element that
  // explicitly opts out via `[data-popover-dismiss-ignore]`. Modal
  // panels set `role="dialog"` so this covers them automatically.
  useEffect(() => {
    if (!onDismiss) return;

    const dialogsAtOpen = new Set(document.querySelectorAll('[role="dialog"]'));

    const handlePointerDown = (e: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (container.contains(target) || reference?.contains(target)) return;
      if (target instanceof Element) {
        if (target.closest('[data-popover-dismiss-ignore]')) return;
        const dialog = target.closest('[role="dialog"]');
        if (dialog && !dialogsAtOpen.has(dialog)) return;
      }
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        container.contains(activeElement)
      ) {
        activeElement.blur();
      }
      onDismiss('outside-press');
    };

    // Delay listener to avoid catching the triggering event
    const timer = setTimeout(() => {
      // Canvas gesture handlers can consume pointer events before they bubble.
      document.addEventListener('pointerdown', handlePointerDown, true);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onDismiss, reference]);

  // Dismiss on Escape key
  useEffect(() => {
    if (!canDismissOnEscape) return;

    escapeLayers.add(escapeLayer);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !e.defaultPrevented &&
        topEscapeLayer() === escapeLayer
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onDismissRef.current?.('escape');
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      escapeLayers.delete(escapeLayer);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [canDismissOnEscape, escapeLayer]);

  const isMeasuring = clamped === null;
  const visible = reference ? floating.isPositioned : !isMeasuring;
  const initiallyFocused = useRef(false);
  useLayoutEffect(() => {
    if (!visible || initiallyFocused.current || !onOpenAutoFocus) return;
    initiallyFocused.current = true;
    onOpenAutoFocus();
  }, [visible, onOpenAutoFocus]);
  const portalContainer = container ?? parentContainer ?? document.body;

  const contextValue = useMemo(() => contentElement, [contentElement]);

  const panel = (
    <PopoverContainerContext.Provider value={contextValue}>
      <div
        ref={(node) => {
          containerRef.current = node;
          floating.refs.setFloating(node);
          setContentElement(node);
          assignRef(contentRef, node);
        }}
        {...FLOATING_CHROME_PROPS}
        className={cn(
          'border-edge-default bg-surface fixed max-w-[var(--popover-available-width,calc(100vw-24px))] min-w-0 rounded-md border shadow-lg',
          className,
        )}
        style={{
          ...style,
          left: isMeasuring ? 0 : clamped.x,
          top: isMeasuring ? 0 : clamped.y,
          visibility: isMeasuring ? 'hidden' : 'visible',
          ...(reference
            ? {
                ...floating.floatingStyles,
                visibility: floating.isPositioned ? 'visible' : 'hidden',
              }
            : {}),
          zIndex,
        }}
      >
        <EscapeLayerContext.Provider value={escapeLayer}>
          {children}
        </EscapeLayerContext.Provider>
      </div>
    </PopoverContainerContext.Provider>
  );

  return createPortal(panel, portalContainer);
};
