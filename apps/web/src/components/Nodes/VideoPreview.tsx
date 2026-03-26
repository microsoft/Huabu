import type { PreviewComponentProps } from './NotePreview';

export const VideoPreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';

  return (
    <div className="bg-card flex h-full w-full flex-col p-3">
      <div className="bg-card relative h-full w-full overflow-hidden rounded">
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
