// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveArtifactUrl } from '@/api/artifact';
import useCanvasStore from '@/store/canvasStore';

import type { PreviewComponentProps } from '../note/NotePreview';

export const VideoPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  const canvasId = useCanvasStore((s) => s.canvasId);

  return (
    <div className="bg-surface flex h-full w-full flex-col p-3">
      <div className="bg-surface relative h-full w-full overflow-hidden rounded">
        {src ? (
          <video
            src={resolveArtifactUrl(src, canvasId)}
            controls
            className="nodrag h-full w-full object-contain"
          >
            {/* User-supplied video has no caption source. */}
            <track kind="captions" />
          </video>
        ) : (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            No Video Source
          </div>
        )}
      </div>
    </div>
  );
};
