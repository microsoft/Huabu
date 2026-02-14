import { ImagePreview } from './ImagePreview';
import { NotePreview } from './NotePreview';
import { PDFPreview } from './PDFPreview';
import { VideoPreview } from './VideoPreview';
import { WebPreview } from './WebPreview';

import type { PreviewComponentProps } from './NotePreview';

export const NodePreviews: Record<
  string,
  React.ComponentType<PreviewComponentProps>
> = {
  note: NotePreview,
  web: WebPreview,
  pdf: PDFPreview,
  image: ImagePreview,
  video: VideoPreview,
};

export type { PreviewComponentProps };
