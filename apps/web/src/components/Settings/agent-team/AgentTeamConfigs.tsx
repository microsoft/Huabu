import { Check, Key, RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { updateAgentTeamConfigs } from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Input, TEXT_INPUT_CLASS } from '@/components/Common/Input';
import { SettingRow } from '@/components/Common/SettingRow';
import { toast } from '@/components/Common/Toast';

import type {
  AgentTeamMemberConfigView,
  AgentTeamSettingsState,
} from '@sediment/shared';

interface AgentTeamConfigsProps {
  config: AgentTeamMemberConfigView;
  pendingAction: string | null;
  mutate: (
    action: string,
    operation: () => Promise<AgentTeamSettingsState>,
  ) => Promise<void>;
}

interface ConfigFieldProps extends AgentTeamConfigsProps {
  field: AgentTeamMemberConfigView['fields'][number];
}

function ConfigField({
  config,
  field,
  pendingAction,
  mutate,
}: ConfigFieldProps) {
  const { t } = useTranslation('agentTeam');
  const [value, setValue] = useState(field.secret ? '' : (field.value ?? ''));
  const action = `config:${config.machine}:${config.manifestPath}:${field.name}`;
  const saving = pendingAction === action;
  const disabled = pendingAction !== null;

  useEffect(() => {
    setValue(field.secret ? '' : (field.value ?? ''));
  }, [field.secret, field.value]);

  const update = async (next: string | null) => {
    try {
      await mutate(action, () =>
        updateAgentTeamConfigs({
          machine: config.machine,
          manifestPath: config.manifestPath,
          values: { [field.name]: next },
        }),
      );
      setValue(field.secret ? '' : (next ?? ''));
      toast(t('configSaved'), { tone: 'success' });
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    }
  };

  const label = (
    <>
      {field.name}
      {field.required && (
        <span className="text-danger" title={t('required')}>
          {' '}
          (*)
        </span>
      )}
    </>
  );

  return (
    <SettingRow title={label} description={field.description}>
      <div className="flex min-w-72 items-center justify-end gap-1.5">
        {field.secret ? (
          field.configured ? (
            <Check className="text-success" size={14} />
          ) : (
            <Key className="text-warning" size={14} />
          )
        ) : null}
        <Input
          type={field.secret ? 'password' : 'text'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={
            field.secret && field.configured
              ? t('secretConfigured')
              : t('configValue')
          }
          disabled={disabled}
          autoComplete="off"
          className={`${TEXT_INPUT_CLASS} min-w-0 flex-1 font-mono`}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (!field.secret || value.length > 0)) {
              event.preventDefault();
              void update(value);
            }
          }}
        />
        <Button
          variant="outline"
          tone="neutral"
          size="sm"
          iconOnly
          title={t('save')}
          disabled={disabled || (field.secret && value.length === 0)}
          onClick={() => void update(value)}
        >
          <Save className={saving ? 'animate-pulse' : undefined} />
        </Button>
        {(field.configured || (!field.secret && field.value !== undefined)) && (
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            iconOnly
            title={t('clearConfig')}
            disabled={disabled}
            onClick={() => void update(null)}
          >
            <RotateCcw />
          </Button>
        )}
      </div>
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
