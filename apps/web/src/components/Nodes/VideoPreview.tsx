import type { PreviewComponentProps } from './NotePreview';

export const VideoPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';

  return (
    <div className="flex h-full w-full flex-col bg-white p-3">
      <div className="relative h-full w-full overflow-hidden rounded bg-white">
        {src ? (
          <video
            src={src}
            controls
            className="nodrag h-full w-full object-contain"
          />
        ) : (
          <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
            No Video Source
          </div>
        )}
      </div>
    </div>
  );
};
