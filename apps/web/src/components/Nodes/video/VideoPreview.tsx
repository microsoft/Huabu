// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Download } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import useCanvasStore from '@/store/canvasStore';
import {
  canDownloadMediaSource,
  triggerMediaDownload,
} from '@/utils/io/nodeDownload';

import { VideoPlayer } from './VideoPlayer';
import { getMissingFileKind } from '../MissingFileBanner';
import { PreviewHeaderButton } from '../PreviewHeaderButton';
import { usePreviewHeaderSlot } from '../PreviewHeaderSlot';

import type { PreviewComponentProps } from '../note/NotePreview';

export const VideoPreview = ({ data }: PreviewComponentProps) => {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((s) => s.canvasId);
  const { el: headerSlotEl } = usePreviewHeaderSlot();
  const src = typeof data.src === 'string' ? data.src : '';
  const rawLabel = typeof data.label === 'string' ? data.label : undefined;
  const isMissing = Boolean(getMissingFileKind(data));
  const canDownload = canDownloadMediaSource(src, isMissing);

  const handleDownload = () => {
    triggerMediaDownload({
      src,
      canvasId,
      label: rawLabel,
      defaultExt: '.mp4',
      fallbackStem: 'video',
      missing: isMissing,
    });
  };

  const headerActions = canDownload ? (
    <PreviewHeaderButton
      title={t('node.download')}
      aria-label={t('node.download')}
      onClick={handleDownload}
    >
      <Download />
    </PreviewHeaderButton>
  ) : null;

  return (
    <div className="bg-surface flex h-full w-full flex-col p-3">
      {headerSlotEl && headerActions
        ? createPortal(headerActions, headerSlotEl)
        : null}
      <div className="bg-surface relative h-full w-full overflow-hidden rounded">
        <VideoPlayer data={data} canvasId={canvasId} active />
      </div>
    </div>
  );
};
