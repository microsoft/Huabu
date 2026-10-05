// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TextInput } from '@/components/Common/TextInput';

interface WorkingDirectoryOverrideProps {
  profileWorkingDirPath: string;
  workingDirPath?: string;
  editable: boolean;
  saving: boolean;
  onSave: (workingDirPath: string | null) => Promise<void>;
}

export function WorkingDirectoryOverride({
  profileWorkingDirPath,
  workingDirPath,
  editable,
  saving,
  onSave,
}: WorkingDirectoryOverrideProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(workingDirPath ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(workingDirPath ?? '');
    setError(null);
  }, [workingDirPath]);

  if (!editable && !workingDirPath) return null;

  const commit = async () => {
    const trimmed = draft.trim();
    if (trimmed === (workingDirPath ?? '')) return;
    setError(null);
    try {
      await onSave(trimmed || null);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('chat.workingDirectoryOverrideSaveFailed'),
      );
    }
  };

  if (!editable) {
    return (
      <div className="border-edge-default mt-1 border-t pt-1.5">
        <div className="text-fg-subtle text-[10px]">
          {t('chat.workingDirectoryOverride')}
        </div>
        <div className="text-fg-muted truncate font-mono text-xs">
          {workingDirPath}
        </div>
        <div className="text-fg-subtle text-[10px]">
          {t('chat.workingDirectoryNodeOnlyLocked')}
        </div>
      </div>
    );
  }

  return (
    <div className="border-edge-default mt-1 border-t pt-1.5">
      <label className="text-fg-muted mb-1 block text-[10px] font-medium">
        {t('chat.workingDirectoryOverride')}
      </label>
      <TextInput
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(workingDirPath ?? '');
            setError(null);
            event.currentTarget.blur();
          }
        }}
        placeholder={profileWorkingDirPath}
        aria-label={t('chat.workingDirectoryOverride')}
        mono
        disabled={saving}
        className="w-full"
      />
      <div className="text-fg-subtle mt-1 text-[10px]">
        {draft.trim()
          ? t('chat.workingDirectoryNodeOnly')
          : t('chat.workingDirectoryInherited', {
              path: profileWorkingDirPath,
            })}
      </div>
      {error && (
        <div role="alert" className="text-danger mt-1 text-[10px]">
          {error}
        </div>
      )}
    </div>
  );
}
