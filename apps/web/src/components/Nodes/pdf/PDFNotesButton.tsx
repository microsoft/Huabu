// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { FloatingToolbar } from '@/components/Common/FloatingToolbar';
import { toast } from '@/components/Common/Toast';
import { NODE_ICON } from '@/config/nodeIcons';
import { openPdfNotes } from '@/store/previewWorkspace/actions';

import { PreviewHeaderButton } from '../PreviewHeaderButton';

import type { MouseEvent } from 'react';

const NoteIcon = NODE_ICON.note;

export function PDFNotesButton({
  id,
  surface = 'preview',
  noteNodeId,
}: {
  id: string;
  surface?: 'canvas' | 'preview';
  noteNodeId?: string;
}) {
  const { t } = useTranslation();
  const label = t('node.pdfNotes');
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      openPdfNotes(id);
    } catch (error) {
      console.error('[PDF notes] Could not open notes', error);
      toast(error instanceof Error ? error.message : String(error), {
        tone: 'danger',
      });
    }
  };

  if (surface === 'canvas') {
    return (
      <FloatingToolbar.ActionButton title={label} onClick={onClick}>
        <NoteIcon />
      </FloatingToolbar.ActionButton>
    );
  }
  // Preview header: always reachable, even while the properties are collapsed.
  return (
    <PreviewHeaderButton
      title={t(noteNodeId ? 'node.openPdfNotes' : 'node.addPdfNotes')}
      onClick={onClick}
    >
      <NoteIcon />
    </PreviewHeaderButton>
  );
}
