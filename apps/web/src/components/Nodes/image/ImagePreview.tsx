// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, Download } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { Button } from '@/components/Common/Button';
import { toast } from '@/components/Common/Toast';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import useCanvasStore from '@/store/canvasStore';
import { copyImageToClipboard } from '@/utils/io/clipboard';

import type { PreviewComponentProps } from '../note/NotePreview';

export const ImagePreview = ({ data }: PreviewComponentProps) => {
  const { t } = useTranslation();
  const src = typeof data.src === 'string' ? data.src : '';
  const label =
    typeof data.label === 'string' && data.label.trim().length > 0
      ? data.label.trim()
      : t('node.nodeImage');
  const canvasId = useCanvasStore((s) => s.canvasId);
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const resolvedSrc = src ? resolveArtifactUrl(src, canvasId) : '';

  const downloadImage = () => {
    if (!resolvedSrc) return;
    const link = document.createElement('a');
    link.href = resolvedSrc;
    link.download = label;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const copyImage = () => {
    if (!resolvedSrc) return;
    void copyImageToClipboard(resolvedSrc)
      .then(() => {
        toast(t('node.imageCopied'), { tone: 'success' });
      })
      .catch((error: unknown) => {
        console.error('[clipboard] explicit image copy failed', error);
        toast(t('node.copyImageFailed'), {
          tone: 'danger',
          action: {
            label: t('node.downloadImage'),
            onClick: downloadImage,
          },
        });
      });
  };

  const headerActions = src ? (
    <>
      <Button
        variant="ghost"
        tone="neutral"
        size="sm"
        iconOnly
        title={t('node.copyImage')}
        tooltipPlacement="bottom"
        aria-label={t('node.copyImage')}
        onClick={copyImage}
      >
        <Copy />
      </Button>
      <Button
        variant="ghost"
        tone="neutral"
        size="sm"
        iconOnly
        title={t('node.downloadImage')}
        tooltipPlacement="bottom"
        aria-label={t('node.downloadImage')}
        onClick={downloadImage}
      >
        <Download />
      </Button>
    </>
  ) : null;

  return (
    <div className="bg-surface flex h-full w-full flex-col p-3">
      {headerSlotEl && headerActions
        ? createPortal(headerActions, headerSlotEl)
        : null}
      <div className="bg-surface relative h-full w-full overflow-hidden rounded">
        {src ? (
          <img
            src={resolvedSrc}
            alt={label}
            className="pointer-events-none h-full w-full rounded border-0 object-contain"
          />
        ) : (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            {t('node.noImageSource')}
          </div>
        )}
      </div>
    </div>
  );
};
