// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Copy, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { NODE_ICON } from '@/config/nodeIcons';

interface FragmentSelectionActionsProps {
  onCopy: () => Promise<void>;
  onSaveAsNote: () => void;
  onComment: () => void;
  onCopied: () => void;
  saveAsNoteDisabled?: boolean;
  saveAsNoteTitle?: string;
}

export function FragmentSelectionActions({
  onCopy,
  onSaveAsNote,
  onComment,
  onCopied,
  saveAsNoteDisabled = false,
  saveAsNoteTitle,
}: FragmentSelectionActionsProps) {
  const { t } = useTranslation();
  const [copyError, setCopyError] = useState(false);
  const [copying, setCopying] = useState(false);
  const NoteIcon = NODE_ICON.note;
  return (
    <div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={t('messages.copy')}
          disabled={copying}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setCopyError(false);
            setCopying(true);
            void onCopy()
              .then(onCopied)
              .catch(() => setCopyError(true))
              .finally(() => setCopying(false));
          }}
        >
          <Copy />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={saveAsNoteTitle ?? t('messages.addAsNote')}
          disabled={copying || saveAsNoteDisabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onSaveAsNote}
        >
          <NoteIcon />
        </Button>
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          title={t('messages.fragmentComment')}
          disabled={copying}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onComment}
        >
          <MessageSquare />
        </Button>
      </div>
      {copyError ? (
        <p role="alert" className="text-danger px-2 py-1 text-xs">
          {t('messages.fragmentCopyFailed')}
        </p>
      ) : null}
    </div>
  );
}
