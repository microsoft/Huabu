import { ImagePreview } from './image/ImagePreview';
import { NotePreview } from './note/NotePreview';
import { PDFPreview } from './pdf/PDFPreview';
import { SketchPreview } from './sketch/SketchPreview';
import { VideoPreview } from './video/VideoPreview';
import { WebPreview } from './web/WebPreview';

import type { PreviewComponentProps } from './note/NotePreview';

export const NodePreviews: Record<
  string,
  React.ComponentType<PreviewComponentProps>
> = {
  note: NotePreview,
  web: WebPreview,
  pdf: PDFPreview,
  image: ImagePreview,
  video: VideoPreview,
  sketch: SketchPreview,
};

export type { PreviewComponentProps };
