import {
  BookOpen,
  Clipboard,
  Film,
  FileType2,
  Frame,
  Globe,
  Image as ImageIcon,
  MessageCircleQuestionMark,
  Mic,
  Pencil,
  Type,
} from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

type HandbookNodeType =
  | 'note'
  | 'text'
  | 'image'
  | 'pdf'
  | 'office'
  | 'video'
  | 'audio'
  | 'web'
  | 'frame'
  | 'sketch'
  | 'question';

export const NODE_ICON: Record<HandbookNodeType, LucideIcon> = {
  note: Clipboard,
  text: Type,
  image: ImageIcon,
  pdf: BookOpen,
  office: FileType2,
  video: Film,
  audio: Mic,
  web: Globe,
  frame: Frame,
  sketch: Pencil,
  question: MessageCircleQuestionMark,
};
