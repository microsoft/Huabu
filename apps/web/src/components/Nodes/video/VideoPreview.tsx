// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import useCanvasStore from '@/store/canvasStore';

import { VideoPlayer } from './VideoPlayer';

import type { PreviewComponentProps } from '../note/NotePreview';

export const VideoPreview = ({ data }: PreviewComponentProps) => {
  const canvasId = useCanvasStore((s) => s.canvasId);

  return (
    <div className="bg-surface flex h-full w-full flex-col p-3">
      <div className="bg-surface relative h-full w-full overflow-hidden rounded">
        <VideoPlayer data={data} canvasId={canvasId} active />
      </div>
    </div>
  );
};
