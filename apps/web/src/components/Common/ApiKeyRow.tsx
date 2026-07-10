import { Check, Key } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { Input, TEXT_INPUT_CLASS } from './Input';
import { SettingRow } from './SettingRow';

interface ApiKeyRowProps {
  /** Label for the credential. */
  title: string;
  /** Optional description shown beneath the label. */
  description?: string;
  /** Whether a credential is already available to the server. */
  saved: boolean;
  /** Placeholder for the password input. */
  placeholder: string;
  /** Whether a save request is in flight. */
  saving?: boolean;
  /** Persist a new key when the editor is submitted or loses focus. */
  onSave: (key: string) => void;
}

/**
 * Consistent secret-entry row used by settings panels.
 *
 * The default state exposes only credential status and an intentional
 * Set/Update action. Editing reveals a password input and saves a non-empty
 * value on Enter or blur; saved secrets are never read back into it.
 */
export const ApiKeyRow: React.FC<ApiKeyRowProps> = ({
  title,
  description,
  saved,
  placeholder,
  saving = false,
  onSave,
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const actionButtonRef = useRef<HTMLButtonElement>(null);

  const closeEditor = () => {
    setValue('');
    setEditing(false);
  };

  const commitValue = () => {
    const key = value.trim();
    if (key) onSave(key);
    closeEditor();
  };

  return (
    <>
      <SettingRow title={title} description={description}>
        <div className="flex items-center gap-1.5">
          {saved ? (
            <Check size={14} className="text-success" />
          ) : (
            <Key size={14} className="text-warning" />
          )}
          <Button
            ref={actionButtonRef}
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={() => {
              if (editing) {
                closeEditor();
              } else {
                setEditing(true);
              }
            }}
            disabled={saving}
          >
            {saving
              ? t('settings.saving')
              : editing
                ? t('actions.cancel')
                : saved
                  ? t('settings.updateKey')
                  : t('settings.setApiKey')}
          </Button>
        </div>
      </SettingRow>

      {editing && (
        <div className="px-3 py-2.5">
          <Input
            type="password"
            aria-label={title}
            placeholder={placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={(event) => {
              if (event.relatedTarget === actionButtonRef.current) return;
              commitValue();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitValue();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeEditor();
              }
            }}
            className={`${TEXT_INPUT_CLASS} w-full`}
            autoComplete="off"
            autoFocus
          />
        </div>
      )}
    </>
  );
};
