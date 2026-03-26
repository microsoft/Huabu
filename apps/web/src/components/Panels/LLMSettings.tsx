import {
  Bot,
  Check,
  ChevronDown,
  ClipboardCopy,
  Key,
  LogIn,
  LogOut,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useLLMStore } from '../../store/llmStore';
import { Button } from '../Common/Button';
import { IconButton } from '../Common/IconButton';

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
  const [llmSuccess, setLlmSuccess] = useState(false);
  const llmSuccessRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (llmSuccessRef.current !== null) {
        clearTimeout(llmSuccessRef.current);
      }
    };
  }, []);

  const flashLlmSuccess = useCallback(() => {
    setLlmSuccess(true);
    if (llmSuccessRef.current !== null) clearTimeout(llmSuccessRef.current);
    llmSuccessRef.current = window.setTimeout(() => {
      setLlmSuccess(false);
      llmSuccessRef.current = null;
    }, 2000);
  }, []);

  const handleProviderChange = async (
    e: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const providerId = e.target.value;
    await llmLoadModels(providerId);
    setShowApiKeyInput(false);
    setApiKeyValue('');

    const freshModels = useLLMStore.getState().models;
    if (freshModels.length > 0) {
      const firstModel = freshModels[0].id;
      setManualModel('');
      await llmUpdateConfig({ provider: providerId, model: firstModel });
      flashLlmSuccess();
    } else {
      setManualModel('');
      await llmUpdateConfig({ provider: providerId, model: '' });
    }
  };

  const handleManualModelSave = async () => {
    const model = manualModel.trim();
    if (!model) return;
    const provider = llmConfig?.provider ?? '';
    await llmUpdateConfig({ provider, model });
    flashLlmSuccess();
  };

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const modelId = e.target.value;
    const provider = llmConfig?.provider ?? '';
    await llmUpdateConfig({ provider, model: modelId });
    flashLlmSuccess();
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyValue.trim()) return;
    const provider = llmConfig?.provider ?? '';
    const model = llmConfig?.model ?? llmModels[0]?.id ?? '';
    await llmUpdateConfig({ provider, model, apiKey: apiKeyValue.trim() });
    setApiKeyValue('');
    setShowApiKeyInput(false);
    flashLlmSuccess();
  };

  const selectedProvider = llmProviders.find(
    (p) => p.id === llmConfig?.provider,
  );
  const isOAuth = selectedProvider?.authType === 'oauth';

  return (
    <div className="border-border mb-3 border-t pt-3">
      <label className="text-fg-muted mb-1.5 block text-xs font-medium">
        <Bot size={12} className="mr-1 inline" />
        LLM Provider
      </label>

      {/* Provider select */}
      <div className="relative mb-2">
        <select
          id="llm-provider-select"
          className="border-border bg-surface text-fg-muted focus:ring-info-light w-full appearance-none rounded border py-1.5 pr-8 pl-2.5 text-sm focus:ring-1 focus:outline-none"
          value={llmConfig?.provider ?? ''}
          onChange={(e) => void handleProviderChange(e)}
          disabled={llmSaving}
        >
          {!llmConfig?.provider && (
            <option value="" disabled>
              Select provider…
            </option>
          )}
          {llmProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="text-fg-subtle pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
        />
      </div>

      {/* Model select / manual input */}
      {llmConfig?.provider && (
        <>
          <label className="text-fg-muted mb-1.5 block text-xs font-medium">
            Model
          </label>
          {llmModels.length > 0 ? (
            <div className="relative mb-2">
              <select
                className="border-border bg-surface text-fg-muted focus:ring-info-light w-full appearance-none rounded border py-1.5 pr-8 pl-2.5 text-sm focus:ring-1 focus:outline-none"
                value={llmConfig?.model ?? ''}
                onChange={(e) => void handleModelChange(e)}
                disabled={llmSaving}
              >
                {llmModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="text-fg-subtle pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
              />
            </div>
          ) : (
            <div className="mb-2 flex gap-1.5">
              <input
                type="text"
                placeholder="Enter model ID, e.g. gpt-4o"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleManualModelSave();
                }}
                className="border-border bg-surface text-fg-muted focus:ring-info-light flex-1 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleManualModelSave()}
                disabled={!manualModel.trim() || llmSaving}
              >
                Save
              </Button>
            </div>
          )}
        </>
      )}

      {/* Auth status */}
      {llmConfig && isOAuth && (
        <>
          {oauthPending && oauthUserCode ? (
            <div className="border-info-light bg-info-bg mb-2 rounded border p-2.5">
              <p className="mb-1.5 text-xs">
                Enter this code at the opened page:
              </p>
              <div className="mb-1.5 flex items-center gap-2">
                <code className="bg-surface rounded px-2 py-1 font-mono text-lg font-bold">
                  {oauthUserCode}
                </code>
                <IconButton
                  title="Copy code"
                  onClick={() =>
                    void navigator.clipboard.writeText(oauthUserCode)
                  }
                  className="text-info"
                >
                  <ClipboardCopy size={14} />
                </IconButton>
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
              <Button
                variant="ghost"
                size="sm"
                className="text-info text-[11px]"
                onClick={cancelOAuth}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="mb-2 flex items-center gap-1.5 text-xs">
              {llmConfig.authenticated ? (
                <>
                  <Check size={12} className="text-success-light" />
                  <span className="text-success">Authenticated via GitHub</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-[11px]"
                    onClick={() => void llmLogoutOAuth()}
                  >
                    <LogOut size={11} className="mr-0.5" />
                    Logout
                  </Button>
                </>
              ) : (
                <>
                  <Key size={12} className="text-warning-light" />
                  <span className="text-warning">Login required</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-[11px]"
                    onClick={() => void startOAuth()}
                    disabled={oauthPending}
                  >
                    <LogIn size={11} className="mr-0.5" />
                    Login with GitHub
                  </Button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Standard API key auth */}
      {llmConfig && !isOAuth && (
        <>
          <div className="mb-2 flex items-center gap-1.5 text-xs">
            {llmConfig.authenticated ? (
              <>
                <Check size={12} className="text-success-light" />
                <span className="text-success">Authenticated</span>
              </>
            ) : (
              <>
                <Key size={12} className="text-warning-light" />
                <span className="text-warning">API key required</span>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-[11px]"
              onClick={() => setShowApiKeyInput(!showApiKeyInput)}
            >
              {showApiKeyInput ? 'Cancel' : 'Set API Key'}
            </Button>
          </div>

          {showApiKeyInput && (
            <div className="mb-2 flex gap-1.5">
              <input
                type="password"
                placeholder="sk-…"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveApiKey();
                }}
                className="border-border bg-surface text-fg-muted focus:ring-info-light flex-1 rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none"
                autoFocus
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleSaveApiKey()}
                disabled={!apiKeyValue.trim() || llmSaving}
              >
                Save
              </Button>
            </div>
          )}
        </>
      )}

      {llmError && <p className="text-danger mb-2 text-xs">{llmError}</p>}
      {llmSuccess && (
        <p className="text-success mb-2 text-xs">LLM config updated!</p>
      )}
    </div>
  );
};
