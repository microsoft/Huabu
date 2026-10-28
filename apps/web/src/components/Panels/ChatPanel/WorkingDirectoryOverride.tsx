// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Folder, Lock, Monitor } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { cn } from '@/components/Common/cn';
import { FolderPickerButton } from '@/components/Common/FolderPickerButton';
import { Popover } from '@/components/Common/Popover';
import { TextArea } from '@/components/Common/TextArea';
import { Tooltip } from '@/components/Common/Tooltip';
import { useAgentletFolderPicker } from '@/hooks/useAgentletFolderPicker';
import { useAutoSizeTextArea } from '@/hooks/useAutoSizeTextArea';
import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';

interface WorkingDirectoryOverrideProps {
  agentletId?: string;
  deviceName?: string;
  profileWorkingDirPath: string;
  workingDirPath?: string;
  effectiveWorkingDirPath?: string | null;
  directorySource?: 'override' | 'profile' | 'unknown';
  editable: boolean;
  saving: boolean;
  onSave: (workingDirPath: string | null) => Promise<void>;
}

export function WorkingDirectoryOverride({
  agentletId,
  deviceName,
  profileWorkingDirPath,
  workingDirPath,
  effectiveWorkingDirPath,
  directorySource,
  editable,
  saving,
  onSave,
}: WorkingDirectoryOverrideProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const saveInFlight = useRef(false);
  const headingId = useId();
  const errorId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hasOverride =
    (directorySource ?? (workingDirPath ? 'override' : 'profile')) ===
    'override';
  const effectivePath =
    effectiveWorkingDirPath === undefined
      ? (workingDirPath ?? profileWorkingDirPath)
      : (effectiveWorkingDirPath ?? '');
  const displayedPath = effectivePath || t('chat.workingDirectoryUnspecified');
  const busy = saving || pending || picking;
  const pickerSupported = useAgentletFolderPicker(agentletId ?? '');
  const showPickerSlot = (pickerSupported && editable) || picking;
  const fieldValue = isEditing ? draft : displayedPath;
  const lockDescription = t(
    effectiveWorkingDirPath === undefined
      ? 'chat.workingDirectoryUnavailable'
      : 'chat.workingDirectoryConversationLocked',
  );
  useAutoSizeTextArea(inputRef, fieldValue, isOpen);

  useEffect(() => {
    setDraft(effectivePath);
    setIsEditing(false);
    setError(null);
  }, [effectivePath, workingDirPath]);

  useEffect(() => {
    if (!editable && !busy) {
      setIsEditing(false);
    }
  }, [editable, busy]);

  const cancel = () => {
    setDraft(effectivePath);
    setIsEditing(false);
    setError(null);
    editRef.current?.focus({ preventScroll: true });
  };

  const dismiss = () => {
    if (busy) return;
    cancel();
    setIsOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const commit = async (value: string | null) => {
    if (busy || saveInFlight.current || !editable) return;
    if (value?.includes('\n') || value?.includes('\r')) {
      setError(t('chat.workingDirectorySinglePath'));
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (
      (value === null && !workingDirPath) ||
      (value !== null && value === effectivePath)
    ) {
      cancel();
      return;
    }
    saveInFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onSave(value);
      setIsEditing(false);
      editRef.current?.focus({ preventScroll: true });
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('chat.workingDirectoryOverrideSaveFailed'),
      );
    } finally {
      saveInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <>
      <Tooltip content={t('chat.workingDirectory')}>
        <Button
          ref={triggerRef}
          variant="ghost"
          tone={hasOverride ? 'info' : 'neutral'}
          size="sm"
          iconOnly
          aria-label={t('chat.workingDirectoryLabel', { path: displayedPath })}
          aria-expanded={isOpen}
          disabled={busy}
          onClick={() => {
            if (isOpen) dismiss();
            else {
              setDraft(effectivePath);
              setIsEditing(false);
              setError(null);
              setIsOpen(true);
            }
          }}
          className={cn('relative', isOpen && 'bg-hover')}
        >
          <Folder />
          {hasOverride ? (
            <span className="bg-info border-bg-default absolute right-0.5 bottom-0.5 h-1.5 w-1.5 rounded-full border" />
          ) : null}
        </Button>
      </Tooltip>
      {isOpen ? (
        <Popover
          reference={triggerRef.current}
          placement="top-start"
          onDismiss={(reason) => {
            if (reason === 'escape' && isEditing) cancel();
            else dismiss();
          }}
          dismissOnEscape={!busy}
          onOpenAutoFocus={() =>
            inputRef.current?.focus({ preventScroll: true })
          }
          className="w-[min(22rem,var(--popover-available-width))] p-3"
        >
          <form
            className="@container"
            aria-labelledby={headingId}
            onSubmit={(event) => {
              event.preventDefault();
              void commit(draft.trim() || null);
            }}
          >
            <div className="flex min-h-6 flex-col items-start gap-1 @min-[18rem]:flex-row @min-[18rem]:items-center @min-[18rem]:gap-2">
              <div
                id={headingId}
                className="text-fg-muted text-xs whitespace-nowrap"
              >
                {t('chat.workingDirectory')}
              </div>
              {editable || busy ? (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    title={
                      isEditing
                        ? t('chat.workingDirectoryUseDefault')
                        : undefined
                    }
                    aria-label={t('chat.workingDirectoryUseDefault')}
                    disabled={busy}
                    tabIndex={isEditing ? undefined : -1}
                    className={cn('px-1', !isEditing && 'invisible')}
                    onClick={() => void commit(null)}
                  >
                    {t('chat.workingDirectoryDefault')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={isEditing ? t('actions.cancel') : undefined}
                    aria-label={t('actions.cancel')}
                    disabled={busy}
                    tabIndex={isEditing ? undefined : -1}
                    className={cn('px-1', !isEditing && 'invisible')}
                    onClick={cancel}
                  >
                    {t('actions.cancel')}
                  </Button>
                  <Button
                    ref={editRef}
                    variant="ghost"
                    size="sm"
                    aria-label={t(
                      isEditing
                        ? 'chat.workingDirectoryDone'
                        : 'chat.workingDirectoryChange',
                    )}
                    disabled={busy}
                    className="px-1"
                    onClick={() => {
                      if (isEditing) void commit(draft.trim() || null);
                      else {
                        setDraft(effectivePath);
                        setError(null);
                        setIsEditing(true);
                        inputRef.current?.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <span className="inline-grid">
                      <span
                        className={cn(
                          '[grid-area:1/1]',
                          isEditing && 'invisible',
                        )}
                      >
                        {t('chat.workingDirectoryChange')}
                      </span>
                      <span
                        className={cn(
                          '[grid-area:1/1]',
                          !isEditing && 'invisible',
                        )}
                      >
                        {t('chat.workingDirectoryDone')}
                      </span>
                    </span>
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  title={lockDescription}
                  className="text-fg-subtle ml-auto"
                >
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
            </div>
            <div className="mt-2">
              <div
                className={cn(
                  'flex items-start gap-1.5',
                  showPickerSlot && 'min-h-6',
                )}
              >
                <TextArea
                  ref={inputRef}
                  rows={1}
                  value={fieldValue}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229)
                      return;
                    if (event.key === 'Enter' && isEditing) {
                      event.preventDefault();
                      event.stopPropagation();
                      void commit(draft.trim() || null);
                    }
                  }}
                  placeholder={profileWorkingDirPath}
                  aria-label={t('chat.workingDirectory')}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  mono
                  readOnly={!isEditing || busy}
                  className={cn(
                    'text-fg-default block min-h-[1lh] w-full min-w-0 flex-1 resize-none overflow-hidden rounded-sm border-0 bg-transparent p-0 leading-5.25 wrap-anywhere focus:ring-0',
                    isEditing &&
                      'ring-edge-default focus:ring-info-light ring-1 focus:ring-1',
                  )}
                />
                {showPickerSlot ? (
                  <div className="flex w-6 shrink-0">
                    <FolderPickerButton
                      targetAgentletId={agentletId ?? ''}
                      enabled={isEditing && editable}
                      disabled={busy}
                      onPickingChange={setPicking}
                      onError={setError}
                      onPicked={(path) => {
                        setDraft(path);
                        setError(null);
                        inputRef.current?.focus({ preventScroll: true });
                      }}
                    />
                  </div>
                ) : null}
              </div>
              {error ? (
                <div
                  id={errorId}
                  role="alert"
                  className="text-danger mt-1 text-xs"
                >
                  {error}
                </div>
              ) : null}
            </div>
            <div className="border-edge-default mt-3 flex items-start gap-1.5 border-t pt-2 text-xs">
              <Monitor
                className="text-fg-subtle mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              <span className="text-fg-muted shrink-0">
                {t('chat.workingDirectoryDevice')}
              </span>
              <span className="text-fg-muted min-w-0 wrap-anywhere">
                {deviceName ?? t('chat.workingDirectoryDeviceUnknown')}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={!agentletId || !effectivePath || busy || isEditing}
              onClick={() => {
                const canvasId = useCanvasStore.getState().canvasId;
                if (!canvasId || !agentletId || !effectivePath) return;
                usePanelStore
                  .getState()
                  .openFiles({ canvasId, agentletId, path: effectivePath });
                dismiss();
              }}
            >
              {t('files.browse')}
            </Button>
          </form>
        </Popover>
      ) : null}
    </>
  );
}
