// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentIconField` — the labelled "Icon" settings row (title + hint + avatar
 * picker) shared by every Profile create/edit form so the row is defined once.
 */

import { useTranslation } from 'react-i18next';

import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

import { AgentIconPicker } from './AgentIconPicker';

import type { AgentIconValue } from '@/components/Common/AgentIcon';

type AgentIconFieldProps = {
  value: AgentIconValue;
  onChange: (next: AgentIconValue) => void;
  /** Agent alias, used to build accessible labels. */
  alias: string;
  disabled?: boolean;
};

export function AgentIconField({
  value,
  onChange,
  alias,
  disabled,
}: AgentIconFieldProps) {
  const { t } = useTranslation();
  return (
    <SettingRow
      title={t('settings.agentIcon.label')}
      description={t('settings.agentIcon.hint')}
    >
      <SettingControl>
        <AgentIconPicker
          value={value}
          onChange={onChange}
          alias={alias}
          disabled={disabled}
        />
      </SettingControl>
    </SettingRow>
  );
}
