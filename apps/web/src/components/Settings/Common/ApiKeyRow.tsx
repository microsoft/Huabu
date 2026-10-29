// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, Key } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';

import { SettingControl } from './SettingControl';
import { SettingRow } from './SettingRow';

interface ApiKeyRowProps {
  /** Label for the credential. */
  title: React.ReactNode;
  /** Accessible input label when the visual title is not plain text. */
  ariaLabel?: string;
  /** Optional description shown beneath the label. */
  description?: string;
  /** Whether a credential is already available to the server. */
  saved: boolean;
  /** Placeholder for the password input. */
  placeholder: string;
  /** Whether a save request is in flight. */
  saving?: boolean;
  /** Disable credential mutations when the active store is read-only. */
  disabled?: boolean;
  /** Persist a new key when the editor is submitted. */
  onSave: (key: string) => void | boolean | Promise<void | boolean>;
  /** Remove the key stored by Huabu. Omit for credentials that cannot be removed. */
  onRemove?: () => void | boolean | Promise<void | boolean>;
  /** Parent-owned persistence or validation feedback. Returning false keeps the editor open. */
  error?: string | null;
  /** Reduces vertical padding when rendered as a subordinate setting. */
  density?: 'default' | 'compact';
}

/**
 * Consistent secret-entry row used by settings panels.
 *
 * The default state exposes credential status and one Set/Update action.
 * Editing replaces it with an explicit input and Save/Cancel actions; saved
 * secrets are never read back into the input.
 */
export const ApiKeyRow: React.FC<ApiKeyRowProps> = ({
  title,
  ariaLabel,
  description,
  saved,
  placeholder,
  saving = false,
  disabled = false,
  onSave,
  onRemove,
  error,
  density = 'default',
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const feedbackId = useId();
  const busy = saving || pending;
  const feedback = localError ?? error;

  useEffect(() => {
    if (confirmingRemoval) cancelRef.current?.focus();
  }, [confirmingRemoval]);

  const closeEditor = () => {
    if (busy || inFlight.current) return;
    setValue('');
    setEditing(false);
    setConfirmingRemoval(false);
    setLocalError(null);
  };

  const commitValue = async (remove = false) => {
    if (busy || disabled || inFlight.current) return;
    const key = value.trim();
    if (remove ? !saved || !onRemove : !key) return;
    inFlight.current = true;
    setPending(true);
    setLocalError(null);
    try {
      const result = remove ? await onRemove?.() : await onSave(key);
      if (result !== false) {
        setValue('');
        setEditing(false);
        setConfirmingRemoval(false);
      }
    } catch (cause) {
      setLocalError(
        cause instanceof Error
          ? cause.message
          : t('settings.credentialSaveFailed'),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <>
      <SettingRow title={title} description={description} density={density}>
        {editing ? (
          <SettingControl>
            {confirmingRemoval ? (
              <p className="text-fg-muted text-xs">
                {t('settings.confirmRemoveKey')}
              </p>
            ) : (
              <TextInput
                size="field"
                type="password"
                aria-label={
                  ariaLabel ?? (typeof title === 'string' ? title : undefined)
                }
                placeholder={placeholder}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setLocalError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void commitValue();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    closeEditor();
                  }
                }}
                className="w-full"
                autoComplete="off"
                autoFocus
                disabled={busy || disabled}
                aria-describedby={feedback ? feedbackId : undefined}
              />
            )}
            {feedback ? (
              <p
                id={feedbackId}
                role="alert"
                className="text-danger-fg mt-2 text-xs [overflow-wrap:anywhere]"
              >
                {feedback}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
              {saved && onRemove && !confirmingRemoval ? (
                <Button
                  variant="ghost"
                  tone="danger"
                  size="field"
                  disabled={busy || disabled}
                  onClick={() => setConfirmingRemoval(true)}
                >
                  {t('settings.removeKey')}
                </Button>
              ) : null}
              <Button
                ref={cancelRef}
                variant="outline"
                tone="neutral"
                size="field"
                onClick={() => {
                  if (confirmingRemoval) setConfirmingRemoval(false);
                  else closeEditor();
                }}
                disabled={busy}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                tone={confirmingRemoval ? 'danger' : 'neutral'}
                size="field"
                onClick={() => void commitValue(confirmingRemoval)}
                disabled={
                  busy || disabled || (!confirmingRemoval && !value.trim())
                }
              >
                {busy
                  ? t('settings.saving')
                  : confirmingRemoval
                    ? t('actions.delete')
                    : t('actions.save')}
              </Button>
            </div>
          </SettingControl>
        ) : (
          <div className="flex items-center gap-2">
            {saved ? (
              <Check
                size={14}
                className="text-success-fg"
                aria-label={t('settings.keyConfigured')}
              />
            ) : (
              <Key
                size={14}
                className="text-warning-fg"
                aria-label={t('settings.keyNotConfigured')}
              />
            )}
            <Button
              variant="outline"
              tone="neutral"
              size="field"
              onClick={() => {
                setLocalError(null);
                setEditing(true);
              }}
              disabled={busy || disabled}
            >
              {saved ? t('settings.updateKey') : t('settings.setApiKey')}
            </Button>
          </div>
        )}
      </SettingRow>
    </>
  );
};
