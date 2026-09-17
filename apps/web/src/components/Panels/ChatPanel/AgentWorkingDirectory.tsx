// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { FolderCog } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { validateAcpWorkingDirectory } from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { Popover } from '@/components/Common/Popover';

import type { AcpThreadRealization } from '@huabu/shared';

interface AgentWorkingDirectoryProps {
  agentletId: string;
  profileWorkingDirPath: string;
  overrideWorkingDirPath?: string;
  realization: AcpThreadRealization;
  readOnly?: boolean;
  disabled?: boolean;
  onChange: (workingDirPath: string | undefined) => void | Promise<void>;
}

export function AgentWorkingDirectory({
  agentletId,
  profileWorkingDirPath,
  overrideWorkingDirPath,
  realization,
  readOnly,
  disabled,
  onChange,
}: AgentWorkingDirectoryProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(overrideWorkingDirPath ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const realized = realization.state === 'realized' || readOnly === true;
  const effectivePath =
    realization.state === 'realized'
      ? (realization.workingDirPath ?? profileWorkingDirPath)
      : (overrideWorkingDirPath ?? profileWorkingDirPath);

  useEffect(() => {
    if (!open) setDraft(overrideWorkingDirPath ?? '');
  }, [open, overrideWorkingDirPath]);

  const apply = useCallback(async () => {
    const next = draft.trim();
    setSaving(true);
    setError(null);
    try {
      if (next) {
        const result = await validateAcpWorkingDirectory({
          agentletId,
          workingDirPath: next,
        });
        if (!result.valid) {
          setError(result.error?.message ?? t('chat.workingDirectoryInvalid'));
          return;
        }
      }
      await onChange(next || undefined);
      setOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('chat.workingDirectoryValidationFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, [agentletId, draft, onChange, t]);

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        tone="neutral"
        size="sm"
        iconOnly
        disabled={disabled}
        title={t('chat.workingDirectoryTitle', { path: effectivePath })}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderCog />
      </Button>
      {open && triggerRef.current && (
        <Popover
          position={{
            x: triggerRef.current.getBoundingClientRect().left,
            y: triggerRef.current.getBoundingClientRect().top,
          }}
          onDismiss={() => setOpen(false)}
          anchor="bottom-left"
          offset={{ x: 0, y: -4 }}
          className="w-[min(28rem,calc(100vw-1rem))] p-3"
        >
          <div className="text-fg-default mb-1 text-xs font-medium">
            {t('chat.workingDirectory')}
          </div>
          <div className="text-fg-muted mb-2 truncate font-mono text-[11px]">
            {effectivePath}
          </div>
          {realized ? (
            <div className="text-fg-subtle text-xs">
              {t('chat.workingDirectoryRealized')}
            </div>
          ) : (
            <>
              <PathInput
                value={draft}
                onChange={setDraft}
                disabled={saving}
                pickerEnabled={false}
                size="sm"
                mono
                placeholder={profileWorkingDirPath}
                ariaLabel={t('chat.workingDirectory')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void apply();
                  }
                }}
              />
              {error && (
                <div role="alert" className="text-danger mt-2 text-xs">
                  {error}
                </div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setDraft('');
                    setError(null);
                  }}
                >
                  {t('chat.useProfileDirectory')}
                </Button>
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => void apply()}
                >
                  {t('actions.apply')}
                </Button>
              </div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
