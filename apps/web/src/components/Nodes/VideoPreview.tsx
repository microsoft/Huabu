import type { PreviewComponentProps } from './NotePreview';

export const VideoPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';

  return (
    <div className="bg-surface flex h-full w-full flex-col p-3">
      <div className="bg-surface relative h-full w-full overflow-hidden rounded">
        {src ? (
          <video
            src={src}
            controls
            className="nodrag h-full w-full object-contain"
          />
        ) : (
          <div className="text-fg-subtle flex h-full w-full items-center justify-center text-sm">
            No Video Source
          </div>
        )}
      </div>
    </div>
  );
};
