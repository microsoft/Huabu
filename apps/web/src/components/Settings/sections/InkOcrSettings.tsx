// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Key, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import { getInkOcrConfig, putInkOcrConfig } from '@/api/inkOcr';
import { Button } from '@/components/Common/Button';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';

import type { InkOcrConfig, InkOcrConfigUpdate } from '@huabu/shared';
import type { KeyboardEvent } from 'react';

export function InkOcrSettings() {
  const { t } = useTranslation();
  const endpointId = useId();
  const apiKeyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<InkOcrConfig | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const configWritesEnabled = useDeploymentReadinessStore(
    (state) =>
      state.readiness?.credentials.writable === true &&
      !state.loading &&
      !state.error,
  );
  const readinessUnknown = useDeploymentReadinessStore(
    (state) => !state.readiness || state.loading,
  );
  const readinessError = useDeploymentReadinessStore((state) => state.error);
  const loadReadiness = useDeploymentReadinessStore((state) => state.load);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void getInkOcrConfig()
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setEndpoint(next.endpoint ?? '');
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  async function save(update: InkOcrConfigUpdate) {
    if (savingRef.current || !config || !configWritesEnabled) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await putInkOcrConfig(update);
      setConfig(next);
      if ('endpoint' in update || endpoint.trim() === (config.endpoint ?? '')) {
        setEndpoint(next.endpoint ?? '');
      }
      setApiKey('');
      setExpanded(false);
      toast(t('settings.inkOcr.saved'), { tone: 'success' });
    } catch (error) {
      const message =
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === 'validation_failed'
          ? error.message
          : t('settings.inkOcr.saveFailed');
      setSaveError(message);
      toast(message, { tone: 'danger' });
      // Persistence may succeed before acknowledgement fails. Refresh status, not drafts.
      try {
        setConfig(await getInkOcrConfig());
      } catch {
        // Keep the explicit save error and retryable drafts if refresh fails.
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const endpointChanged = endpoint.trim() !== (config?.endpoint ?? '');
  const keyChanged = apiKey.trim().length > 0;
  const canSave =
    !saving && configWritesEnabled && (endpointChanged || keyChanged);

  function saveChanges() {
    if (!canSave) return;
    void save({
      ...(endpointChanged ? { endpoint: endpoint.trim() || null } : {}),
      ...(keyChanged ? { apiKey: apiKey.trim() } : {}),
    });
  }

  function cancel() {
    if (savingRef.current) return;
    setApiKey('');
    setEndpoint(config?.endpoint ?? '');
    setExpanded(false);
    setSaveError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        saveChanges();
      }}
    >
      <SettingSection>
        <SettingRow
          title={t('settings.inkOcr.title')}
          description={t('settings.inkOcr.description')}
        >
          {loading ? (
            <span role="status" className="text-fg-muted text-xs">
              {t('settings.inkOcr.loading')}
            </span>
          ) : loadFailed || !config ? (
            <div className="flex items-center gap-2">
              <span role="alert" className="text-danger text-xs">
                {t('settings.inkOcr.loadFailed')}
              </span>
              <Button
                type="button"
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {t('settings.inkOcr.retry')}
              </Button>
            </div>
          ) : expanded ? null : (
            <div className="flex items-center gap-2">
              <Key
                size={14}
                className={config.configured ? 'text-success' : 'text-warning'}
                aria-label={
                  config.configured
                    ? t('settings.inkOcr.configured')
                    : t('settings.inkOcr.notConfigured')
                }
              />
              <Button
                type="button"
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={() => setExpanded(true)}
              >
                {config.keySource !== 'none'
                  ? t('settings.updateKey')
                  : t('settings.setApiKey')}
              </Button>
            </div>
          )}
        </SettingRow>
        {expanded && config && !loading && !loadFailed ? (
          <>
            <SettingRow
              title={t('settings.inkOcr.endpointLabel')}
              labelFor={endpointId}
            >
              <SettingControl>
                <TextInput
                  id={endpointId}
                  type="url"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="https://resource.cognitiveservices.azure.com"
                  title={
                    config.endpointSource === 'environment'
                      ? t('settings.inkOcr.environmentEndpoint')
                      : undefined
                  }
                  disabled={saving || !configWritesEnabled}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full"
                  wrapperClassName="w-full"
                  autoFocus
                />
              </SettingControl>
            </SettingRow>
            <SettingRow
              title={t('settings.inkOcr.apiKeyLabel')}
              labelFor={apiKeyId}
            >
              <SettingControl>
                <div className="flex min-w-0 items-center gap-1.5">
                  <TextInput
                    id={apiKeyId}
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('settings.inkOcr.apiKeyPlaceholder')}
                    title={
                      config.keySource === 'environment'
                        ? t('settings.inkOcr.environmentKey')
                        : undefined
                    }
                    disabled={saving || !configWritesEnabled}
                    autoComplete="off"
                    className="w-full min-w-0 flex-1"
                    wrapperClassName="min-w-0 flex-1"
                  />
                  {config.hasStoredKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      tone="neutral"
                      size="sm"
                      aria-label={t('settings.inkOcr.removeStoredKey')}
                      title={t('settings.inkOcr.removeStoredKey')}
                      disabled={saving || !configWritesEnabled}
                      onClick={() => void save({ apiKey: null })}
                    >
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </SettingControl>
            </SettingRow>
            <SettingRow>
              <SettingControl className="flex flex-col gap-3">
                {!configWritesEnabled ? (
                  <p className="text-fg-muted text-xs">
                    {readinessUnknown
                      ? t('settings.inkOcr.readinessPending')
                      : t('settings.inkOcr.readOnly')}
                  </p>
                ) : null}
                {readinessError ? (
                  <Button
                    type="button"
                    variant="outline"
                    tone="neutral"
                    size="sm"
                    onClick={() => void loadReadiness()}
                  >
                    {t('settings.inkOcr.retryReadiness')}
                  </Button>
                ) : null}
                {saveError ? (
                  <p role="alert" className="text-danger text-xs">
                    {saveError}
                  </p>
                ) : null}
                <div className="flex items-center justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    tone="neutral"
                    size="sm"
                    onClick={cancel}
                    disabled={saving}
                  >
                    {t('actions.cancel')}
                  </Button>
                  <Button
                    type="submit"
                    tone="neutral"
                    size="sm"
                    disabled={!canSave}
                  >
                    {saving ? t('settings.saving') : t('actions.save')}
                  </Button>
                </div>
              </SettingControl>
            </SettingRow>
          </>
        ) : null}
      </SettingSection>
    </form>
  );
}
