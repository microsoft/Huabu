import { cloneElement, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ReactElement, ReactNode } from 'react';

type TooltipPosition = {
  x: number;
  y: number;
  maxWidth: number;
};

export type TooltipProps = {
  content: ReactNode;
  children: ReactElement;
  wrapperClassName?: string;
  /** Distance in px between the trigger and the tooltip. Defaults to 8. */
  offset?: number;
};

const clamp = (value: number, min: number, max: number) => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

export const Tooltip = ({
  content,
  children,
  wrapperClassName,
  offset: offsetProp = 8,
}: TooltipProps) => {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const isDisabled =
    content === null || content === undefined || content === '';

  const updatePosition = () => {
    const triggerEl = triggerRef.current;
    const tooltipEl = tooltipRef.current;
    if (!triggerEl || !tooltipEl) return;

    const padding = 8;
    const offset = offsetProp;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const maxWidth = Math.max(0, viewportWidth - padding * 2);
    tooltipEl.style.maxWidth = `${maxWidth}px`;

    const triggerRect = triggerEl.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();

    const idealX =
      triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
    const x = clamp(
      idealX,
      padding,
      viewportWidth - padding - tooltipRect.width,
    );

    const yAbove = triggerRect.top - offset - tooltipRect.height;
    const yBelow = triggerRect.bottom + offset;
    const preferAbove = yAbove >= padding;

    const idealY = preferAbove ? yAbove : yBelow;
    const y = clamp(
      idealY,
      padding,
      viewportHeight - padding - tooltipRect.height,
    );

    setPosition({ x, y, maxWidth });
  };

  useLayoutEffect(() => {
    if (!isOpen) return;

    updatePosition();

    const onWindowChange = () => updatePosition();
    window.addEventListener('resize', onWindowChange);
    window.addEventListener('scroll', onWindowChange, true);

    return () => {
      window.removeEventListener('resize', onWindowChange);
      window.removeEventListener('scroll', onWindowChange, true);
    };
  }, [isOpen]);

  if (isDisabled) {
    return children;
  }

  const describedBy =
    isOpen && typeof children.props['aria-describedby'] === 'string'
      ? `${children.props['aria-describedby']} ${tooltipId}`
      : isOpen
        ? tooltipId
        : children.props['aria-describedby'];

  const wrappedChild = cloneElement(children, {
    'aria-describedby': describedBy,
  });

  return (
    <>
      <span
        ref={triggerRef}
        className={wrapperClassName || 'inline-flex'}
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
        onFocusCapture={() => setIsOpen(true)}
        onBlurCapture={() => setIsOpen(false)}
      >
        {wrappedChild}
      </span>

      {isOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="shadow-bottom pointer-events-none fixed z-50 rounded-md bg-gray-900 px-2 py-1 text-xs text-white"
              style={{
                left: position?.x ?? -9999,
                top: position?.y ?? -9999,
                maxWidth: position?.maxWidth,
              }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
