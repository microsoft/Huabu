// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, Key } from 'lucide-react';
import React, { useState } from 'react';
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
  onSave: (key: string) => void;
  /** Remove the key stored by Huabu. Omit for credentials that cannot be removed. */
  onRemove?: () => void;
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
  density = 'default',
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const closeEditor = () => {
    setValue('');
    setEditing(false);
  };

  const commitValue = () => {
    const key = value.trim();
    if (key) {
      onSave(key);
    } else if (saved && onRemove) {
      onRemove();
    }
    closeEditor();
  };

  return (
    <>
      <SettingRow title={title} description={description} density={density}>
        {editing ? (
          <SettingControl>
            <TextInput
              type="password"
              aria-label={
                ariaLabel ?? (typeof title === 'string' ? title : undefined)
              }
              placeholder={placeholder}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitValue();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  closeEditor();
                }
              }}
              className="w-full"
              autoComplete="off"
              autoFocus
            />
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <Button
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={closeEditor}
                disabled={saving}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                tone="neutral"
                size="sm"
                onClick={commitValue}
                disabled={
                  saving || disabled || (!value.trim() && !(saved && onRemove))
                }
              >
                {saving ? t('settings.saving') : t('actions.save')}
              </Button>
            </div>
          </SettingControl>
        ) : (
          <div className="flex items-center gap-2">
            {saved ? (
              <Check
                size={14}
                className="text-success"
                aria-label={t('settings.keyConfigured')}
              />
            ) : (
              <Key
                size={14}
                className="text-warning"
                aria-label={t('settings.keyNotConfigured')}
              />
            )}
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={saving || disabled}
            >
              {saved ? t('settings.updateKey') : t('settings.setApiKey')}
            </Button>
          </div>
        )}
      </SettingRow>
    </>
  );
};
