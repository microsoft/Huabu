// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Fullscreen, Play } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useNodePresentation } from '@/hooks/useNodePresentation';
import useCanvasStore from '@/store/canvasStore.ts';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import {
  selectIsNodeOpen,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';

import { Button } from '../../Common/Button';
import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import { useFrameSuppressed } from '../frame/FrameZoomContext';
import {
  getMissingFileKind,
  MissingFileBanner,
} from '../MissingFileBanner.tsx';
import { NodeWrapper } from '../NodeWrapper.tsx';
import { canPlayVideoInline } from './videoInteraction';
import { VideoPlayer } from './VideoPlayer';
import { selectSelectedCount } from '../shared/selectedCount';

import type { CanvasVideoNodeData } from '../types.ts';
import type { Node, NodeProps } from '@xyflow/react';

export type VideoNodeType = Node<CanvasVideoNodeData, 'video'>;

export const VideoNode = memo(
  ({ id, data, selected }: NodeProps<VideoNodeType>) => {
    const { t } = useTranslation();
    const canvasId = useCanvasStore((s) => s.canvasId);
    const missingFileKind = getMissingFileKind(data);
    const presentation = useNodePresentation(id, 'video', 'none');
    const previewOpen = usePreviewWorkspaceStore(
      (s) => s.canvasId === canvasId && selectIsNodeOpen(s, id),
    );
    const frameSuppressed = useFrameSuppressed(id);
    const available =
      !missingFileKind &&
      canPlayVideoInline({
        ...presentation,
        isSoleSelected: true,
        previewOpen,
        frameSuppressed,
      });

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
          <InlineVideoSurface
            key={`${canvasId}:${data.src}`}
            id={id}
            data={data}
            canvasId={canvasId}
            available={available}
          />
        )}
      </NodeWrapper>
    );
  },
);

/** Only the active native player counter-scales; poster controls scale with the node. */
function InlineVideoSurface({
  id,
  data,
  canvasId,
  available,
}: {
  id: string;
  data: CanvasVideoNodeData;
  canvasId: string;
  available: boolean;
}) {
  const { t } = useTranslation();
  const selectNodes = useCanvasStore((s) => s.selectNodes);
  // Read canonical selection here, not React Flow's one-render-later mirror.
  const isSoleSelected = useCanvasStore(
    (s) =>
      s.nodes.some((node) => node.id === id && node.selected) &&
      selectSelectedCount(s.nodes) === 1,
  );
  const eligible = available && isSoleSelected;
  const [activated, setActivated] = useState(false);
  const [failed, setFailed] = useState(false);
  // Forget intent in the invalidating render, never an effect holding stale selection.
  if (activated && !eligible) setActivated(false);
  const active = activated && eligible;
  const offerPlay = available && !!data.src;
  const { zoom } = useNodePresentation(id, 'video', active ? 'always' : 'none');
  const playbackFailed = useCallback(() => {
    setActivated(false);
    setFailed(true);
  }, []);
  const stop = (event: React.SyntheticEvent) => {
    if (active) event.stopPropagation();
  };
  return (
    // Native media descendants own interaction; this group only stops canvas bubbling.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={data.label || 'Video'}
      data-video-controls={active}
      className={
        active
          ? 'nodrag nopan nowheel h-full w-full rounded-[inherit]'
          : 'relative h-full w-full rounded-[inherit]'
      }
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') stop(event);
      }}
      onKeyUp={stop}
      onWheel={stop}
      style={
        active
          ? {
              transform: `scale(${1 / zoom})`,
              transformOrigin: 'top left',
              width: `${zoom * 100}%`,
              height: `${zoom * 100}%`,
              // The player counter-scales; its clip must still match the shell.
              borderRadius: `calc(var(--node-inner-radius) * ${zoom})`,
            }
          : undefined
      }
    >
      <VideoPlayer
        data={data}
        canvasId={canvasId}
        active={active}
        startPlayback={active}
        onPlaybackError={playbackFailed}
        placeholder={offerPlay ? 'empty' : 'glyph'}
      />
      {!active && offerPlay && (
        <div
          className="bg-inverse/20 pointer-events-none absolute inset-0 flex items-center justify-center"
          data-video-play-overlay
        >
          <div className="flex flex-col items-center gap-2">
            <Button
              iconOnly
              shape="pill"
              size="lg"
              aria-label={t('node.playVideo')}
              className="nodrag nopan nowheel pointer-events-auto h-12 w-12"
              data-video-controls="true"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') event.stopPropagation();
              }}
              onKeyUp={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                selectNodes([id]);
                setFailed(false);
                setActivated(true);
              }}
            >
              <Play aria-hidden fill="currentColor" />
            </Button>
            {failed && (
              <span
                role="status"
                className="bg-surface text-fg-default rounded px-2 py-1 text-xs"
              >
                {t('node.videoPlaybackFailed')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
