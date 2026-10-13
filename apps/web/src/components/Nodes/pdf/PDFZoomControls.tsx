// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@/components/Common/DropdownMenu';
import { MENU_SEPARATOR_CLASS } from '@/components/Common/menuStyles';
import { PreviewHeaderButton } from '@/components/Nodes/PreviewHeaderButton';

import type { usePdfZoom } from './usePdfZoom';

const FOCUS_CLASS =
  'touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-info-light focus-visible:ring-inset';

export function PDFZoomControls({
  zoom,
  disabled,
}: {
  zoom: ReturnType<typeof usePdfZoom>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const keyboardEdgeRef = useRef<'first' | 'last'>('first');
  const percentage = Math.round(zoom.scale * 100);

  const run = (action: () => void) => {
    action();
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  const focusMenu = (edge: 'first' | 'last') => {
    const items =
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    const item = edge === 'last' ? items?.[items.length - 1] : items?.[0];
    item?.focus({ preventScroll: true });
  };

  return (
    <div
      role="group"
      aria-label={t('node.pdfZoom')}
      className="flex h-6 shrink-0 items-center"
    >
      <PreviewHeaderButton
        title={t('canvasControls.zoomOut')}
        disabled={disabled || !zoom.canZoomOut}
        onClick={zoom.zoomOut}
        className={FOCUS_CLASS}
        tooltipWrapperClassName="flex"
      >
        <Minus aria-hidden="true" />
      </PreviewHeaderButton>
      <DropdownMenu
        floating
        align="bottom-right"
        triggerWrapperClassName="flex"
        open={open && !disabled}
        onOpenChange={setOpen}
        onOpenAutoFocus={() => focusMenu(keyboardEdgeRef.current)}
        trigger={
          <Button
            ref={triggerRef}
            variant="ghost"
            size="sm"
            disabled={disabled}
            title={t('node.pdfZoom')}
            tooltipPlacement="bottom"
            tooltipWrapperClassName="flex"
            aria-label={t('node.pdfZoomMenu', { percentage })}
            aria-haspopup="menu"
            aria-controls={open ? id : undefined}
            className={`${FOCUS_CLASS} h-6 w-14 gap-0.5 px-1 py-0 text-[11px] tabular-nums`}
            onPointerDown={() => {
              keyboardEdgeRef.current = 'first';
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                event.stopPropagation();
                const edge = event.key === 'ArrowUp' ? 'last' : 'first';
                keyboardEdgeRef.current = edge;
                if (open) focusMenu(edge);
                else setOpen(true);
              }
            }}
          >
            <span>
              {disabled || zoom.scale <= 0 ? '\u2014' : `${percentage}%`}
            </span>
            <ChevronDown aria-hidden="true" className="h-2.5! w-2.5!" />
          </Button>
        }
      >
        <div
          ref={menuRef}
          id={id}
          role="menu"
          tabIndex={-1}
          aria-label={t('node.pdfZoom')}
          className="min-w-40"
          onKeyDown={(event) => {
            // Let the shared Popover consume Escape before workspace shortcuts.
            if (event.key === 'Escape') return;
            event.stopPropagation();
            if (event.key === 'Tab') {
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ),
            );
            const index = items.findIndex(
              (item) => item === document.activeElement,
            );
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index +
                      (event.key === 'ArrowDown' ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus({ preventScroll: true });
          }}
        >
          <DropdownMenuItem
            aria-current={zoom.mode === 'width' ? 'true' : undefined}
            trailing={
              zoom.mode === 'width' && <Check aria-hidden="true" size={14} />
            }
            onClick={() => run(() => zoom.fit('width'))}
          >
            {t('node.pdfFitWidth')}
          </DropdownMenuItem>
          <DropdownMenuItem
            aria-current={zoom.mode === 'page' ? 'true' : undefined}
            trailing={
              zoom.mode === 'page' && <Check aria-hidden="true" size={14} />
            }
            onClick={() => run(() => zoom.fit('page'))}
          >
            {t('node.pdfFitPage')}
          </DropdownMenuItem>
          <div role="separator" className={MENU_SEPARATOR_CLASS} />
          <DropdownMenuItem onClick={() => run(zoom.resetZoom)}>
            {t('node.pdfResetZoom')}
          </DropdownMenuItem>
        </div>
      </DropdownMenu>
      <PreviewHeaderButton
        title={t('canvasControls.zoomIn')}
        disabled={disabled || !zoom.canZoomIn}
        onClick={zoom.zoomIn}
        className={FOCUS_CLASS}
        tooltipWrapperClassName="flex"
      >
        <Plus aria-hidden="true" />
      </PreviewHeaderButton>
    </div>
  );
}
