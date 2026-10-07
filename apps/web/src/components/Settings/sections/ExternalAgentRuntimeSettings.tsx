// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Info } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createAgentletConnectionCommand,
  getConnectionTokenConfig,
  getExternalAgentRuntimeConfig,
  updateConnectionToken,
  updateExternalAgentRuntimeConfig,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { copyToClipboard } from '@/utils/io/clipboard';

import type { ConnectionTokenConfig } from '@huabu/shared';

const IDLE_TIMEOUT_PRESETS = new Set(['0', '300', '600', '1800', '3600']);

export function ExternalAgentRuntimeSettings() {
  const { t } = useTranslation();
  const [idleTimeoutSecs, setIdleTimeoutSecs] = useState(600);
  const [maxAgents, setMaxAgents] = useState(10);
  const [maxAgentsInput, setMaxAgentsInput] = useState('10');
  const [idleTimeoutSelection, setIdleTimeoutSelection] = useState('600');
  const [customMinutes, setCustomMinutes] = useState('10');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tokenConfig, setTokenConfig] = useState<ConnectionTokenConfig | null>(
    null,
  );
  const [tokenInput, setTokenInput] = useState('');
  const [tokenLoading, setTokenLoading] = useState(true);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [copyingCommand, setCopyingCommand] = useState(false);

  useEffect(() => {
    let active = true;
    void getExternalAgentRuntimeConfig()
      .then((config) => {
        if (!active) return;
        const value = String(config.idleTimeoutSecs);
        setIdleTimeoutSecs(config.idleTimeoutSecs);
        setMaxAgents(config.maxAgents);
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

  useEffect(() => {
    let active = true;
    void getConnectionTokenConfig()
      .then((config) => {
        if (active) setTokenConfig(config);
      })
      .catch((error) => {
        if (!active) return;
        toast(
          error instanceof Error
            ? error.message
            : t('settings.agentletTokenLoadFailed'),
          { tone: 'danger' },
        );
      })
      .finally(() => {
        if (active) setTokenLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const saveIdleTimeout = useCallback(
    async (nextIdleTimeoutSecs: number) => {
      setSaving(true);
      try {
        const saved = await updateExternalAgentRuntimeConfig({
          idleTimeoutSecs: nextIdleTimeoutSecs,
          maxAgents,
        });
        setIdleTimeoutSecs(saved.idleTimeoutSecs);
        const value = String(saved.idleTimeoutSecs);
        setIdleTimeoutSelection(
          IDLE_TIMEOUT_PRESETS.has(value) ? value : 'custom',
        );
        toast(t('settings.externalAgentIdleTimeoutSaved'), {
          tone: 'success',
        });
      } catch (error) {
        const previous = String(idleTimeoutSecs);
        setIdleTimeoutSelection(
          IDLE_TIMEOUT_PRESETS.has(previous) ? previous : 'custom',
        );
        toast(
          error instanceof Error
            ? error.message
            : t('settings.externalAgentIdleTimeoutSaveFailed'),
          { tone: 'danger' },
        );
      } finally {
        setSaving(false);
      }
    },
    [idleTimeoutSecs, maxAgents, t],
  );

  const parsedMaxAgents = Number(maxAgentsInput);
  const maxAgentsValid =
    Number.isSafeInteger(parsedMaxAgents) && parsedMaxAgents >= 1;

  const saveMaxAgents = useCallback(async () => {
    if (!maxAgentsValid) return;
    setSaving(true);
    try {
      const saved = await updateExternalAgentRuntimeConfig({
        idleTimeoutSecs,
        maxAgents: parsedMaxAgents,
      });
      setMaxAgents(saved.maxAgents);
      setMaxAgentsInput(String(saved.maxAgents));
      toast(t('settings.externalAgentMaxAgentsSaved'), { tone: 'success' });
    } catch (error) {
      setMaxAgentsInput(String(maxAgents));
      toast(
        error instanceof Error
          ? error.message
          : t('settings.externalAgentMaxAgentsSaveFailed'),
        { tone: 'danger' },
      );
    } finally {
      setSaving(false);
    }
  }, [idleTimeoutSecs, maxAgents, maxAgentsValid, parsedMaxAgents, t]);

  const handleIdleTimeoutSelection = useCallback(
    (value: string) => {
      setIdleTimeoutSelection(value);
      if (value !== 'custom') void saveIdleTimeout(Number(value));
    },
    [saveIdleTimeout],
  );

  const parsedCustomMinutes = Number(customMinutes);
  const customMinutesValid =
    Number.isInteger(parsedCustomMinutes) &&
    parsedCustomMinutes >= 1 &&
    parsedCustomMinutes <= 1440;

  const saveConnectionToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token || !tokenConfig?.writable) return;
    setTokenSaving(true);
    try {
      setTokenConfig(await updateConnectionToken({ token }));
      setTokenInput('');
      toast(t('settings.agentletTokenSaved'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.agentletTokenSaveFailed'),
        { tone: 'danger' },
      );
    } finally {
      setTokenSaving(false);
    }
  }, [t, tokenConfig?.writable, tokenInput]);

  const clearConnectionToken = useCallback(async () => {
    if (!tokenConfig?.writable) return;
    setTokenSaving(true);
    try {
      setTokenConfig(await updateConnectionToken({ token: null }));
      setTokenInput('');
      toast(t('settings.agentletTokenCleared'), { tone: 'success' });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.agentletTokenSaveFailed'),
        { tone: 'danger' },
      );
    } finally {
      setTokenSaving(false);
    }
  }, [t, tokenConfig?.writable]);

  const copyConnectionCommand = useCallback(async () => {
    setCopyingCommand(true);
    try {
      const result = await createAgentletConnectionCommand();
      await copyToClipboard(result.command);
      const warningKey = result.warnings.includes('insecure')
        ? 'settings.agentletCommandCopiedInsecure'
        : result.warnings.includes('loopback')
          ? 'settings.agentletCommandCopiedLoopback'
          : 'settings.agentletCommandCopied';
      toast(t(warningKey), {
        tone: result.warnings.length > 0 ? 'warning' : 'success',
      });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t('settings.agentletCommandCopyFailed'),
        { tone: 'danger' },
      );
    } finally {
      setCopyingCommand(false);
    }
  }, [t]);

  return (
    <>
      <SettingRow
        layout="stacked"
        title={
          <span className="flex items-center gap-1">
            {t('settings.agentletConnectionToken')}
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              title={t('settings.agentletConnectionTokenSecurityInfo')}
              aria-label={t('settings.agentletConnectionTokenSecurityInfo')}
            >
              <Info />
            </Button>
          </span>
        }
        description={
          tokenConfig
            ? t('settings.agentletConnectionTokenDescription', {
                source: t(`settings.agentletTokenSource.${tokenConfig.source}`),
                access: tokenConfig.writable
                  ? ''
                  : t('settings.agentletTokenReadOnly'),
              })
            : t('settings.agentletConnectionTokenDescriptionLoading')
        }
      >
        <div className="flex w-full flex-wrap items-center gap-2">
          <TextInput
            id="agentlet-connection-token"
            className="min-w-40 flex-1 basis-56"
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveConnectionToken();
            }}
            placeholder={t('settings.agentletConnectionTokenPlaceholder')}
            aria-label={t('settings.agentletConnectionToken')}
            autoComplete="new-password"
            maxLength={512}
            disabled={
              tokenLoading || tokenSaving || tokenConfig?.writable !== true
            }
          />
          <Button
            variant="outline"
            tone="info"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={() => void saveConnectionToken()}
            disabled={
              !tokenInput.trim() ||
              tokenLoading ||
              tokenSaving ||
              tokenConfig?.writable !== true
            }
          >
            {t('settings.saveChanges')}
          </Button>
          {tokenConfig?.source === 'stored' ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void clearConnectionToken()}
              disabled={tokenSaving || !tokenConfig.writable}
            >
              {t('settings.agentletTokenClear')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            tone="info"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={() => void copyConnectionCommand()}
            disabled={tokenLoading || copyingCommand || !tokenConfig}
          >
            {copyingCommand
              ? t('settings.agentletCommandCopying')
              : t('settings.agentletCommandCopy')}
          </Button>
        </div>
      </SettingRow>
      <SettingRow
        title={t('settings.externalAgentIdleTimeout')}
        description={t('settings.externalAgentIdleTimeoutDescription')}
      >
        <div className="flex shrink-0 items-center gap-2">
          <Select
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
            disabled={loading || saving}
            title={t('settings.externalAgentIdleTimeout')}
          />
          {idleTimeoutSelection === 'custom' ? (
            <>
              <Input
                className="border-edge-default bg-surface text-fg-default focus:ring-info-light w-20 rounded-md border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                type="number"
                min={1}
                max={1440}
                step={1}
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && customMinutesValid) {
                    void saveIdleTimeout(parsedCustomMinutes * 60);
                  }
                }}
                aria-label={t('settings.customIdleTimeoutMinutes')}
                disabled={saving}
              />
              <span className="text-fg-muted text-xs">
                {t('settings.minutes')}
              </span>
              <Button
                variant="outline"
                tone="info"
                size="sm"
                onClick={() => void saveIdleTimeout(parsedCustomMinutes * 60)}
                disabled={!customMinutesValid || saving}
              >
                {t('settings.saveChanges')}
              </Button>
            </>
          ) : null}
        </div>
      </SettingRow>
      <SettingRow
        title={t('settings.externalAgentMaxAgents')}
        description={t('settings.externalAgentMaxAgentsDescription')}
      >
        <div className="flex shrink-0 items-center gap-2">
          <Input
            className="border-edge-default bg-surface text-fg-default focus:ring-info-light w-24 rounded-md border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            type="number"
            min={1}
            step={1}
            value={maxAgentsInput}
            onChange={(event) => setMaxAgentsInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveMaxAgents();
            }}
            aria-label={t('settings.externalAgentMaxAgents')}
            disabled={loading || saving}
          />
          <Button
            variant="outline"
            tone="info"
            size="sm"
            onClick={() => void saveMaxAgents()}
            disabled={
              !maxAgentsValid ||
              parsedMaxAgents === maxAgents ||
              loading ||
              saving
            }
          >
            {t('settings.saveChanges')}
          </Button>
        </div>
      </SettingRow>
    </>
  );
}
