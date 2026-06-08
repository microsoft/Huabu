import { Check, Copy, Key, LogIn, LogOut } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useLLMStore } from '@/store/llmStore';
import { copyToClipboard } from '@/utils/io/clipboard';

/**
 * LLM provider/model configuration section.
 * Handles provider & model selection, API key input, and OAuth login.
 */
export const LLMSettings: React.FC = () => {
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

  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [manualModel, setManualModel] = useState('');

  // ── Azure-specific form state ──
  // Azure OpenAI needs four discrete fields (endpoint, deployment, api
  // version, key) that none of the other providers expose, so it has its
  // own dedicated section instead of trying to overload the generic rows.
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [azureDeployment, setAzureDeployment] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('');
  const [azureApiKey, setAzureApiKey] = useState('');
  const isAzure = llmConfig?.provider === 'azure-openai';

  // Sync Azure form fields with the persisted config whenever it changes
  // (e.g. on initial load, after Save, or when switching to Azure).
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
      toast(llmError, { variant: 'error' });
    }
  }, [llmError]);

  const handleProviderChange = async (providerId: string) => {
    await llmLoadModels(providerId);
    setShowApiKeyInput(false);
    setApiKeyValue('');
    setManualModel('');
    // Send an empty model — the server restores this provider's
    // previously-saved model from its per-provider store, or auto-picks
    // a sensible default for built-in providers. Forcing the catalog's
    // first model here would overwrite the user's last choice.
    await llmUpdateConfig({ provider: providerId, model: '' });
  };

  const handleManualModelSave = async () => {
    const model = manualModel.trim();
    if (!model) return;
    const provider = llmConfig?.provider ?? '';
    await llmUpdateConfig({ provider, model });
  };

  const handleModelChange = async (modelId: string) => {
    const provider = llmConfig?.provider ?? '';
    await llmUpdateConfig({ provider, model: modelId });
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyValue.trim()) return;
    const provider = llmConfig?.provider ?? '';
    const model = llmConfig?.model ?? llmModels[0]?.id ?? '';
    await llmUpdateConfig({ provider, model, apiKey: apiKeyValue.trim() });
    setApiKeyValue('');
    setShowApiKeyInput(false);
  };

  const handleSaveAzure = async () => {
    const endpoint = azureEndpoint.trim();
    const deployment = azureDeployment.trim();
    const apiVersion = azureApiVersion.trim();
    const apiKey = azureApiKey.trim();
    // Endpoint + deployment are the minimum needed for the next LLM call
    // to even reach Azure; api version + key can be filled in later
    // (key, in particular, may already be persisted from a prior save).
    if (!endpoint || !deployment) return;
    await llmUpdateConfig({
      provider: 'azure-openai',
      model: deployment,
      baseUrl: endpoint,
      ...(apiVersion ? { apiVersion } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
    setAzureApiKey('');
  };

  const selectedProvider = llmProviders.find(
    (p) => p.id === llmConfig?.provider,
  );
  const isOAuth = selectedProvider?.authType === 'oauth';

  return (
    <SettingSection title="LLM Provider">
      <SettingRow title="Provider">
        <div className="w-44">
          <Select
            options={llmProviders.map((p) => ({ value: p.id, label: p.name }))}
            value={llmConfig?.provider ?? ''}
            onChange={(v) => void handleProviderChange(v)}
            disabled={llmSaving}
            placeholder="Select provider…"
          />
        </div>
      </SettingRow>

      {llmConfig?.provider && llmModels.length > 0 && !isAzure && (
        <SettingRow title="Model">
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
        <SettingRow title="Model">
          <div className="flex w-44 gap-1.5">
            <input
              type="text"
              placeholder="e.g. gpt-4o"
              value={manualModel}
              onChange={(e) => setManualModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleManualModelSave();
              }}
              className="border-edge-default bg-surface text-fg-muted focus:ring-info-light min-w-0 flex-1 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
            />
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => void handleManualModelSave()}
              disabled={!manualModel.trim() || llmSaving}
            >
              Save
            </Button>
          </div>
        </SettingRow>
      )}

      {/* Azure OpenAI — dedicated multi-field form */}
      {isAzure && (
        <>
          <SettingRow title="Endpoint" description="">
            <input
              type="text"
              placeholder="https://…cognitiveservices.azure.com"
              value={azureEndpoint}
              onChange={(e) => setAzureEndpoint(e.target.value)}
              className="border-edge-default bg-surface text-fg-muted focus:ring-info-light w-56 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
            />
          </SettingRow>

          <SettingRow title="Deployment" description="">
            <input
              type="text"
              placeholder="e.g. gpt-5-chat"
              value={azureDeployment}
              onChange={(e) => setAzureDeployment(e.target.value)}
              className="border-edge-default bg-surface text-fg-muted focus:ring-info-light w-56 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
            />
          </SettingRow>

          <SettingRow title="API Version" description="Optional.">
            <input
              type="text"
              placeholder="e.g. 2025-04-01-preview"
              value={azureApiVersion}
              onChange={(e) => setAzureApiVersion(e.target.value)}
              className="border-edge-default bg-surface text-fg-muted focus:ring-info-light w-56 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
            />
          </SettingRow>

          <SettingRow
            title="API Key"
            description={
              llmConfig?.authenticated
                ? 'A key is already saved — leave empty to keep it.'
                : 'Required to make requests to Azure OpenAI.'
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
                onChange={(e) => setAzureApiKey(e.target.value)}
                className="border-edge-default bg-surface text-fg-muted focus:ring-info-light w-44 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
              />
            </div>
          </SettingRow>

          <div className="flex justify-end px-3 py-2.5">
            <Button
              variant="outline"
              tone="neutral"
              size="sm"
              onClick={() => void handleSaveAzure()}
              disabled={
                !azureEndpoint.trim() || !azureDeployment.trim() || llmSaving
              }
            >
              Save
            </Button>
          </div>
        </>
      )}

      {/* OAuth auth row */}
      {llmConfig && isOAuth && !oauthPending && (
        <SettingRow title="Authentication">
          {llmConfig.authenticated ? (
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => void llmLogoutOAuth()}
            >
              <LogOut />
              Logout
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
              Login
            </Button>
          )}
        </SettingRow>
      )}

      {/* OAuth pending — full-width row */}
      {llmConfig && isOAuth && oauthPending && oauthUserCode && (
        <div className="bg-info-bg px-3 py-2.5">
          <p className="mb-1.5 text-xs">Enter this code at the opened page:</p>
          <div className="mb-1.5 flex items-center gap-2">
            <code className="bg-surface rounded px-2 py-1 font-mono text-lg font-bold">
              {oauthUserCode}
            </code>
            <Button
              variant="ghost"
              iconOnly
              size="sm"
              tone="info"
              title="Copy code"
              tooltipPlacement="bottom"
              onClick={() => void copyToClipboard(oauthUserCode)}
            >
              <Copy />
            </Button>
          </div>
          {oauthVerificationUri && (
            <p className="text-info mb-1.5 text-[11px]">
              Or visit:{' '}
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
            Cancel
          </Button>
        </div>
      )}

      {/* API key auth row */}
      {llmConfig && !isOAuth && !isAzure && (
        <SettingRow title="Authentication">
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
                ? 'Cancel'
                : llmConfig.authenticated
                  ? 'Update Key'
                  : 'Set API Key'}
            </Button>
          </div>
        </SettingRow>
      )}

      {/* API key input — full-width row */}
      {llmConfig && !isOAuth && !isAzure && showApiKeyInput && (
        <div className="flex gap-1.5 px-3 py-2.5">
          <input
            type="password"
            placeholder="sk-…"
            value={apiKeyValue}
            onChange={(e) => setApiKeyValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSaveApiKey();
            }}
            className="border-edge-default bg-surface text-fg-muted focus:ring-info-light flex-1 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
            autoFocus
          />
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={() => void handleSaveApiKey()}
            disabled={!apiKeyValue.trim() || llmSaving}
          >
            Save
          </Button>
        </div>
      )}
    </SettingSection>
  );
};
