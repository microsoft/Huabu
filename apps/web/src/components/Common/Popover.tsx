import clsx from 'clsx';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type FloatingPosition = { x: number; y: number };

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

export type PopoverProps = {
  /**
   * Screen-space position (e.g. clientX/Y from the triggering event).
   * If omitted, the panel appears at the current mouse-cursor position.
   */
  position?: FloatingPosition;

  /**
   * Called when the floating panel should close.
   * Triggers on outside pointer-down and (optionally) on Escape key.
   */
  onDismiss?: () => void;

  /** Whether pressing Escape dismisses the panel. Defaults to `true`. */
  dismissOnEscape?: boolean;

  /**
   * Offset applied to the position (px).
   * Positive values push the panel right/down. Defaults to `{ x: 4, y: 4 }`.
   */
  offset?: Partial<FloatingPosition>;

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

  /** Portal target. Defaults to `document.body`. */
  container?: Element;

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
  position: positionProp,
  onDismiss,
  dismissOnEscape = true,
  offset,
  viewportMargin = 12,
  boundary,
  zIndex = 9999,
  className,
  container,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState<FloatingPosition | null>(null);

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
    const el = containerRef.current;
    if (!el) return;

    const rawX = position.x + ox;
    const rawY = position.y + oy;
    const panelRect = el.getBoundingClientRect();

    // Resolve the clamping region: boundary element rect or full viewport
    const bounds = boundary
      ? boundary.getBoundingClientRect()
      : {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
        };

    const minX = bounds.left + viewportMargin;
    const minY = bounds.top + viewportMargin;
    const maxX = bounds.right - panelRect.width - viewportMargin;
    const maxY = bounds.bottom - panelRect.height - viewportMargin;

    setClamped({
      x: Math.max(minX, Math.min(rawX, maxX)),
      y: Math.max(minY, Math.min(rawY, maxY)),
    });
  }, [position.x, position.y, ox, oy, viewportMargin, boundary]);

  useLayoutEffect(() => {
    updateClampedPosition();
  }, [updateClampedPosition]);

  // Re-clamp on window resize so the panel stays within bounds
  useEffect(() => {
    window.addEventListener('resize', updateClampedPosition);
    return () => window.removeEventListener('resize', updateClampedPosition);
  }, [updateClampedPosition]);

  // Re-clamp when the panel's own size changes (e.g. content switches from
  // a loading spinner to a longer list) so it doesn't overflow.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => updateClampedPosition());
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateClampedPosition]);

  // Dismiss on outside pointer-down
  useEffect(() => {
    if (!onDismiss) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onDismiss();
      }
    };

    // Delay listener to avoid catching the triggering event
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', handlePointerDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [onDismiss]);

  // Dismiss on Escape key
  useEffect(() => {
    if (!onDismiss || !dismissOnEscape) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDismiss, dismissOnEscape]);

  const isMeasuring = clamped === null;

  const panel = (
    <div
      ref={containerRef}
      className={clsx(
        'border-border fixed rounded-md border bg-white shadow-lg',
        className,
      )}
      style={{
        left: isMeasuring ? 0 : clamped.x,
        top: isMeasuring ? 0 : clamped.y,
        visibility: isMeasuring ? 'hidden' : 'visible',
        zIndex,
      }}
    >
      {children}
    </div>
  );

  return createPortal(panel, container ?? document.body);
};
