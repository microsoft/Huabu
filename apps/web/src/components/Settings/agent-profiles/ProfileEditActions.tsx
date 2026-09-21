// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';

import { ProfileFormFooter } from './ProfileFormFooter';

interface ProfileEditActionsProps {
  saving: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
  onCancel: () => void;
  onSave: () => void;
}

/** Canonical actions shared by Profile creation and editing. */
export function ProfileEditActions({
  saving,
  saveDisabled = false,
  saveLabel,
  onCancel,
  onSave,
}: ProfileEditActionsProps) {
  const { t } = useTranslation();

  return (
    <ProfileFormFooter>
      <Button
        variant="outline"
        tone="neutral"
        size="sm"
        onClick={onCancel}
        disabled={saving}
      >
        {t('actions.cancel')}
      </Button>
      <Button
        variant="solid"
        tone="info"
        size="sm"
        onClick={onSave}
        disabled={saving || saveDisabled}
      >
        {saving
          ? t('settings.saving')
          : (saveLabel ?? t('settings.saveChanges'))}
      </Button>
    </ProfileFormFooter>
  );
}
