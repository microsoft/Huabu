// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, ChevronDown, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
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
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const percentage = Math.round(zoom.scale * 100);

  const run = (action: () => void) => {
    action();
    setOpen(false);
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
        trigger={
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            title={t('node.pdfZoom')}
            tooltipPlacement="bottom"
            tooltipWrapperClassName="flex"
            aria-label={t('node.pdfZoomMenu', { percentage })}
            aria-haspopup="menu"
            className={`${FOCUS_CLASS} h-6 w-14 gap-0.5 px-1 py-0 text-[11px] tabular-nums`}
          >
            <span>
              {disabled || zoom.scale <= 0 ? '\u2014' : `${percentage}%`}
            </span>
            <ChevronDown aria-hidden="true" className="h-2.5! w-2.5!" />
          </Button>
        }
      >
        <div className="min-w-40">
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
