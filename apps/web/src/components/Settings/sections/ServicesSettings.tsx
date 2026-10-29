// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getServices, getService, putService } from '@/api/services';
import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { ApiKeyRow } from '@/components/Settings/Common/ApiKeyRow';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';

import type {
  ServiceConfig,
  ServiceConfigurationField,
  ServiceFieldValue,
} from '@huabu/shared';

function ServiceField({
  field,
  value,
  disabled,
  onChange,
  onCommit,
  feedbackId,
  invalid,
}: {
  field: ServiceConfigurationField;
  value: ServiceFieldValue | undefined;
  disabled: boolean;
  onChange: (value: ServiceFieldValue) => void;
  onCommit: () => void;
  feedbackId: string;
  invalid: boolean;
}) {
  if (field.type === 'enum') {
    return (
      <Select
        appearance="field"
        options={field.options ?? []}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        ariaLabel={field.label}
        aria-describedby={feedbackId}
        className="w-full"
        disabled={disabled}
      />
    );
  }

  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={field.label}
        aria-describedby={feedbackId}
        disabled={disabled}
      />
    );
  }

  return (
    <TextInput
      size="field"
      type={field.type === 'url' ? 'url' : 'text'}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder ?? ''}
      aria-label={field.label}
      aria-invalid={invalid}
      aria-describedby={feedbackId}
      autoComplete="off"
      disabled={disabled}
      className="w-full"
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onCommit();
        }
      }}
    />
  );
}

