// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FileWarning, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import useCanvasStore from '@/store/canvasStore';

import './MissingFileBanner.css';

export { getMissingFileKind } from './missingFile';
export type { MissingFileKind } from './missingFile';

export interface MissingFileBannerProps {
  /** Node ID — used by the Remove button to delete this node from the canvas. */
  nodeId: string;
}

/**
 * Renders a non-blocking placeholder when a node's backing file (markdown
 * for note/text, artifact for pdf/image/video) has been deleted or
 * renamed outside the app. Always offers a Remove button so the user can
 * clean up the orphaned node with a single click.
 */
export const MissingFileBanner = memo(({ nodeId }: MissingFileBannerProps) => {
  const { t } = useTranslation();
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const title = t('node.nodeFileMissing');
  const description = t('node.fileMissingDescription');

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      deleteNodes([nodeId]);
    },
    [nodeId, deleteNodes],
  );

  return (
    <div
      className="missing-file-banner h-full w-full min-w-0"
      style={{ containerType: 'size' }}
    >
      <div className="missing-file-banner__compact border-warning-light bg-surface text-fg-muted h-full w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border px-2 text-xs">
        <FileWarning className="text-warning h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={description}>
          {title}
        </span>
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          iconOnly
          title={t('node.removeNode')}
          onClick={handleRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="missing-file-banner__full border-warning-light bg-surface text-fg-muted h-full w-full flex-col items-center justify-center gap-3 rounded-md border p-4 text-center">
        <FileWarning className="text-warning h-8 w-8 opacity-80" />
        <div className="flex flex-col gap-1">
          <div className="text-fg-default text-sm font-medium">{title}</div>
          <div className="text-fg-subtle line-clamp-3 text-xs">
            {description}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          tone="danger"
          onClick={handleRemove}
        >
          <Trash2 />
          {t('node.removeFromCanvas')}
        </Button>
      </div>
    </div>
  );
});

MissingFileBanner.displayName = 'MissingFileBanner';
