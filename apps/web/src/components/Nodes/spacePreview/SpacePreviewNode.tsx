// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useStore } from '@xyflow/react';
import { AlertTriangle, PanelsTopLeft, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { NodeWrapper } from '@/components/Nodes/NodeWrapper';
import useCanvasStore from '@/store/canvasStore';
import { useSpacePreviewScene } from '@/store/spacePreviewSceneCache';
import { useWorkspaceStore } from '@/store/workspaceStore';

import { SpacePreviewViewport } from './SpacePreviewViewport';

import type { SpacePreviewNodeData } from '@/components/Nodes/types';
import type { Node, NodeProps } from '@xyflow/react';

export type SpacePreviewNodeType = Node<SpacePreviewNodeData, 'spacePreview'>;

export const SpacePreviewNode = memo(
  ({ id, data, selected }: NodeProps<SpacePreviewNodeType>) => {
    const { t } = useTranslation();
    const hostZoom = useStore((state) => state.transform[2]);
    const navigate = useNavigate();
    const viewportHostRef = useRef<HTMLDivElement>(null);
    const [nearViewport, setNearViewport] = useState(
      () => typeof IntersectionObserver === 'undefined',
    );
    const hostCanvasId = useCanvasStore((state) => state.canvasId);
    const fallbackTitle = useWorkspaceStore(
      (state) => state.spaceTitles[data.targetCanvasId],
    );
    const { scene, loading, stale, error, retry } = useSpacePreviewScene(
      data.targetCanvasId,
      nearViewport,
    );
    const title =
      scene?.title || fallbackTitle || t('spacePreview.untitledSpace');
    const titleFontSize = 14 * Math.min(3, Math.max(1, 1 / hostZoom));
    const openTarget = useCallback(() => {
      navigate(`/canvas/${data.targetCanvasId}`);
    }, [data.targetCanvasId, navigate]);

    useEffect(() => {
      const host = viewportHostRef.current;
      if (!host || typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(
        ([entry]) => setNearViewport(entry?.isIntersecting === true),
        { rootMargin: '300px' },
      );
      observer.observe(host);
      return () => observer.disconnect();
    }, []);

    return (
      <NodeWrapper
        id={id}
        data={data}
        type="spacePreview"
        selected={selected}
        className="bg-surface"
        onDoubleClick={openTarget}
      >
        <div
          ref={viewportHostRef}
          className="flex h-full min-h-0 w-full flex-col"
        >
          <div className="border-edge-default flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <PanelsTopLeft className="text-fg-muted" size={16} />
            <div
              className="text-fg-default min-w-0 flex-1 truncate font-medium"
              style={{ fontSize: titleFontSize }}
            >
              {title}
            </div>
            {stale && (
              <span className="text-warning text-xs">
                {t('spacePreview.stale')}
              </span>
            )}
            {scene?.truncated.nodes || scene?.truncated.edges ? (
              <span className="text-warning text-xs">
                {t('spacePreview.partial')}
              </span>
            ) : null}
            <Button
              className="nodrag"
              variant="ghost"
              size="sm"
              onClick={openTarget}
            >
              {t('spacePreview.openSpace')}
            </Button>
          </div>
          {scene && nearViewport ? (
            <SpacePreviewViewport
              scene={scene}
              hostCanvasId={hostCanvasId}
              previewNodeId={id}
              hostZoom={hostZoom}
            />
          ) : loading || !nearViewport ? (
            <Loading
              layout="block"
              size="sm"
              message={t('spacePreview.loading')}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
              <AlertTriangle className="text-danger" size={24} />
              <div className="text-fg-default text-sm font-medium">
                {t('spacePreview.unavailable')}
              </div>
              <div className="text-fg-subtle text-xs">
                {error?.message ?? t('spacePreview.unavailableDescription')}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={retry}
                className="nodrag"
              >
                <RefreshCw />
                {t('spacePreview.retry')}
              </Button>
            </div>
          )}
        </div>
      </NodeWrapper>
    );
  },
);

SpacePreviewNode.displayName = 'SpacePreviewNode';
