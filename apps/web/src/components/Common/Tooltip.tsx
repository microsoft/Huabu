// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset as offsetMiddleware,
  shift,
  useDelayGroup,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
} from '@floating-ui/react';
import { cloneElement, useId, useState } from 'react';

import { cn } from './cn';

import type { ReactElement, ReactNode } from 'react';

export type TooltipPlacement = 'auto' | 'top' | 'bottom';

export type TooltipProps = {
  content: ReactNode;
  children: ReactElement;
  wrapperClassName?: string;
  /** Extra classes applied to the floating tooltip bubble. */
  contentClassName?: string;
  /** Distance in px between the trigger and the tooltip. Defaults to 8. */
  offset?: number;
  /**
   * Preferred placement relative to the trigger. Defaults to `'auto'`,
   * which is treated the same as `'top'` — both start above and flip
   * to the opposite side if there isn't enough room.
   */
  placement?: TooltipPlacement;
};

/**
 * Hover/focus tooltip implemented on top of `@floating-ui/react`.
 *
 * Why Floating UI instead of a hand-rolled portal:
 *   - `useHover` + `useFocus` + `useDismiss` deliver one consistent
 *     dismissal model (pointer leave, focus blur, Escape key, ancestor
 *     scroll, click on the trigger) so a tooltip can never be left
 *     stranded on screen after the user has moved on.
 *   - `useDelayGroup` opts every Tooltip into the surrounding
 *     `<FloatingDelayGroup>` (mounted at the app root). When one
 *     tooltip becomes visible, every peer in the same group is closed
 *     instantly — this is the singleton behaviour that the previous
 *     manual implementation lacked, which is why two tooltips could
 *     occasionally be visible at the same time (e.g. when a button's
 *     click handler opened a popover overlay before its own
 *     `mouseleave` fired).
 *   - `autoUpdate` + `flip` + `shift` keep the popover anchored as the
 *     trigger moves, scrolls, or reaches a viewport edge, so we no
 *     longer have to clamp coordinates manually.
 *
 * Public API is intentionally identical to the previous version so no
 * callsite has to change.
 */
export const Tooltip = ({
  content,
  children,
  wrapperClassName,
  contentClassName,
  offset: offsetProp = 8,
  placement = 'auto',
}: TooltipProps) => {
  const tooltipId = useId();
  const [isOpen, setIsOpen] = useState(false);

  const isDisabled =
    content === null || content === undefined || content === '';

  // 'auto' historically picked 'top' whenever it fit; we therefore
  // start on 'top' and let `flip` swap to 'bottom' when there isn't
  // enough room. 'bottom' is the only case that starts on the
  // opposite side.
  const initialPlacement: 'top' | 'bottom' =
    placement === 'bottom' ? 'bottom' : 'top';

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: initialPlacement,
    middleware: [
      offsetMiddleware(offsetProp),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Opt into the surrounding <FloatingDelayGroup>. No-op when one
  // isn't mounted, but in this app the root <App> wraps the tree so
  // every Tooltip participates in the same singleton group.
  useDelayGroup(context, { id: tooltipId });

  const hover = useHover(context, { move: false, delay: { open: 150 } });
  const focus = useFocus(context);
  const dismiss = useDismiss(context, {
    escapeKey: true,
    // Close as soon as the trigger is pressed. This is the key fix
    // for the "tooltip lingers after clicking a button that opens a
    // popover" bug, since the popover's overlay used to intercept the
    // mouseleave that would otherwise have dismissed the tooltip.
    referencePress: true,
    ancestorScroll: true,
  });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    dismiss,
  ]);

  if (isDisabled) {
    return children;
  }

  // Mirror the previous a11y wiring: attach `aria-describedby` to the
  // actual interactive child rather than the wrapper span, so screen
  // readers announce the tooltip text alongside the button label.
  const childWithAriaProps = children as ReactElement<{
    'aria-describedby'?: string;
  }>;
  const existingDescribedBy = childWithAriaProps.props['aria-describedby'];
  const childDescribedBy = isOpen
    ? typeof existingDescribedBy === 'string'
      ? `${existingDescribedBy} ${tooltipId}`
      : tooltipId
    : existingDescribedBy;

  const wrappedChild = cloneElement(childWithAriaProps, {
    'aria-describedby': childDescribedBy,
  });

  return (
    <>
      <span
        {...getReferenceProps({
          ref: refs.setReference,
          className: wrapperClassName || 'inline-flex',
        })}
      >
        {wrappedChild}
      </span>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            id={tooltipId}
            role="tooltip"
            {...getFloatingProps({
              className: cn(
                'shadow-bottom bg-inverse text-fg-inverse pointer-events-none z-10001 max-w-[90vw] rounded-md px-2 py-1 text-xs',
                contentClassName,
              ),
              style: floatingStyles,
            })}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
