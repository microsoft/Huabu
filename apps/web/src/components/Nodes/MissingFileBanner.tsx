// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import useCanvasStore from '@/store/canvasStore';

import { NodeNotice } from './NodeNotice';

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

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      deleteNodes([nodeId]);
    },
    [nodeId, deleteNodes],
  );

  return (
    <NodeNotice
      className="missing-file-banner rounded-md"
      tone="warning"
      title={t('node.nodeFileMissing')}
      description={t('node.fileMissingDescription')}
      actions={[
        {
          label: t('node.removeFromCanvas'),
          icon: Trash2,
          tone: 'danger',
          onClick: handleRemove,
        },
      ]}
    />
  );
});

MissingFileBanner.displayName = 'MissingFileBanner';
