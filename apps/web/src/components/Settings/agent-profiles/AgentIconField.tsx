// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `AgentIconField` — the labelled "Icon" settings row (title + avatar
 * picker) shared by every Profile create/edit form so the row is defined once.
 */

import { useTranslation } from 'react-i18next';

import { SettingRow } from '@/components/Settings/Common/SettingRow';

import { AgentIconPicker } from './AgentIconPicker';

import type { AgentIconValue } from '@/components/Common/AgentIcon';

type AgentIconFieldProps = {
  value: AgentIconValue;
  onChange: (next: AgentIconValue) => void;
  /** Harness the Profile launches; offers its logo when one is bundled. */
  harnessId?: string;
  /** Agent alias, used to build accessible labels. */
  alias: string;
  disabled?: boolean;
};

export function AgentIconField({
  value,
  onChange,
  harnessId,
  alias,
  disabled,
}: AgentIconFieldProps) {
  const { t } = useTranslation();
  return (
    <SettingRow title={t('settings.agentIcon.label')}>
      <AgentIconPicker
        value={value}
        onChange={onChange}
        harnessId={harnessId}
        alias={alias}
        disabled={disabled}
      />
    </SettingRow>
  );
}
