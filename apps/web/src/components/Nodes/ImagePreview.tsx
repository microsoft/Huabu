import type { PreviewComponentProps } from './NotePreview';

export const ImagePreview = ({ data }: PreviewComponentProps) => {
  const src = typeof data.src === 'string' ? data.src : '';

  return (
    <div className="flex h-full w-full flex-col bg-white p-3">
      <div className="relative h-full w-full overflow-hidden rounded bg-white">
        {src ? (
          <img
            src={src}
            alt={src || 'Node image'}
            className="pointer-events-none h-full w-full rounded border-0 object-contain"
          />
        ) : (
          <div className="text-muted-foreground flex h-full w-full items-center justify-center text-sm">
            No Image Source
          </div>
        )}
      </div>
    </div>
  );
};