function ServiceForm({
  initial,
  writesDisabled,
}: {
  initial: ServiceConfig;
  writesDisabled: boolean;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState(initial);
  const [expanded, setExpanded] = useState(false);
  const [hasExpanded, setHasExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, ServiceFieldValue>>(
    initial.values,
  );
  const draftRef = useRef(draft);
  const savedConfig = useRef(initial);
  const queue = useRef(Promise.resolve());
  const pending = useRef(new Map<string, Promise<boolean>>());
  const [savingFields, setSavingFields] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [waitingFields, setWaitingFields] = useState<Set<string>>(new Set());
  const contentKey = `settings.serviceContent.${config.manifest.id}`;
  const name = t(`${contentKey}.name`, { defaultValue: config.manifest.name });
  const description = t(`${contentKey}.description`, {
    defaultValue: config.manifest.description,
  });
  const fields = config.manifest.configuration.map((field) => ({
    ...field,
    label: t(`${contentKey}.fields.${field.id}.label`, {
      defaultValue: field.label,
    }),
    description: t(`${contentKey}.fields.${field.id}.description`, {
      defaultValue: field.description ?? '',
    }),
    placeholder: t(`${contentKey}.fields.${field.id}.placeholder`, {
      defaultValue: field.placeholder ?? '',
    }),
    options: field.options?.map((option) => ({
      ...option,
      label: t(`${contentKey}.fields.${field.id}.options.${option.value}`, {
        defaultValue: option.label,
      }),
    })),
  }));

  function isReadOnly(field: ServiceConfigurationField) {
    return (
      writesDisabled &&
      (field.type === 'secret' ||
        config.manifest.storage.namespace === 'integration.azureVisionInkOcr')
    );
  }

  function change(id: string, value: ServiceFieldValue) {
    draftRef.current = { ...draftRef.current, [id]: value };
    setDraft(draftRef.current);
    setErrors((current) => ({ ...current, [id]: null }));
    setWaitingFields((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function validate(
    field: ServiceConfigurationField,
    value: ServiceFieldValue | undefined,
  ) {
    if (
      field.required &&
      (value === null ||
        value === undefined ||
        (typeof value === 'string' && !value.trim()))
    ) {
      return t('settings.serviceUi.requiredField', { name: field.label });
    }
    if (field.type === 'url' && typeof value === 'string' && value) {
      try {
        if (new URL(value).protocol === 'https:') return null;
      } catch {
        // Invalid URLs remain local drafts; the server validates provider-specific constraints.
      }
      return t('settings.serviceUi.invalidUrl');
    }
    return null;
  }

  function update(
    values: Record<string, ServiceFieldValue>,
    feedbackField: string,
  ): Promise<boolean> {
    const existing = pending.current.get(feedbackField);
    if (existing) return existing;
    const ids = Object.keys(values);
    setSavingFields((current) => new Set([...current, ...ids]));
    setErrors((current) => ({ ...current, [feedbackField]: null }));
    const request = queue.current.then(async () => {
      try {
        const previous = savedConfig.current;
        const next = await putService(config.manifest.id, { values });
        savedConfig.current = next;
        setConfig(next);
        const nextDraft = { ...draftRef.current };
        for (const id of Object.keys(next.values)) {
          if (
            Object.is(
              nextDraft[id],
              id in values ? values[id] : previous.values[id],
            )
          ) {
            nextDraft[id] = next.values[id] ?? null;
          }
        }
        draftRef.current = nextDraft;
        setDraft(nextDraft);
        setWaitingFields(
          (current) => new Set([...current].filter((id) => !ids.includes(id))),
        );
        return true;
      } catch (cause) {
        setErrors((current) => ({
          ...current,
          [feedbackField]:
            cause instanceof Error
              ? cause.message
              : t('settings.serviceUi.saveFailed'),
        }));
        return false;
      } finally {
        pending.current.delete(feedbackField);
        setSavingFields(
          (current) => new Set([...current].filter((id) => !ids.includes(id))),
        );
      }
    });
    pending.current.set(feedbackField, request);
    queue.current = request.then(() => {});
    return request;
  }

  function commitField(
    field: ServiceConfigurationField,
    nextValue = draftRef.current[field.id],
  ) {
    if (isReadOnly(field) || pending.current.has(field.id)) return;
    const message = validate(field, nextValue);
    setErrors((current) => ({ ...current, [field.id]: message }));
    if (message) return;
    if (Object.is(nextValue, savedConfig.current.values[field.id])) return;
    const needsKey = fields.some(
      (candidate) =>
        candidate.type === 'secret' &&
        candidate.required &&
        !savedConfig.current.configuredFields.includes(candidate.id),
    );
    if (needsKey) {
      setWaitingFields((current) => new Set(current).add(field.id));
      return;
    }
    void update({ [field.id]: nextValue ?? null }, field.id);
  }

  function saveKey(field: ServiceConfigurationField, key: string) {
    const values: Record<string, ServiceFieldValue> = { [field.id]: key };
    if (!savedConfig.current.configured) {
      let invalid = false;
      for (const candidate of fields) {
        if (candidate.type === 'secret') continue;
        const value = draftRef.current[candidate.id];
        const message = validate(candidate, value);
        if (message) {
          invalid = true;
          setErrors((current) => ({ ...current, [candidate.id]: message }));
        } else if (candidate.required || waitingFields.has(candidate.id)) {
          values[candidate.id] = value ?? null;
        }
      }
      if (invalid) {
        setErrors((current) => ({
          ...current,
          [field.id]: t('settings.serviceUi.completeRequiredFields'),
        }));
        return false;
      }
    }
    return update(values, field.id);
  }

  return (
    <SettingSection>
      <SettingRow title={name} description={description}>
        <div className="flex items-center gap-2">
          {!config.configured && !expanded ? (
            <span className="text-fg-muted text-xs">
              {t('settings.serviceUi.pendingSetup')}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            size="field"
            iconOnly
            aria-label={t('settings.serviceUi.configureService', { name })}
            aria-expanded={expanded}
            disabled={savingFields.size > 0}
            onClick={() => {
              setHasExpanded(true);
              setExpanded((current) => !current);
            }}
          >
            <ChevronDown
              size={16}
              aria-hidden
              className={expanded ? '' : '-rotate-90'}
            />
          </Button>
        </div>
      </SettingRow>
      {hasExpanded ? (
        <div hidden={!expanded} className="divide-edge-default divide-y">
          {fields.map((field) =>
            field.type === 'secret' ? (
              <ApiKeyRow
                key={field.id}
                title={field.label}
                description={field.description}
                saved={config.configuredFields.includes(field.id)}
                placeholder={
                  field.placeholder || t('settings.serviceUi.enterKey')
                }
                saving={savingFields.size > 0}
                disabled={isReadOnly(field)}
                error={errors[field.id]}
                onSave={(key) => saveKey(field, key)}
                onRemove={() => update({ [field.id]: null }, field.id)}
              />
            ) : (
              <SettingRow
                key={field.id}
                title={field.label}
                description={field.description}
              >
                <SettingControl>
                  <ServiceField
                    field={field}
                    value={draft[field.id]}
                    disabled={savingFields.has(field.id) || isReadOnly(field)}
                    onChange={(value) => {
                      change(field.id, value);
                      if (field.type === 'enum' || field.type === 'boolean')
                        commitField(field, value);
                    }}
                    onCommit={() => commitField(field)}
                    feedbackId={`service-${config.manifest.id}-${field.id}-feedback`}
                    invalid={
                      !!validate(field, draft[field.id]) && !!errors[field.id]
                    }
                  />
                  <div
                    id={`service-${config.manifest.id}-${field.id}-feedback`}
                    className="mt-2 text-xs empty:hidden"
                  >
                    {errors[field.id] ? (
                      <div className="flex flex-col items-end gap-2">
                        <p
                          role="alert"
                          className="text-danger-fg [overflow-wrap:anywhere]"
                        >
                          {errors[field.id]}
                        </p>
                        {!validate(field, draft[field.id]) ? (
                          <Button
                            variant="outline"
                            size="field"
                            disabled={
                              savingFields.has(field.id) || isReadOnly(field)
                            }
                            onClick={() => commitField(field)}
                          >
                            {t('settings.retrySave')}
                          </Button>
                        ) : null}
                      </div>
                    ) : savingFields.has(field.id) ? (
                      <p role="status" className="text-fg-muted">
                        {t('settings.saving')}
                      </p>
                    ) : waitingFields.has(field.id) ? (
                      <p role="status" className="text-fg-muted">
                        {t('settings.serviceUi.waitingForKey')}
                      </p>
                    ) : null}
                  </div>
                </SettingControl>
              </SettingRow>
            ),
          )}
        </div>
      ) : null}
    </SettingSection>
  );
}

export function ServicesSettings() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<ServiceConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const writesDisabled = useDeploymentReadinessStore(
    (state) =>
      !state.readiness ||
      state.loading ||
      !!state.error ||
      state.readiness.credentials.writable !== true,
  );

  useEffect(() => {
    let cancelled = false;
    void getServices()
      .then(({ services }) =>
        Promise.all(services.map(({ id }) => getService(id))),
      )
      .then((next) => {
        if (!cancelled) setConfigs(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : t('settings.serviceUi.loadFailed'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (error) {
    return (
      <p role="alert" className="text-danger-fg px-1 text-xs">
        {error}
      </p>
    );
  }
  if (configs.length === 0) {
    return (
      <p role="status" className="text-fg-muted px-1 text-xs">
        {t('settings.serviceUi.loading')}
      </p>
    );
  }
  return configs.map((config) => (
    <ServiceForm
      key={config.manifest.id}
      initial={config}
      writesDisabled={writesDisabled}
    />
  ));
}
