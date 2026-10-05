// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Folder } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { Popover } from '@/components/Common/Popover';
import { TextInput } from '@/components/Common/TextInput';

interface WorkingDirectoryOverrideProps {
  profileAlias: string;
  profileWorkingDirPath: string;
  workingDirPath?: string;
  editable: boolean;
  saving: boolean;
  onSave: (workingDirPath: string | null) => Promise<void>;
}

export function WorkingDirectoryOverride({
  profileAlias,
  profileWorkingDirPath,
  workingDirPath,
  editable,
  saving,
  onSave,
}: WorkingDirectoryOverrideProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState(workingDirPath ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(workingDirPath ?? '');
    setError(null);
  }, [workingDirPath]);

  if (!editable && !workingDirPath) return null;

  const hasOverride = Boolean(workingDirPath);
  const effectivePath = workingDirPath ?? profileWorkingDirPath;
  const triggerTitle = hasOverride
    ? t('chat.workingDirectoryOverrideActive', { path: workingDirPath })
    : t('chat.workingDirectoryOverrideInherited', {
        path: profileWorkingDirPath,
      });

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

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        tone={hasOverride ? 'info' : 'neutral'}
        size="sm"
        iconOnly
        title={triggerTitle}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className={cn('relative', isOpen && 'bg-hover')}
      >
        <Folder />
        {hasOverride ? (
          <span className="bg-info border-bg-default absolute right-0.5 bottom-0.5 h-1.5 w-1.5 rounded-full border" />
        ) : null}
      </Button>
      {isOpen ? (
        <Popover
          reference={triggerRef.current}
          placement="top-start"
          onDismiss={() => setIsOpen(false)}
          onOpenAutoFocus={() => inputRef.current?.focus()}
          className="w-[min(24rem,var(--popover-available-width))] p-3"
        >
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-fg-default text-sm font-medium">
                {t('chat.workingDirectoryOverride')}
              </div>
              <div className="text-fg-subtle mt-0.5 text-xs">
                {editable
                  ? t('chat.workingDirectoryOverrideDescription')
                  : t('chat.workingDirectoryNodeOnlyLocked')}
              </div>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-fg-subtle">
                {t('chat.workingDirectoryProfile')}
              </dt>
              <dd className="text-fg-default truncate">{profileAlias}</dd>
              {profileWorkingDirPath ? (
                <>
                  <dt className="text-fg-subtle">
                    {t('chat.workingDirectoryProfileDefault')}
                  </dt>
                  <dd className="text-fg-muted truncate font-mono">
                    {profileWorkingDirPath}
                  </dd>
                </>
              ) : null}
              <dt className="text-fg-subtle">
                {t('chat.workingDirectoryEffective')}
              </dt>
              <dd className="text-fg-muted truncate font-mono">
                {effectivePath}
              </dd>
            </dl>
            {editable ? (
              <div>
                <label className="text-fg-muted mb-1 block text-xs font-medium">
                  {t('chat.workingDirectoryNodeOverride')}
                </label>
                <TextInput
                  ref={inputRef}
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
                    }
                  }}
                  placeholder={profileWorkingDirPath}
                  aria-label={t('chat.workingDirectoryNodeOverride')}
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
                {error ? (
                  <div role="alert" className="text-danger mt-1 text-[10px]">
                    {error}
                  </div>
                ) : null}
                {workingDirPath ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setDraft('');
                      void onSave(null).catch((saveError) => {
                        setError(
                          saveError instanceof Error
                            ? saveError.message
                            : t('chat.workingDirectoryOverrideSaveFailed'),
                        );
                      });
                    }}
                    className="mt-2"
                  >
                    {t('chat.workingDirectoryRestoreInheritance')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
