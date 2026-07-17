// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  BookOpen,
  Clipboard,
  Film,
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
  video: Film,
  audio: Mic,
  web: Globe,
  frame: Frame,
  sketch: Pencil,
  question: MessageCircleQuestionMark,
};
