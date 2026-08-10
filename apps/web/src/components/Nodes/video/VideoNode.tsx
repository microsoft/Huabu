// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PlayCircle, Fullscreen, Play } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';
import useCanvasStore from '@/store/canvasStore.ts';
import { openPreviewNode } from '@/store/previewWorkspace/actions';

import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import {
  getMissingFileKind,
  MissingFileBanner,
} from '../MissingFileBanner.tsx';
import { NodeWrapper } from '../NodeWrapper.tsx';

import type { CanvasVideoNodeData } from '../types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type VideoNodeType = Node<CanvasVideoNodeData, 'video'>;

export const VideoNode = memo(
  ({ id, data, selected }: NodeProps<VideoNodeType>) => {
    const { t } = useTranslation();
    const canvasId = useCanvasStore((s) => s.canvasId);
    const missingFileKind = getMissingFileKind(data);

    const VideoActions = (
      <FloatingToolbar.ActionButton
        title={t('node.openLargeView')}
        onClick={(e) => {
          e.stopPropagation();
          openPreviewNode(id);
        }}
      >
        <Fullscreen />
      </FloatingToolbar.ActionButton>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'video'}
        selected={selected}
        actions={missingFileKind ? undefined : VideoActions}
        keepAspectRatio={true}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="bg-fg-default/5 group flex h-full flex-col justify-center rounded-lg border-0">
            <div className="relative h-full w-full overflow-hidden rounded-lg">
              {data?.src ? (
                <>
                  <video
                    src={resolveArtifactUrl(data.src, canvasId)}
                    className="pointer-events-none h-full w-full object-contain select-none"
                    preload="metadata"
                    muted
                  />
                  <div className="bg-inverse/10 group-hover:bg-inverse/20 pointer-events-none absolute inset-0 flex items-center justify-center transition-colors">
                    <div className="bg-inverse/40 rounded-full p-3 backdrop-blur-sm transition-transform group-hover:scale-110">
                      <Play
                        className="fill-fg-inverse text-fg-inverse"
                        size={24}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-fg-subtle flex h-full w-full flex-col items-center justify-center gap-2 text-sm">
                  <PlayCircle size={24} className="opacity-20" />
                  <span>{t('node.noVideoSource')}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </NodeWrapper>
    );
  },
);
