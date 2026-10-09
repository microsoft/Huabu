// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown, Key, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  getCapabilities,
  getCapability,
  putCapability,
} from '@/api/capabilities';
import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';

import type {
  CapabilityConfig,
  CapabilityConfigurationField,
  CapabilityFieldValue,
} from '@huabu/shared';

function CapabilityField({
  field,
  value,
  configured,
  disabled,
  onChange,
  onRemove,
}: {
  field: CapabilityConfigurationField;
  value: CapabilityFieldValue | undefined;
  configured: boolean;
  disabled: boolean;
  onChange: (value: CapabilityFieldValue) => void;
  onRemove: () => void;
}) {
  if (field.type === 'enum') {
    return (
      <Select
        options={field.options ?? []}
        value={typeof value === 'string' ? value : ''}
        onChange={onChange}
        ariaLabel={field.label}
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
        disabled={disabled}
      />
    );
  }

  const secret = field.type === 'secret';
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <TextInput
        type={secret ? 'password' : field.type === 'url' ? 'url' : 'text'}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          secret && configured ? 'Configured' : (field.placeholder ?? '')
        }
        aria-label={field.label}
        autoComplete="off"
        disabled={disabled}
        className="w-full"
        wrapperClassName="min-w-0 flex-1"
      />
      {secret && configured ? (
        <>
          <Key size={14} className="text-success shrink-0" aria-hidden />
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            size="sm"
            iconOnly
            aria-label={`Remove ${field.label}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </>
      ) : null}
    </div>
  );
}

function CapabilityForm({
  initial,
  writesDisabled,
}: {
  initial: CapabilityConfig;
  writesDisabled: boolean;
}) {
  const [config, setConfig] = useState(initial);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, CapabilityFieldValue>>(
    initial.values,
  );
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const configured = useMemo(
    () => new Set(config.configuredFields),
    [config.configuredFields],
  );
  const writableDirty = useMemo(
    () =>
      [...dirty].some((id) => {
        const field = config.manifest.configuration.find(
          (candidate) => candidate.id === id,
        );
        return !(
          writesDisabled &&
          (field?.type === 'secret' ||
            config.manifest.storage.namespace ===
              'integration.azureVisionInkOcr')
        );
      }),
    [config.manifest, dirty, writesDisabled],
  );

  function change(id: string, value: CapabilityFieldValue) {
    setDraft((current) => ({ ...current, [id]: value }));
    setDirty((current) => new Set(current).add(id));
  }

  async function update(values: Record<string, CapabilityFieldValue>) {
    setSaving(true);
    try {
      const next = await putCapability(config.manifest.id, { values });
      setConfig(next);
      setDraft(next.values);
      setDirty(new Set());
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Unable to save', {
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  }

  function save() {
    const values = Object.fromEntries(
      [...dirty].flatMap((id) => {
        const value = draft[id];
        if (
          config.manifest.configuration.find((field) => field.id === id)
            ?.type === 'secret' &&
          value === ''
        ) {
          return [];
        }
        return [[id, value ?? null]];
      }),
    );
    if (Object.keys(values).length > 0) void update(values);
  }

  return (
    <SettingSection>
      <SettingRow
        title={config.manifest.name}
        description={config.manifest.description}
      >
        <div className="flex items-center gap-2">
          <span
            className={
              config.configured
                ? 'text-success text-xs'
                : 'text-warning text-xs'
            }
          >
            {config.configured ? 'Configured' : 'Not configured'}
          </span>
          <Button
            type="button"
            variant="ghost"
            tone="neutral"
            size="sm"
            iconOnly
            aria-label={`Configure ${config.manifest.name}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown
              size={16}
              aria-hidden
              className={expanded ? '' : '-rotate-90'}
            />
          </Button>
        </div>
      </SettingRow>
      {expanded ? (
        <>
          {config.manifest.configuration.map((field) => (
            <SettingRow
              key={field.id}
              title={field.label}
              description={field.description}
            >
              <SettingControl>
                <CapabilityField
                  field={field}
                  value={draft[field.id]}
                  configured={configured.has(field.id)}
                  disabled={
                    saving ||
                    (writesDisabled &&
                      (field.type === 'secret' ||
                        config.manifest.storage.namespace ===
                          'integration.azureVisionInkOcr'))
                  }
                  onChange={(value) => change(field.id, value)}
                  onRemove={() => void update({ [field.id]: null })}
                />
              </SettingControl>
            </SettingRow>
          ))}
          <SettingRow>
            <SettingControl className="flex justify-end gap-1.5">
              <Button
                type="button"
                variant="outline"
                tone="neutral"
                size="sm"
                disabled={saving || dirty.size === 0}
                onClick={() => {
                  setDraft(config.values);
                  setDirty(new Set());
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                tone="neutral"
                size="sm"
                disabled={saving || !writableDirty}
                onClick={save}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </SettingControl>
          </SettingRow>
        </>
      ) : null}
    </SettingSection>
  );
}

export function CapabilitiesSettings() {
  const [configs, setConfigs] = useState<CapabilityConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const writesDisabled = useDeploymentReadinessStore(
    (state) => state.readiness?.credentials.writable === false,
  );

  useEffect(() => {
    let cancelled = false;
    void getCapabilities()
      .then(({ capabilities }) =>
        Promise.all(capabilities.map(({ id }) => getCapability(id))),
      )
      .then((next) => {
        if (!cancelled) setConfigs(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Failed to load Capabilities',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-danger px-1 text-xs">
        {error}
      </p>
    );
  }
  if (configs.length === 0) {
    return (
      <p role="status" className="text-fg-muted px-1 text-xs">
        Loading Capabilities...
      </p>
    );
  }
  return configs.map((config) => (
    <CapabilityForm
      key={config.manifest.id}
      initial={config}
      writesDisabled={writesDisabled}
    />
  ));
}
