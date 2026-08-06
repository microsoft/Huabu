// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { FLOATING_TOOLBAR_POPOVER_CLASS } from '@/components/Common/FloatingToolbar';
import { RangeSlider } from '@/components/Common/RangeSlider';

interface SketchSizePickerProps {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
  /** Fired once when the slider drag / key interaction begins. */
  onDragStart?: () => void;
  /** Fired once when it ends (pointer up / cancel / blur / unmount). */
  onDragEnd?: () => void;
  touch?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  grouped?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SketchSizePicker({
  value,
  min,
  max,
  label,
  onChange,
  onDragStart,
  onDragEnd,
  touch = false,
  selected,
  onSelect,
  grouped = false,
  open,
  onOpenChange,
}: SketchSizePickerProps) {
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
  const previewHeight = Math.max(2, Math.min(10, value / 2));

  return (
    <div ref={refs.setReference} className="flex items-center">
      <Button
        variant="ghost"
        iconOnly
        size="sm"
        title={`${label}: ${value}`}
        aria-expanded={isOpen}
        onClick={(event) => {
          event.stopPropagation();
          if (selected === false) {
            onSelect?.();
            return;
          }
          setIsOpen(!isOpen);
        }}
        className={cn(
          'enabled:hover:bg-hover h-6 w-7 rounded-md p-0',
          grouped ? 'bg-transparent' : 'bg-bg-default',
          (isOpen || selected) &&
            (grouped ? 'bg-bg-default ring-0' : 'bg-surface ring-info ring-1'),
        )}
      >
        <span
          aria-hidden
          className="bg-fg-default block w-4 rounded-full"
          style={{ height: previewHeight }}
        />
      </Button>

      {isOpen
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  setIsOpen(false);
                }}
              />
              <div
                ref={refs.setFloating}
                role="presentation"
                className={`${FLOATING_TOOLBAR_POPOVER_CLASS} flex items-center`}
                style={{
                  ...floatingStyles,
                  visibility: isPositioned ? 'visible' : 'hidden',
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <RangeSlider
                  value={value}
                  min={min}
                  max={max}
                  label={label}
                  size={touch ? 'md' : 'sm'}
                  onChange={onChange}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
