// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  clampSpaceShortcutWidth,
  SPACE_SHORTCUT_SIZE,
} from '@huabu/shared/canvas-engine';

import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';

export function SpaceShortcutWidthSettings({
  width,
  automatic,
  onChange,
}: {
  width: number;
  automatic: boolean;
  onChange: (width: number | null) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [draft, setDraft] = useState(String(Math.round(width)));
  const [error, setError] = useState(false);
  return (
    <form
      className="flex w-60 flex-col gap-3 text-xs"
      aria-label={t('spacePreview.widthSettings')}
      onSubmit={(event) => {
        event.preventDefault();
        const next = Number(draft);
        if (!Number.isInteger(next) || next < SPACE_SHORTCUT_SIZE.minWidth) {
          setError(true);
          return;
        }
        setError(false);
        onChange(next);
      }}
    >
      <div className="flex gap-1">
        <Button
          size="sm"
          variant={automatic ? 'solid' : 'ghost'}
          aria-pressed={automatic}
          onClick={() => {
            setError(false);
            onChange(null);
          }}
        >
          {t('spacePreview.autoWidth')}
        </Button>
        <Button
          size="sm"
          variant={automatic ? 'ghost' : 'solid'}
          aria-pressed={!automatic}
          onClick={() => onChange(clampSpaceShortcutWidth(Math.round(width)))}
        >
          {t('spacePreview.fixedWidth')}
        </Button>
      </div>
      <label htmlFor={inputId}>{t('toolbar.size.width')}</label>
      <TextInput
        id={inputId}
        aria-label={t('toolbar.size.width')}
        inputMode="numeric"
        value={draft}
        aria-invalid={error}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(false);
        }}
      />
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-danger">
          {t('spacePreview.widthError', {
            min: SPACE_SHORTCUT_SIZE.minWidth,
          })}
        </p>
      ) : null}
      <p className="text-fg-subtle">
        {t('spacePreview.widthHint', {
          min: SPACE_SHORTCUT_SIZE.minWidth,
          autoMax: SPACE_SHORTCUT_SIZE.autoMaxWidth,
        })}
      </p>
      <Button type="submit" variant="outline" size="sm">
        {t('spacePreview.applyWidth')}
      </Button>
    </form>
  );
}
