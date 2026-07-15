import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { updateAgentTeamConfigs } from '@/api/agent-team';
import { ApiKeyRow } from '@/components/Common/ApiKeyRow';
import { SettingControl } from '@/components/Common/SettingControl';
import { SettingLabel } from '@/components/Common/SettingLabel';
import { SettingRow } from '@/components/Common/SettingRow';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';

import type {
  AgentTeamMemberConfigView,
  AgentTeamMemberDetailView,
} from '@sediment/shared';

interface AgentTeamConfigsProps {
  config: AgentTeamMemberConfigView;
  onDetailChange: (detail: AgentTeamMemberDetailView) => void;
}

interface ConfigFieldProps extends AgentTeamConfigsProps {
  field: AgentTeamMemberConfigView['fields'][number];
}

function ConfigField({ config, field, onDetailChange }: ConfigFieldProps) {
  const { t } = useTranslation('agentTeam');
  const inputId = useId();
  const [value, setValue] = useState(field.secret ? '' : (field.value ?? ''));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(field.secret ? '' : (field.value ?? ''));
  }, [field.secret, field.value]);

  const update = async (next: string | null) => {
    try {
      setSaving(true);
      const detail = await updateAgentTeamConfigs({
        machine: config.machine,
        manifestPath: config.manifestPath,
        values: { [field.name]: next },
      });
      onDetailChange(detail);
      setValue(field.secret ? '' : (next ?? ''));
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  };

  const label = (
    <SettingLabel optional={!field.required}>{field.name}</SettingLabel>
  );

  if (field.secret) {
    return (
      <ApiKeyRow
        title={label}
        ariaLabel={field.name}
        description={field.description}
        saved={field.configured}
        placeholder={t('configValue')}
        saving={saving}
        onSave={(next) => void update(next)}
        onRemove={() => void update(null)}
      />
    );
  }

  return (
    <SettingRow
      title={label}
      description={field.description}
      labelFor={inputId}
    >
      <SettingControl>
        <TextInput
          id={inputId}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('configValue')}
          disabled={saving}
          autoComplete="off"
          mono
          className="w-full"
          onBlur={() => {
            if (value !== (field.value ?? '')) {
              void update(value.trim() ? value : null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </SettingControl>
    </SettingRow>
  );
}

export function AgentTeamConfigs(props: AgentTeamConfigsProps) {
  const { t } = useTranslation('agentTeam');
  const { config } = props;
  if (config.fields.length === 0) {
    return (
      <SettingRow
        title={t('noConfigs')}
        description={t('noConfigsDescription')}
      >
        <span />
      </SettingRow>
    );
  }

  return config.fields.map((field) => (
    <ConfigField key={field.name} field={field} {...props} />
  ));
}
