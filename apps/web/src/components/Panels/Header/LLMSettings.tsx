import { Check, Copy, Key, LogIn, LogOut } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useLLMStore } from '@/store/llmStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import { TEXT_INPUT_CLASS, useDebouncedSave } from './settingsFormUtils';

import type { LLMConfigUpdate } from '@sediment/shared';

/**
 * LLM provider/model configuration section.
 *
 * Two independent sub-sections:
 *  - **LLM Provider** (chat) — drives `llmStream` / `llmComplete`. Any
 *    provider pi-ai knows about (OpenAI, Anthropic, Azure, Copilot …).
 *  - **Image Provider** (generate_image tool) — only Azure today, but
 *    fully decoupled from the chat provider, so users can pair a
 *    Copilot chat model with an Azure image deployment.
 *
 * Every field auto-saves on a 600 ms debounce after the last keystroke
 * — no Save button. Selecting from a `<Select>` saves immediately.
 */
export const LLMSettings: React.FC = () => {
  const { t } = useTranslation();
  const llmConfig = useLLMStore((s) => s.config);
  const llmProviders = useLLMStore((s) => s.providers);
  const llmModels = useLLMStore((s) => s.models);
  const llmSaving = useLLMStore((s) => s.saving);
  const llmError = useLLMStore((s) => s.error);
  const llmLoadModels = useLLMStore((s) => s.loadModels);
  const llmUpdateConfig = useLLMStore((s) => s.updateConfig);

  // OAuth
  const oauthPending = useLLMStore((s) => s.oauthPending);
  const oauthUserCode = useLLMStore((s) => s.oauthUserCode);
  const oauthVerificationUri = useLLMStore((s) => s.oauthVerificationUri);
  const startOAuth = useLLMStore((s) => s.startOAuth);
  const cancelOAuth = useLLMStore((s) => s.cancelOAuth);
  const llmLogoutOAuth = useLLMStore((s) => s.logoutOAuth);

  // ── Chat-provider form state ──
  // Azure needs four discrete fields (endpoint / deployment / api
  // version / key) that none of the other providers expose, so it
  // gets its own dedicated input cluster.
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [azureDeployment, setAzureDeployment] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('');
  const [azureApiKey, setAzureApiKey] = useState('');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [manualModel, setManualModel] = useState('');

  const isAzure = llmConfig?.provider === 'azure-openai';
  const selectedProvider = llmProviders.find(
    (p) => p.id === llmConfig?.provider,
  );
  const isOAuth = selectedProvider?.authType === 'oauth';

  // Sync chat Azure fields with the persisted config whenever it
  // changes (initial load, after auto-save, or when switching to
  // Azure). API key is never pre-filled — the server never returns it.
  useEffect(() => {
    if (!isAzure) return;
    setAzureEndpoint(llmConfig?.baseUrl ?? '');
    setAzureDeployment(llmConfig?.model ?? '');
    setAzureApiVersion(llmConfig?.apiVersion ?? '');
    setAzureApiKey('');
  }, [isAzure, llmConfig?.baseUrl, llmConfig?.model, llmConfig?.apiVersion]);

  // Surface store errors as transient toasts.
  useEffect(() => {
    if (llmError) {
      toast(llmError, { tone: 'danger' });
    }
  }, [llmError]);

  // ─── Debounced auto-savers ────────────────────────────────────────
  const saveChat = useCallback(
    (patch: Partial<LLMConfigUpdate>) => {
      const provider = llmConfig?.provider ?? '';
      if (!provider) return;
      void llmUpdateConfig({
        provider,
        model: llmConfig?.model ?? '',
        ...patch,
      });
    },
    [llmConfig?.provider, llmConfig?.model, llmUpdateConfig],
  );
  const debouncedSaveChat = useDebouncedSave(saveChat);

  // ─── Handlers ─────────────────────────────────────────────────────
  const handleProviderChange = async (providerId: string) => {
    await llmLoadModels(providerId);
    setShowApiKeyInput(false);
    setApiKeyValue('');
    setManualModel('');
    // Send an empty model — the server restores this provider's
    // previously-saved model from its per-provider store, or
    // auto-picks a sensible default for built-in providers. Forcing
    // the catalog's first model here would overwrite the user's
    // last choice.
    await llmUpdateConfig({ provider: providerId, model: '' });
  };

  const handleModelChange = async (modelId: string) => {
    const provider = llmConfig?.provider ?? '';
    await llmUpdateConfig({ provider, model: modelId });
  };

  return (
    <>
      <SettingSection title={t('settings.llmProvider')} collapsible>
        <SettingRow title={t('settings.provider')}>
          <div className="w-44">
            <Select
              options={llmProviders.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              value={llmConfig?.provider ?? ''}
              onChange={(v) => void handleProviderChange(v)}
              disabled={llmSaving}
              placeholder={t('settings.selectProvider')}
            />
          </div>
        </SettingRow>

        {llmConfig?.provider && llmModels.length > 0 && !isAzure && (
          <SettingRow title={t('settings.model')}>
            <div className="w-44">
              <Select
                options={llmModels.map((m) => ({
                  value: m.id,
                  label: m.name || m.id,
                }))}
                value={llmConfig?.model ?? ''}
                onChange={(v) => void handleModelChange(v)}
                disabled={llmSaving}
              />
            </div>
          </SettingRow>
        )}

        {llmConfig?.provider && llmModels.length === 0 && !isAzure && (
          <SettingRow title={t('settings.model')}>
            <input
              type="text"
              placeholder="e.g. gpt-4o"
              value={manualModel}
              onChange={(e) => {
                const v = e.target.value;
                setManualModel(v);
                debouncedSaveChat({ model: v.trim() });
              }}
              className={`${TEXT_INPUT_CLASS} w-44`}
            />
          </SettingRow>
        )}

        {/* Azure OpenAI — dedicated multi-field cluster */}
        {isAzure && (
          <>
            <SettingRow title={t('settings.endpoint')}>
              <input
                type="text"
                placeholder="https://…cognitiveservices.azure.com/openai/v1"
                value={azureEndpoint}
                onChange={(e) => {
                  const v = e.target.value;
                  setAzureEndpoint(v);
                  debouncedSaveChat({ baseUrl: v });
                }}
                className={`${TEXT_INPUT_CLASS} w-56`}
              />
            </SettingRow>

            <SettingRow title={t('settings.deployment')}>
              <input
                type="text"
                placeholder="e.g. gpt-5-chat"
                value={azureDeployment}
                onChange={(e) => {
                  const v = e.target.value;
                  setAzureDeployment(v);
                  debouncedSaveChat({ model: v });
                }}
                className={`${TEXT_INPUT_CLASS} w-56`}
              />
            </SettingRow>

            <SettingRow title={t('settings.apiVersion')}>
              <input
                type="text"
                placeholder="e.g. 2025-04-01-preview"
                value={azureApiVersion}
                onChange={(e) => {
                  const v = e.target.value;
                  setAzureApiVersion(v);
                  debouncedSaveChat({ apiVersion: v });
                }}
                className={`${TEXT_INPUT_CLASS} w-56`}
              />
            </SettingRow>

            <SettingRow
              title={t('settings.apiKey')}
              description={
                llmConfig?.authenticated
                  ? t('settings.savedKeyKeepEmpty')
                  : t('settings.azureKeyRequired')
              }
            >
              <div className="flex items-center gap-1.5">
                {llmConfig?.authenticated ? (
                  <Check size={14} className="text-success" />
                ) : (
                  <Key size={14} className="text-warning" />
                )}
                <input
                  type="password"
                  placeholder={
                    llmConfig?.authenticated ? '••••••••' : 'Azure key'
                  }
                  value={azureApiKey}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAzureApiKey(v);
                    if (v.trim()) debouncedSaveChat({ apiKey: v.trim() });
                  }}
                  className={`${TEXT_INPUT_CLASS} w-44`}
                />
              </div>
            </SettingRow>
          </>
        )}

        {/* OAuth auth row */}
        {llmConfig && isOAuth && !oauthPending && (
          <SettingRow title={t('settings.authentication')}>
            {llmConfig.authenticated ? (
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                onClick={() => void llmLogoutOAuth()}
              >
                <LogOut />
                {t('settings.logout')}
              </Button>
            ) : (
              <Button
                variant="outline"
                tone="info"
                size="sm"
                onClick={() => void startOAuth()}
                disabled={oauthPending}
              >
                <LogIn />
                {t('settings.login')}
              </Button>
            )}
          </SettingRow>
        )}

        {/* OAuth pending — full-width row */}
        {llmConfig && isOAuth && oauthPending && oauthUserCode && (
          <div className="bg-info-bg px-3 py-2.5">
            <p className="mb-1.5 text-xs">
              {t('settings.enterCodeAtOpenedPage')}
            </p>
            <div className="mb-1.5 flex items-center gap-2">
              <code className="bg-surface rounded px-2 py-1 font-mono text-lg font-bold">
                {oauthUserCode}
              </code>
              <Button
                variant="ghost"
                iconOnly
                size="sm"
                tone="info"
                title={t('settings.copyCode')}
                tooltipPlacement="bottom"
                onClick={() => void copyToClipboard(oauthUserCode)}
              >
                <Copy />
              </Button>
            </div>
            {oauthVerificationUri && (
              <p className="text-info mb-1.5 text-[11px]">
                {t('settings.orVisit')}{' '}
                <a
                  href={oauthVerificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {oauthVerificationUri}
                </a>
              </p>
            )}
            <Button variant="ghost" tone="info" size="sm" onClick={cancelOAuth}>
              {t('actions.cancel')}
            </Button>
          </div>
        )}

        {/* Generic (non-Azure, non-OAuth) API key row — auto-saves on input */}
        {llmConfig && !isOAuth && !isAzure && (
          <SettingRow
            title={t('settings.apiKey')}
            description={
              llmConfig.authenticated
                ? t('settings.savedKeyKeepEmpty')
                : t('settings.providerKeyRequired')
            }
          >
            <div className="flex items-center gap-1.5">
              {llmConfig.authenticated ? (
                <Check size={14} className="text-success" />
              ) : (
                <Key size={14} className="text-warning" />
              )}
              <Button
                variant="outline"
                tone="neutral"
                size="sm"
                onClick={() => setShowApiKeyInput(!showApiKeyInput)}
              >
                {showApiKeyInput
                  ? t('actions.cancel')
                  : llmConfig.authenticated
                    ? t('settings.updateKey')
                    : t('settings.setApiKey')}
              </Button>
            </div>
          </SettingRow>
        )}

        {llmConfig && !isOAuth && !isAzure && showApiKeyInput && (
          <div className="px-3 py-2.5">
            <input
              type="password"
              placeholder="sk-…"
              value={apiKeyValue}
              onChange={(e) => {
                const v = e.target.value;
                setApiKeyValue(v);
                if (v.trim()) debouncedSaveChat({ apiKey: v.trim() });
              }}
              className={`${TEXT_INPUT_CLASS} w-full`}
              autoFocus
            />
          </div>
        )}
      </SettingSection>
    </>
  );
};
