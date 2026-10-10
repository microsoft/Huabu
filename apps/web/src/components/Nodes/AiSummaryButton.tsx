// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Sparkles, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Popover } from '@/components/Common/Popover';

import { PreviewHeaderButton } from './PreviewHeaderButton';
import { usePreviewHeaderSlot } from './PreviewHeaderSlot';

interface AiSummaryButtonProps {
  summary?: string | null;
  keywords?: string[] | null;
}

/** Opens summary metadata without adding a row or resizing the document. */
export const AiSummaryButton = ({
  summary,
  keywords,
}: AiSummaryButtonProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { leadingEl } = usePreviewHeaderSlot();

  const hasSummary = typeof summary === 'string' && summary.trim().length > 0;
  const visibleKeywords = Array.isArray(keywords) ? keywords : [];
  const hasKeywords = visibleKeywords.length > 0;
  if ((!hasSummary && !hasKeywords) || leadingEl === null) return null;

  const trigger = (
    <PreviewHeaderButton
      ref={triggerRef}
      title={t('node.aiSummary')}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={open ? 'bg-bg-default text-info' : undefined}
      onClick={() => setOpen(!open)}
    >
      <Sparkles />
    </PreviewHeaderButton>
  );

  return (
    <>
      {leadingEl ? createPortal(trigger, leadingEl) : trigger}
      {open && (
        <Popover
          reference={triggerRef.current}
          placement="bottom-start"
          className="w-80 max-w-[calc(100vw-24px)] p-4"
          onOpenAutoFocus={() =>
            closeRef.current?.focus({ preventScroll: true })
          }
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === 'escape')
              triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          <div
            role="dialog"
            aria-label={t('node.aiSummary')}
            className="flex max-h-[min(60vh,28rem)] flex-col gap-3 overflow-y-auto"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-fg-default text-sm font-medium">
                {t('node.aiSummary')}
              </span>
              <Button
                ref={closeRef}
                variant="ghost"
                iconOnly
                size="sm"
                title={t('node.closeAiSummary')}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus({ preventScroll: true });
                }}
              >
                <X size={13} />
              </Button>
            </div>
            {hasSummary && (
              <p className="text-fg-default text-sm leading-relaxed">
                {summary}
              </p>
            )}
            {hasKeywords && (
              <div className="flex flex-wrap gap-1.5">
                {visibleKeywords.map((kw) => (
                  <span
                    key={kw}
                    className="bg-hover text-fg-muted rounded-full px-2 py-0.5 text-xs"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Popover>
      )}
    </>
  );
};
