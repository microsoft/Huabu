// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useTranslation } from 'react-i18next';

import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

import { ReadOnlyField } from './ReadOnlyField';

import type { ReactNode } from 'react';

interface ProfileEditFieldsProps {
  preset?: {
    name: string;
    description?: string;
    configuration?: ReactNode;
  };
  agentName: string;
  agentDetails?: ReactNode;
  workingDirPath: string;
  displayNameId: string;
  displayNameControl: ReactNode;
}

/** Canonical field order and labels shared by every Profile edit form. */
export function ProfileEditFields({
  preset,
  agentName,
  agentDetails,
  workingDirPath,
  displayNameId,
  displayNameControl,
}: ProfileEditFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
      {preset ? (
        <div className="flex flex-col">
          <SettingRow
            title={t('settings.template')}
            description={preset.description}
          >
            <SettingControl>
              <ReadOnlyField value={preset.name} />
            </SettingControl>
          </SettingRow>
          {preset.configuration}
        </div>
      ) : null}

      <div className="flex flex-col">
        <SettingRow title={t('settings.agent')}>
          <SettingControl>
            <ReadOnlyField value={agentName} />
          </SettingControl>
        </SettingRow>
        {agentDetails}
      </div>

      <SettingRow
        title={t('settings.workingDirectory')}
        description={t('settings.workingDirectoryHint')}
      >
        <SettingControl>
          <ReadOnlyField value={workingDirPath} mono />
        </SettingControl>
      </SettingRow>

      <SettingRow
        labelFor={displayNameId}
        title={
          <SettingLabel optional>{t('settings.displayName')}</SettingLabel>
        }
      >
        <SettingControl>{displayNameControl}</SettingControl>
      </SettingRow>
    </>
  );
}
