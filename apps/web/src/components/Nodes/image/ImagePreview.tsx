import type { PreviewComponentProps } from '../note/NotePreview';

import { resolveArtifactUrl } from '@/api/artifact';
import useCanvasStore from '@/store/canvasStore';

export const ImagePreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';
  const canvasId = useCanvasStore((s) => s.canvasId);

  return (
    <div className="bg-surface flex h-full w-full flex-col p-3">
      <div className="bg-surface relative h-full w-full overflow-hidden rounded">
        {src ? (
          <img
            src={resolveArtifactUrl(src, canvasId)}
            alt={src || 'Node image'}
            className="pointer-events-none h-full w-full rounded border-0 object-contain"
          />
        ) : (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            No Image Source
          </div>
        )}
      </div>
    </div>
  );
};
