// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Check, LogIn, LogOut } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { TextInput } from '@/components/Common/TextInput';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { ApiKeyRow } from '@/components/Settings/Common/ApiKeyRow';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingLabel } from '@/components/Settings/Common/SettingLabel';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';
import { useLLMStore } from '@/store/llmStore';

import { OAuthDeviceCodePrompt } from './OAuthDeviceCodePrompt';
import { useDebouncedSave } from '../utils';

import type { LLMConfigUpdate, LLMUtilityConfigUpdate } from '@huabu/shared';

interface BaseUrlRowProps {
  description?: string;
  disabled: boolean;
  placeholder: string;
  title: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
}

const BaseUrlRow: React.FC<BaseUrlRowProps> = ({
  description,
  disabled,
  placeholder,
  title,
  value,
  onChange,
  onSave,
}) => {
  const debouncedSave = useDebouncedSave(onSave);

  return (
    <SettingRow title={title} description={description}>
      <SettingControl>
        <TextInput
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label={typeof title === 'string' ? title : undefined}
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange(nextValue);
            debouncedSave(nextValue.trim());
          }}
          disabled={disabled}
          className="w-full"
        />
      </SettingControl>
    </SettingRow>
  );
};

/**
 * LLM provider/model configuration section.
 *
 * Two independent sub-sections:
 *  - **LLM Provider** (chat) — drives `llmComplete` and the agent
 *    runtime. Any provider pi-ai knows about (OpenAI, Anthropic,
 *    Azure, Copilot …).
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
  const credentialWritesDisabled = useDeploymentReadinessStore(
    (s) => s.readiness?.credentials.writable === false,
  );

  // Utility-tier model
  const utilityConfig = useLLMStore((s) => s.utilityConfig);
  const utilityModels = useLLMStore((s) => s.utilityModels);
  const utilitySaving = useLLMStore((s) => s.utilitySaving);
  const loadUtilityModels = useLLMStore((s) => s.loadUtilityModels);
  const updateUtilityConfig = useLLMStore((s) => s.updateUtilityConfig);

  // OAuth
  const oauthPending = useLLMStore((s) => s.oauthPending);
  const oauthUserCode = useLLMStore((s) => s.oauthUserCode);
  const oauthVerificationUri = useLLMStore((s) => s.oauthVerificationUri);
  const startOAuth = useLLMStore((s) => s.startOAuth);
  const cancelOAuth = useLLMStore((s) => s.cancelOAuth);
  const llmLogoutOAuth = useLLMStore((s) => s.logoutOAuth);

  // ── Chat-provider form state ──
  // Azure needs deployment / API version fields that none of the other
  // providers expose, so those remain in a dedicated input cluster.
  const [chatBaseUrl, setChatBaseUrl] = useState('');
  const [azureDeployment, setAzureDeployment] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('');
  const [manualModel, setManualModel] = useState('');

  // ── Utility-tier form state ──
  const [utilityManualModel, setUtilityManualModel] = useState('');
  const [utilityBaseUrl, setUtilityBaseUrl] = useState('');
  const utilityFollowsChat = !utilityConfig?.provider;

  const isAzure = llmConfig?.provider === 'azure-openai';
  const selectedProvider = llmProviders.find(
    (p) => p.id === llmConfig?.provider,
  );
  const isOAuth = selectedProvider?.authType === 'oauth';
  const canOverrideBaseUrl = selectedProvider?.baseUrl.overridable ?? false;

  // The utility tier can target any provider independently of chat, so it
  // needs its own OAuth check: OAuth providers (e.g. Copilot) authenticate
  // via login — never an inline API key — and that login is shared with the
  // chat tier, so signing in once covers both.
  const utilitySelectedProvider = llmProviders.find(
    (p) => p.id === utilityConfig?.provider,
  );
  const isUtilityOAuth = utilitySelectedProvider?.authType === 'oauth';
  const canOverrideUtilityBaseUrl =
    utilitySelectedProvider?.baseUrl.overridable ?? false;

  useEffect(() => {
    setChatBaseUrl(llmConfig?.baseUrl ?? '');
  }, [llmConfig?.provider, llmConfig?.baseUrl]);

  // Sync the remaining chat Azure fields with the persisted config whenever it
  // changes (initial load, after auto-save, or when switching to
  // Azure). API key is never pre-filled — the server never returns it.
  useEffect(() => {
    if (!isAzure) return;
    setAzureDeployment(llmConfig?.model ?? '');
    setAzureApiVersion(llmConfig?.apiVersion ?? '');
  }, [isAzure, llmConfig?.model, llmConfig?.apiVersion]);

  // Surface store errors as persistent toasts: a provider/login failure is
  // actionable, so it must stay on screen with a × until the user
  // dismisses it rather than fading after a few seconds.
  useEffect(() => {
    if (llmError) {
      toast(llmError, { tone: 'danger', duration: 0 });
    }
  }, [llmError]);

  // ─── Debounced auto-savers ────────────────────────────────────────
  const saveChat = useCallback(
    (patch: Omit<LLMConfigUpdate, 'provider'>) => {
      const provider = llmConfig?.provider ?? '';
      if (!provider) return;
      void llmUpdateConfig({ provider, ...patch });
    },
    [llmConfig?.provider, llmUpdateConfig],
  );
  const debouncedSaveChat = useDebouncedSave(saveChat);

  // Utility-tier debounced saver (patches keep the current utility provider).
  const saveUtility = useCallback(
    (patch: Omit<LLMUtilityConfigUpdate, 'provider'>) => {
      const provider = utilityConfig?.provider ?? '';
      if (!provider) return;
      void updateUtilityConfig({ provider, ...patch });
    },
    [utilityConfig?.provider, updateUtilityConfig],
  );
  const debouncedSaveUtility = useDebouncedSave(saveUtility);

  // Keep the utility manual-model input in sync with persisted config.
  useEffect(() => {
    setUtilityManualModel(utilityConfig?.model ?? '');
    setUtilityBaseUrl(utilityConfig?.baseUrl ?? '');
  }, [utilityConfig?.provider, utilityConfig?.model, utilityConfig?.baseUrl]);

  // ── Utility handlers ──
  const handleUtilityFollowChange = async (follow: boolean) => {
    if (follow) {
      // Empty provider → follow the chat model.
      await updateUtilityConfig({ provider: '', model: '' });
      return;
    }
    // Seed with the current chat provider so the picker starts valid.
    const provider = llmConfig?.provider ?? '';
    if (provider) await loadUtilityModels(provider);
    await updateUtilityConfig({ provider, model: '' });
  };

  const handleUtilityProviderChange = async (providerId: string) => {
    await loadUtilityModels(providerId);
    await updateUtilityConfig({ provider: providerId, model: '' });
  };

  const handleUtilityModelChange = async (modelId: string) => {
    const provider = utilityConfig?.provider ?? '';
    if (!provider) return;
    await updateUtilityConfig({ provider, model: modelId });
  };

  // ─── Handlers ─────────────────────────────────────────────────────
  const handleProviderChange = async (providerId: string) => {
    await llmLoadModels(providerId);
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

  // A saved key changes which models the account is entitled to (OpenAI
  // `/v1/models`, Copilot entitlement), so refresh the list once the key
  // persists — the model picker renders after the key row.
  const handleSaveChatKey = async (key: string) => {
    const provider = llmConfig?.provider ?? '';
    if (!provider) return;
    await llmUpdateConfig({ provider, apiKey: key });
    await llmLoadModels(provider);
  };

  const handleSaveUtilityKey = async (key: string) => {
    const provider = utilityConfig?.provider ?? '';
    if (!provider) return;
    await updateUtilityConfig({ provider, apiKey: key });
    await loadUtilityModels(provider);
  };

  return (
    <>
      <SettingSection title={t('settings.chatModel')} collapsible>
        <SettingRow title={t('settings.provider')}>
          <SettingControl>
            <Select
              options={llmProviders.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              value={llmConfig?.provider ?? ''}
              onChange={(v) => void handleProviderChange(v)}
              disabled={llmSaving}
              placeholder={t('settings.selectProvider')}
              ariaLabel={t('settings.provider')}
              className="w-full"
            />
          </SettingControl>
        </SettingRow>

        {canOverrideBaseUrl && (
          <BaseUrlRow
            key={llmConfig?.provider}
            title={
              isAzure ? (
                t('settings.endpoint')
              ) : (
                <SettingLabel optional>{t('settings.baseUrl')}</SettingLabel>
              )
            }
            description={isAzure ? undefined : t('settings.baseUrlDescription')}
            placeholder={
              selectedProvider?.baseUrl.default ??
              'https://…cognitiveservices.azure.com/openai/v1'
            }
            value={chatBaseUrl}
            disabled={llmSaving}
            onChange={setChatBaseUrl}
            onSave={(baseUrl) => saveChat({ baseUrl })}
          />
        )}

        {/* Azure OpenAI — dedicated multi-field cluster */}
        {isAzure && (
          <>
            <SettingRow title={t('settings.deployment')}>
              <SettingControl>
                <TextInput
                  type="text"
                  aria-label={t('settings.deployment')}
                  placeholder="e.g. gpt-5-chat"
                  value={azureDeployment}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAzureDeployment(v);
                    debouncedSaveChat({ model: v });
                  }}
                  className="w-full"
                />
              </SettingControl>
            </SettingRow>

            <SettingRow title={t('settings.apiVersion')}>
              <SettingControl>
                <TextInput
                  type="text"
                  aria-label={t('settings.apiVersion')}
                  placeholder="e.g. 2025-04-01-preview"
                  value={azureApiVersion}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAzureApiVersion(v);
                    debouncedSaveChat({ apiVersion: v });
                  }}
                  className="w-full"
                />
              </SettingControl>
            </SettingRow>

            <ApiKeyRow
              title={t('settings.apiKey')}
              description={
                llmConfig?.authenticated
                  ? t('settings.savedKeyKeepEmpty')
                  : t('settings.azureKeyRequired')
              }
              saved={llmConfig?.authenticated ?? false}
              placeholder="Azure key"
              disabled={credentialWritesDisabled}
              saving={llmSaving}
              onSave={(key) => saveChat({ apiKey: key })}
            />
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
                disabled={credentialWritesDisabled}
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
                disabled={oauthPending || credentialWritesDisabled}
              >
                <LogIn />
                {t('settings.login')}
              </Button>
            )}
          </SettingRow>
        )}

        {/* OAuth pending — full-width row */}
        {llmConfig && isOAuth && oauthPending && oauthUserCode && (
          <OAuthDeviceCodePrompt
            userCode={oauthUserCode}
            verificationUri={oauthVerificationUri}
            onCancel={cancelOAuth}
          />
        )}

        {/* Generic API-key providers use the shared intentional edit flow. */}
        {llmConfig && !isOAuth && !isAzure && (
          <ApiKeyRow
            title={t('settings.apiKey')}
            description={
              llmConfig.authenticated
                ? t('settings.savedKeyKeepEmpty')
                : t('settings.providerKeyRequired')
            }
            saved={llmConfig.authenticated}
            placeholder="sk-…"
            disabled={credentialWritesDisabled}
            saving={llmSaving}
            onSave={handleSaveChatKey}
          />
        )}

        {/* Model picker comes last: for account-based providers the list is
            only accurate once the key / login above is configured. */}
        {llmConfig?.provider && llmModels.length > 0 && !isAzure && (
          <SettingRow
            title={t(
              llmModels.length > 1 ? 'settings.defaultModel' : 'settings.model',
            )}
            description={
              llmModels.length > 1
                ? t('settings.chatModelDefaultDesc')
                : undefined
            }
          >
            <SettingControl>
              <Select
                options={llmModels.map((m) => ({
                  value: m.id,
                  label: m.name || m.id,
                }))}
                value={llmConfig?.model ?? ''}
                onChange={(v) => void handleModelChange(v)}
                disabled={llmSaving}
                ariaLabel={t(
                  llmModels.length > 1
                    ? 'settings.defaultModel'
                    : 'settings.model',
                )}
                className="w-full"
              />
            </SettingControl>
          </SettingRow>
        )}

        {llmConfig?.provider && llmModels.length === 0 && !isAzure && (
          <SettingRow title={t('settings.model')}>
            <SettingControl>
              <TextInput
                type="text"
                aria-label={t('settings.model')}
                placeholder="e.g. gpt-4o"
                value={manualModel}
                onChange={(e) => {
                  const v = e.target.value;
                  setManualModel(v);
                  debouncedSaveChat({ model: v.trim() });
                }}
                className="w-full"
              />
            </SettingControl>
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection title={t('settings.utilityModel')} collapsible>
        <SettingRow
          title={t('settings.followChatModel')}
          description={t('settings.utilityModelDesc')}
        >
          <Toggle
            checked={utilityFollowsChat}
            onChange={(follow) => void handleUtilityFollowChange(follow)}
            disabled={utilitySaving}
            label={t('settings.followChatModel')}
          />
        </SettingRow>

        {!utilityFollowsChat && (
          <>
            <SettingRow title={t('settings.provider')}>
              <SettingControl>
                <Select
                  options={llmProviders.map((p) => ({
                    value: p.id,
                    label: p.name,
                  }))}
                  value={utilityConfig?.provider ?? ''}
                  onChange={(v) => void handleUtilityProviderChange(v)}
                  disabled={utilitySaving}
                  placeholder={t('settings.selectProvider')}
                  ariaLabel={t('settings.provider')}
                  className="w-full"
                />
              </SettingControl>
            </SettingRow>

            {canOverrideUtilityBaseUrl && (
              <BaseUrlRow
                key={utilityConfig?.provider}
                title={
                  utilityConfig?.provider === 'azure-openai' ? (
                    t('settings.endpoint')
                  ) : (
                    <SettingLabel optional>
                      {t('settings.baseUrl')}
                    </SettingLabel>
                  )
                }
                description={
                  utilityConfig?.provider === 'azure-openai'
                    ? undefined
                    : t('settings.baseUrlDescription')
                }
                placeholder={
                  utilitySelectedProvider?.baseUrl.default ??
                  'https://…cognitiveservices.azure.com/openai/v1'
                }
                value={utilityBaseUrl}
                disabled={utilitySaving}
                onChange={setUtilityBaseUrl}
                onSave={(baseUrl) => saveUtility({ baseUrl })}
              />
            )}

            {/* OAuth providers (e.g. Copilot) authenticate via login, which
                is shared with the chat tier — never an inline API key. */}
            {utilityConfig && isUtilityOAuth ? (
              utilityConfig.authenticated ? (
                <SettingRow
                  title={t('settings.authentication')}
                  description={t('settings.utilityUsesLogin')}
                >
                  <Check size={14} className="text-success" />
                </SettingRow>
              ) : (
                <SettingRow
                  title={t('settings.authentication')}
                  description={t('settings.utilityLoginRequired')}
                >
                  <Button
                    variant="outline"
                    tone="info"
                    size="sm"
                    onClick={() => void startOAuth()}
                    disabled={oauthPending || credentialWritesDisabled}
                  >
                    <LogIn />
                    {t('settings.login')}
                  </Button>
                </SettingRow>
              )
            ) : (
              utilityConfig && (
                <ApiKeyRow
                  title={t('settings.apiKey')}
                  description={
                    utilityConfig.authenticated
                      ? t('settings.savedKeyKeepEmpty')
                      : t('settings.providerKeyRequired')
                  }
                  saved={utilityConfig.authenticated}
                  placeholder="sk-…"
                  disabled={credentialWritesDisabled}
                  saving={utilitySaving}
                  onSave={handleSaveUtilityKey}
                />
              )
            )}

            {/* Model picker last — account-based lists need the key/login
                above configured first. */}
            {utilityModels.length > 0 ? (
              <SettingRow title={t('settings.model')}>
                <SettingControl>
                  <Select
                    options={utilityModels.map((m) => ({
                      value: m.id,
                      label: m.name || m.id,
                    }))}
                    value={utilityConfig?.model ?? ''}
                    onChange={(v) => void handleUtilityModelChange(v)}
                    disabled={utilitySaving}
                    ariaLabel={t('settings.model')}
                    className="w-full"
                  />
                </SettingControl>
              </SettingRow>
            ) : (
              <SettingRow title={t('settings.model')}>
                <SettingControl>
                  <TextInput
                    type="text"
                    aria-label={t('settings.model')}
                    placeholder="e.g. gpt-4o-mini"
                    value={utilityManualModel}
                    onChange={(e) => {
                      const v = e.target.value;
                      setUtilityManualModel(v);
                      debouncedSaveUtility({ model: v.trim() });
                    }}
                    className="w-full"
                  />
                </SettingControl>
              </SettingRow>
            )}
          </>
        )}
      </SettingSection>
    </>
  );
};
