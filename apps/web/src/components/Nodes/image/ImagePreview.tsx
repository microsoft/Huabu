// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, Download } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import { toast } from '@/components/Common/Toast';
import { PreviewHeaderButton } from '@/components/Nodes/PreviewHeaderButton';
import { usePreviewHeaderSlot } from '@/components/Nodes/PreviewHeaderSlot';
import useCanvasStore from '@/store/canvasStore';
import { copyImageToClipboard } from '@/utils/io/clipboard';
import {
  canDownloadMediaSource,
  triggerMediaDownload,
} from '@/utils/io/nodeDownload';

import { getMissingFileKind } from '../MissingFileBanner';

import type { PreviewComponentProps } from '../note/NotePreview';

export const ImagePreview = ({ data }: PreviewComponentProps) => {
  const { t } = useTranslation();
  const src = typeof data.src === 'string' ? data.src : '';
  const rawLabel = typeof data.label === 'string' ? data.label : undefined;
  const label =
    rawLabel && rawLabel.trim().length > 0
      ? rawLabel.trim()
      : t('node.nodeImage');
  const canvasId = useCanvasStore((s) => s.canvasId);
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const resolvedSrc = src ? resolveArtifactUrl(src, canvasId) : '';
  const isMissing = Boolean(getMissingFileKind(data));
  const canDownload = canDownloadMediaSource(src, isMissing);

  const downloadImage = () => {
    triggerMediaDownload({
      src,
      canvasId,
      label: rawLabel,
      defaultExt: '.png',
      fallbackStem: 'image',
      missing: isMissing,
    });
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
          action: canDownload
            ? {
                label: t('node.downloadImage'),
                onClick: downloadImage,
              }
            : undefined,
        });
      });
  };

  const headerActions = src ? (
    <>
      <PreviewHeaderButton
        title={t('node.copyImage')}
        aria-label={t('node.copyImage')}
        onClick={copyImage}
      >
        <Copy />
      </PreviewHeaderButton>
      {canDownload ? (
        <PreviewHeaderButton
          title={t('node.downloadImage')}
          aria-label={t('node.downloadImage')}
          onClick={downloadImage}
        >
          <Download />
        </PreviewHeaderButton>
      ) : null}
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
