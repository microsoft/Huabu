// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';

import { ProfileFormFooter } from './ProfileFormFooter';

interface ProfileEditActionsProps {
  saving: boolean;
  saveDisabled?: boolean;
  onCancel: () => void;
  onSave: () => void;
}

/** Canonical actions shared by every Profile edit form. */
export function ProfileEditActions({
  saving,
  saveDisabled = false,
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
        {saving ? t('settings.saving') : t('settings.saveChanges')}
      </Button>
    </ProfileFormFooter>
  );
}
