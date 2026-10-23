// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createAgentletConnectionCommand,
  getExternalAgentRuntimeConfig,
  updateExternalAgentRuntimeConfig,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { Select } from '@/components/Common/Select';
import { textInputClassName } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { getElectronBridge } from '@/hooks/useElectron';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import type {
  AgentletConnectionCommandResponse,
  ConnectionCopyFormat,
  ConnectionShell,
  ExternalAgentRuntimeConfig,
} from '@huabu/shared';

const IDLE_TIMEOUT_PRESETS = new Set(['0', '300', '600', '1800', '3600']);

function RuntimeSaveFeedback({
  id,
  saving,
  error,
  onRetry,
  disabled,
}: {
  id: string;
  saving: boolean;
  error: string | null;
  onRetry?: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div id={id} hidden={!saving && !error} className="max-w-full text-xs">
      {saving ? (
        <p role="status" className="text-fg-muted">
          {t('settings.saving')}
        </p>
      ) : error ? (
        <div className="flex flex-col items-end gap-2">
          <p role="alert" className="text-danger [overflow-wrap:anywhere]">
            {error}
          </p>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              disabled={disabled}
            >
              {t('settings.retrySave')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ExternalAgentRuntimeSettings() {
  const { t } = useTranslation();
  const maxAgentsInputId = useId();
  const maxAgentsFeedbackId = useId();
  const customMinutesFeedbackId = useId();
  const savedConfig = useRef<ExternalAgentRuntimeConfig | null>(null);
  const saveInFlight = useRef(false);
  const [maxAgentsInput, setMaxAgentsInput] = useState('10');
  const [maxAgentsError, setMaxAgentsError] = useState<string | null>(null);
  const [maxAgentsSaving, setMaxAgentsSaving] = useState(false);
  const [idleTimeoutSelection, setIdleTimeoutSelection] = useState('600');
  const [customMinutes, setCustomMinutes] = useState('10');
  const [customMinutesError, setCustomMinutesError] = useState<string | null>(
    null,
  );
  const [customMinutesSaving, setCustomMinutesSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getExternalAgentRuntimeConfig()
      .then((config) => {
        if (!active) return;
        savedConfig.current = config;
        const value = String(config.idleTimeoutSecs);
        setMaxAgentsInput(String(config.maxAgents));
        setIdleTimeoutSelection(
          IDLE_TIMEOUT_PRESETS.has(value) ? value : 'custom',
        );
        if (config.idleTimeoutSecs > 0) {
          setCustomMinutes(String(config.idleTimeoutSecs / 60));
        }
      })
      .catch((error) => {
        if (!active) return;
        toast(
          error instanceof Error
            ? error.message
            : t('settings.externalAgentIdleTimeoutLoadFailed'),
          { tone: 'danger' },
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const saveIdleTimeout = useCallback(
    async (
      nextIdleTimeoutSecs: number,
      source: 'preset' | 'custom' = 'preset',
    ) => {
      const config = savedConfig.current;
      if (loading || !config || saveInFlight.current) return;
      setCustomMinutesError(null);
      if (nextIdleTimeoutSecs === config.idleTimeoutSecs) return;
      saveInFlight.current = true;
      setSaving(true);
      setCustomMinutesSaving(source === 'custom');
      try {
        const saved = await updateExternalAgentRuntimeConfig({
          idleTimeoutSecs: nextIdleTimeoutSecs,
          maxAgents: config.maxAgents,
        });
        savedConfig.current = saved;
        const value = String(saved.idleTimeoutSecs);
        setIdleTimeoutSelection(
          source === 'custom'
            ? 'custom'
            : IDLE_TIMEOUT_PRESETS.has(value)
              ? value
              : 'custom',
        );
        if (saved.idleTimeoutSecs > 0) {
          setCustomMinutes(String(saved.idleTimeoutSecs / 60));
        }
        toast(t('settings.externalAgentIdleTimeoutSaved'), {
          tone: 'success',
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t('settings.externalAgentIdleTimeoutSaveFailed');
        if (source === 'custom') {
          setCustomMinutesError(message);
        } else {
          const previous = String(config.idleTimeoutSecs);
          setIdleTimeoutSelection(
            IDLE_TIMEOUT_PRESETS.has(previous) ? previous : 'custom',
          );
          toast(message, { tone: 'danger' });
        }
      } finally {
        saveInFlight.current = false;
        setSaving(false);
        setCustomMinutesSaving(false);
      }
    },
    [loading, t],
  );

  const parsedMaxAgents = Number(maxAgentsInput);
  const maxAgentsValid =
    Number.isSafeInteger(parsedMaxAgents) && parsedMaxAgents >= 1;

  const saveMaxAgents = useCallback(async () => {
    const config = savedConfig.current;
    if (loading || !config || saveInFlight.current) return;
    if (!maxAgentsValid) {
      setMaxAgentsError(
        t('settings.externalAgentMaxAgentsInvalid', {
          max: Number.MAX_SAFE_INTEGER,
        }),
      );
      return;
    }
    setMaxAgentsError(null);
    if (parsedMaxAgents === config.maxAgents) return;
    saveInFlight.current = true;
    setSaving(true);
    setMaxAgentsSaving(true);
    try {
      const saved = await updateExternalAgentRuntimeConfig({
        idleTimeoutSecs: config.idleTimeoutSecs,
        maxAgents: parsedMaxAgents,
      });
      savedConfig.current = saved;
      setMaxAgentsInput(String(saved.maxAgents));
      toast(t('settings.externalAgentMaxAgentsSaved'), { tone: 'success' });
    } catch (error) {
      setMaxAgentsError(
        error instanceof Error
          ? error.message
          : t('settings.externalAgentMaxAgentsSaveFailed'),
      );
    } finally {
      saveInFlight.current = false;
      setSaving(false);
      setMaxAgentsSaving(false);
    }
  }, [loading, maxAgentsValid, parsedMaxAgents, t]);

  const handleIdleTimeoutSelection = useCallback(
    (value: string) => {
      setIdleTimeoutSelection(value);
      setCustomMinutesError(null);
      if (value !== 'custom') void saveIdleTimeout(Number(value));
    },
    [saveIdleTimeout],
  );

  const parsedCustomMinutes = Number(customMinutes);
  const customMinutesValid =
    Number.isInteger(parsedCustomMinutes) &&
    parsedCustomMinutes >= 1 &&
    parsedCustomMinutes <= 1440;

  const saveCustomMinutes = useCallback(() => {
    if (loading || !savedConfig.current || saveInFlight.current) return;
    if (!customMinutesValid) {
      setCustomMinutesError(t('settings.customIdleTimeoutMinutesInvalid'));
      return;
    }
    void saveIdleTimeout(parsedCustomMinutes * 60, 'custom');
  }, [customMinutesValid, loading, parsedCustomMinutes, saveIdleTimeout, t]);

  return (
    <>
      <SettingRow
        title={t('settings.externalAgentIdleTimeout')}
        description={t('settings.externalAgentIdleTimeoutDescription')}
        className="items-start"
      >
        <div className="flex max-w-60 flex-col items-end gap-2">
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
            <Select
              appearance="field"
              options={[
                { value: '300', label: t('settings.fiveMinutes') },
                { value: '600', label: t('settings.tenMinutesDefault') },
                { value: '1800', label: t('settings.thirtyMinutes') },
                { value: '3600', label: t('settings.oneHour') },
                { value: '0', label: t('settings.never') },
                { value: 'custom', label: t('settings.custom') },
              ]}
              value={idleTimeoutSelection}
              onChange={handleIdleTimeoutSelection}
              disabled={loading || !savedConfig.current || saving}
              title={t('settings.externalAgentIdleTimeout')}
              ariaLabel={t('settings.externalAgentIdleTimeout')}
            />
            {idleTimeoutSelection === 'custom' ? (
              <>
                <Input
                  className={textInputClassName({
                    size: 'field',
                    className: 'w-20',
                  })}
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  value={customMinutes}
                  onChange={(event) => {
                    setCustomMinutes(event.target.value);
                    setCustomMinutesError(null);
                  }}
                  onBlur={saveCustomMinutes}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      saveCustomMinutes();
                    }
                  }}
                  aria-label={t('settings.customIdleTimeoutMinutes')}
                  aria-invalid={!!customMinutesError && !customMinutesValid}
                  aria-describedby={customMinutesFeedbackId}
                  disabled={loading || !savedConfig.current || saving}
                />
                <span className="text-fg-muted text-xs">
                  {t('settings.minutes')}
                </span>
              </>
            ) : null}
          </div>
          <RuntimeSaveFeedback
            id={customMinutesFeedbackId}
            saving={customMinutesSaving}
            error={customMinutesError}
            onRetry={customMinutesValid ? saveCustomMinutes : undefined}
            disabled={saving}
          />
        </div>
      </SettingRow>
      <SettingRow
        title={t('settings.externalAgentMaxAgents')}
        description={t('settings.externalAgentMaxAgentsDescription')}
        labelFor={maxAgentsInputId}
        className="items-start"
      >
        <div className="flex max-w-60 flex-col items-end gap-2">
          <Input
            className={textInputClassName({ size: 'field', className: 'w-24' })}
            id={maxAgentsInputId}
            type="number"
            min={1}
            step={1}
            value={maxAgentsInput}
            onChange={(event) => {
              setMaxAgentsInput(event.target.value);
              setMaxAgentsError(null);
            }}
            onBlur={() => void saveMaxAgents()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void saveMaxAgents();
              }
            }}
            aria-label={t('settings.externalAgentMaxAgents')}
            aria-invalid={!!maxAgentsError && !maxAgentsValid}
            aria-describedby={maxAgentsFeedbackId}
            disabled={loading || !savedConfig.current || saving}
          />
          <RuntimeSaveFeedback
            id={maxAgentsFeedbackId}
            saving={maxAgentsSaving}
            error={maxAgentsError}
            onRetry={maxAgentsValid ? () => void saveMaxAgents() : undefined}
            disabled={saving}
          />
        </div>
      </SettingRow>
    </>
  );
}

export function AgentConnectionSettings() {
  const { t } = useTranslation();
  const localAccessOnly = useDeploymentReadinessStore(
    (state) => state.readiness?.bind.scope === 'loopback',
  );
  const bridge = getElectronBridge();
  const localAccessHint =
    bridge && !bridge.isRemoteServer
      ? 'settings.agentletDesktopLocalAccess'
      : 'settings.agentletLocalAccessSetup';
  const detailsId = useId();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [connectionShell, setConnectionShell] =
    useState<ConnectionShell>('posix');
  const [copying, setCopying] = useState<ConnectionCopyFormat | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<Pick<
    AgentletConnectionCommandResponse,
    'source' | 'warnings'
  > | null>(null);

  const copyConnection = useCallback(
    async (format: ConnectionCopyFormat) => {
      setCopying(format);
      try {
        const result = await createAgentletConnectionCommand(
          connectionShell,
          format,
        );
        await copyToClipboard(result.content);
        setConnectionInfo({ source: result.source, warnings: result.warnings });
        const warningKey = result.warnings.includes('insecure')
          ? 'settings.agentletCommandCopiedInsecure'
          : result.warnings.includes('loopback')
            ? 'settings.agentletCommandCopiedLoopback'
            : result.source === 'generated'
              ? 'settings.agentletCommandCopiedGenerated'
              : format === 'env-file'
                ? 'settings.agentletEnvFileCopied'
                : 'settings.agentletCommandCopied';
        toast(t(warningKey), {
          tone:
            result.warnings.length > 0 || result.source === 'generated'
              ? 'warning'
              : 'success',
        });
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : t('settings.agentletCommandCopyFailed'),
          { tone: 'danger' },
        );
      } finally {
        setCopying(null);
      }
    },
    [connectionShell, t],
  );

  return (
    <div className="text-fg-default space-y-5 px-3.5 py-3 text-[13px] leading-6 [overflow-wrap:anywhere]">
      <p>{t('settings.agentletHowToConnectDescription')}</p>
      <ol className="list-decimal space-y-5 pl-5 marker:font-medium">
        <li className="pl-1">
          <h4 className="font-medium">{t('settings.agentletPrepareDevice')}</h4>
          <p className="text-fg-muted mt-1">
            {t('settings.agentletRequirements')}
          </p>
          <p className="text-fg-muted mt-2">
            {t('settings.agentletSourceSetup')}
          </p>
          <pre className="bg-bg-default border-edge-default my-2 overflow-x-auto rounded-md border p-3 text-xs leading-5">
            <code translate="no">
              {
                'git clone https://github.com/microsoft/Huabu.git\ncd Huabu\npnpm install'
              }
            </code>
          </pre>
        </li>
        <li className="pl-1">
          <h4 className="font-medium">{t('settings.agentletRunConnection')}</h4>
          <p className="text-fg-muted mt-1">
            {t('settings.agentletRunConnectionDescription')}
          </p>
          {localAccessOnly ? (
            <p role="status" className="text-warning mt-2">
              {t(localAccessHint)}
            </p>
          ) : null}
          <div className="mt-2 flex w-full flex-wrap items-center gap-2">
            <Select<ConnectionShell>
              appearance="field"
              options={[
                { value: 'posix', label: t('settings.agentletShellPosix') },
                { value: 'powershell', label: 'PowerShell' },
              ]}
              value={connectionShell}
              onChange={setConnectionShell}
              ariaLabel={t('settings.agentletTargetShell')}
              disabled={copying !== null}
            />
            <Button
              variant="solid"
              tone="info"
              size="field"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void copyConnection('command')}
              disabled={copying !== null}
            >
              {copying === 'command'
                ? t('settings.agentletCommandCopying')
                : t('settings.agentletCommandCopy')}
            </Button>
          </div>
          <p className="text-fg-muted mt-2">
            {t('settings.agentletConnectionTokenSecurityInfo')}
          </p>
          {connectionInfo &&
            (connectionInfo.source === 'generated' ||
              connectionInfo.warnings.length > 0) && (
              <div role="status" className="text-warning mt-2 space-y-1">
                {connectionInfo.source === 'generated' && (
                  <p>{t('settings.agentletGeneratedTokenWarning')}</p>
                )}
                {connectionInfo.warnings.includes('loopback') && (
                  <p>{t('settings.agentletLoopbackWarning')}</p>
                )}
                {connectionInfo.warnings.includes('insecure') && (
                  <p>{t('settings.agentletInsecureWarning')}</p>
                )}
              </div>
            )}
        </li>
        <li className="pl-1">
          <h4 className="font-medium">
            {t('settings.agentletCheckConnection')}
          </h4>
          <p className="text-fg-muted mt-1">
            {t('settings.agentletCheckConnectionDescription')}
          </p>
        </li>
      </ol>
      <div className="border-edge-default border-t pt-3">
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          className="focus-visible:outline-info justify-start px-0 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          onClick={() => setDetailsExpanded((expanded) => !expanded)}
        >
          <ChevronDown
            size={14}
            aria-hidden
            className={detailsExpanded ? '' : '-rotate-90'}
          />
          {t('settings.agentletOtherConnectionOptions')}
        </Button>
        {detailsExpanded && (
          <div id={detailsId} className="text-fg-muted mt-3 space-y-3">
            <p>{t('settings.agentletEnvFileInstructions')}</p>
            <Button
              variant="outline"
              tone="neutral"
              size="field"
              onClick={() => void copyConnection('env-file')}
              disabled={copying !== null}
            >
              {copying === 'env-file'
                ? t('settings.agentletCommandCopying')
                : t('settings.agentletEnvFileCopy')}
            </Button>
            <pre className="bg-bg-default text-fg-default border-edge-default overflow-x-auto rounded-md border p-3 text-xs leading-5">
              <code translate="no">
                {'pnpm start:daemon --env-file ./connection.env'}
              </code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
