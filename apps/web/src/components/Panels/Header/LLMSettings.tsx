import { Check, Copy, Key, LogIn, LogOut } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DEFAULT_IMAGE_MODEL_FAMILY,
  IMAGE_MODEL_FAMILIES,
  getImageCapabilities,
} from '@sediment/shared';

import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useLLMStore } from '@/store/llmStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import type {
  ImageModelFamily,
  LLMConfigUpdate,
  LLMImageConfigUpdate,
} from '@sediment/shared';

/** Default Azure API version we pre-fill into the Settings input. */
const DEFAULT_AZURE_IMAGE_API_VERSION = '2025-04-01-preview';

/** Static family options for the model-family dropdown. */
const IMAGE_MODEL_FAMILY_OPTIONS = IMAGE_MODEL_FAMILIES.map((f) => ({
  value: f,
  label: f,
}));

/**
 * Debounce a save callback so the parent can call it on every keystroke
 * but the network round-trip only fires after the user pauses typing
 * for {@link delay} ms. The callback is replaced lazily via a ref so
 * each save sees the latest closure (current store state, current
 * provider selection, …) without re-allocating the returned function.
 */
function useDebouncedSave<TArg>(
  fn: (arg: TArg) => void,
  delay = 600,
): (arg: TArg) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (arg: TArg) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(arg), delay);
    },
    [delay],
  );
}

const TEXT_INPUT_CLASS =
  'border-edge-default bg-surface text-fg-muted focus:ring-info-light rounded border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none';

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
  const llmConfig = useLLMStore((s) => s.config);
  const llmImageConfig = useLLMStore((s) => s.imageConfig);
  const llmProviders = useLLMStore((s) => s.providers);
  const llmModels = useLLMStore((s) => s.models);
  const llmSaving = useLLMStore((s) => s.saving);
  const llmError = useLLMStore((s) => s.error);
  const llmLoadModels = useLLMStore((s) => s.loadModels);
  const llmUpdateConfig = useLLMStore((s) => s.updateConfig);
  const llmUpdateImageConfig = useLLMStore((s) => s.updateImageConfig);

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

  // ── Image-provider form state ──
  // Currently only `azure-openai` is supported, so the provider Select
  // is a single-option dropdown today; structured this way so adding a
  // second image provider later is purely a data change.
  const [imgEndpoint, setImgEndpoint] = useState('');
  const [imgDeployment, setImgDeployment] = useState('');
  const [imgModelFamily, setImgModelFamily] = useState<ImageModelFamily>(
    DEFAULT_IMAGE_MODEL_FAMILY,
  );
  const [imgApiVersion, setImgApiVersion] = useState('');
  const [imgApiKey, setImgApiKey] = useState('');
  const [imgQuality, setImgQuality] = useState<
    'low' | 'medium' | 'high' | 'auto'
  >('low');

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

  // Sync image fields with the persisted image config.
  //
  // `apiVersion` is pre-filled with {@link DEFAULT_AZURE_IMAGE_API_VERSION}
  // when nothing has been saved yet — the API requires `2025-04-01-preview`
  // or later, and asking the user to look it up adds friction.
  // `modelFamily` falls back to {@link DEFAULT_IMAGE_MODEL_FAMILY}
  // which matches the server-side default in `getAzureImageConfig`.
  useEffect(() => {
    setImgEndpoint(llmImageConfig?.baseUrl ?? '');
    setImgDeployment(llmImageConfig?.model ?? '');
    setImgModelFamily(
      llmImageConfig?.modelFamily ?? DEFAULT_IMAGE_MODEL_FAMILY,
    );
    setImgApiVersion(
      llmImageConfig?.apiVersion ?? DEFAULT_AZURE_IMAGE_API_VERSION,
    );
    setImgApiKey('');
  }, [
    llmImageConfig?.baseUrl,
    llmImageConfig?.model,
    llmImageConfig?.modelFamily,
    llmImageConfig?.apiVersion,
  ]);

  // Image quality default depends on the selected family (see
  // shared capability registry). Recompute whenever the family or
  // persisted quality changes so the dropdown selection lines up with
  // what the server will actually use.
  useEffect(() => {
    const caps = getImageCapabilities(imgModelFamily);
    setImgQuality(llmImageConfig?.quality ?? caps.defaultQuality);
  }, [imgModelFamily, llmImageConfig?.quality]);

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

  const saveImage = useCallback(
    (patch: LLMImageConfigUpdate) => {
      void llmUpdateImageConfig({ provider: 'azure-openai', ...patch });
    },
    [llmUpdateImageConfig],
  );
  const debouncedSaveImage = useDebouncedSave(saveImage);

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

  // Image provider dropdown — only Azure supported today.
  const imageProviderOptions = useMemo(
    () => [{ value: 'azure-openai', label: 'Azure OpenAI' }],
    [],
  );

  return (
    <>
      <SettingSection title="LLM Provider" collapsible>
        <SettingRow title="Provider">
          <div className="w-44">
            <Select
              options={llmProviders.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
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
            <SettingRow title="Endpoint">
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

            <SettingRow title="Deployment">
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

            <SettingRow title="API Version">
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
            <p className="mb-1.5 text-xs">
              Enter this code at the opened page:
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

        {/* Generic (non-Azure, non-OAuth) API key row — auto-saves on input */}
        {llmConfig && !isOAuth && !isAzure && (
          <SettingRow
            title="API Key"
            description={
              llmConfig.authenticated
                ? 'A key is already saved — leave empty to keep it.'
                : 'Required to make requests to this provider.'
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
                  ? 'Cancel'
                  : llmConfig.authenticated
                    ? 'Update Key'
                    : 'Set API Key'}
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

      <SettingSection title="Image Provider" collapsible defaultCollapsed>
        <SettingRow title="Provider">
          <div className="w-44">
            <Select
              options={imageProviderOptions}
              value={llmImageConfig?.provider || 'azure-openai'}
              onChange={(v) => saveImage({ provider: v })}
              placeholder="Select provider…"
            />
          </div>
        </SettingRow>

        <SettingRow title="Endpoint">
          <input
            type="text"
            placeholder="https://…cognitiveservices.azure.com"
            value={imgEndpoint}
            onChange={(e) => {
              const v = e.target.value;
              setImgEndpoint(v);
              debouncedSaveImage({ baseUrl: v });
            }}
            className={`${TEXT_INPUT_CLASS} w-56`}
          />
        </SettingRow>

        <SettingRow title="Model">
          <div className="w-56">
            <Select
              options={IMAGE_MODEL_FAMILY_OPTIONS}
              value={imgModelFamily}
              onChange={(v) => {
                const next = v as ImageModelFamily;
                setImgModelFamily(next);
                saveImage({ modelFamily: next });
              }}
            />
          </div>
        </SettingRow>

        <SettingRow
          title="Deployment"
          description="Optional. Override only if your Azure deployment name differs from the model above."
        >
          <input
            type="text"
            placeholder={imgModelFamily}
            value={imgDeployment}
            onChange={(e) => {
              const v = e.target.value;
              setImgDeployment(v);
              debouncedSaveImage({ model: v });
            }}
            className={`${TEXT_INPUT_CLASS} w-56`}
          />
        </SettingRow>

        <SettingRow title="API Version" description="Optional.">
          <input
            type="text"
            placeholder="Use 2025-04-01-preview or later."
            value={imgApiVersion}
            onChange={(e) => {
              const v = e.target.value;
              setImgApiVersion(v);
              debouncedSaveImage({ apiVersion: v });
            }}
            className={`${TEXT_INPUT_CLASS} w-56`}
          />
        </SettingRow>

        <SettingRow title="Image Quality">
          <div className="w-56">
            <Select
              options={getImageCapabilities(imgModelFamily).qualities.map(
                (q) => {
                  const isDefault =
                    q === getImageCapabilities(imgModelFamily).defaultQuality;
                  return {
                    value: q,
                    label: isDefault ? `${q} (default)` : q,
                  };
                },
              )}
              value={imgQuality}
              onChange={(v) => {
                const next = v as 'low' | 'medium' | 'high' | 'auto';
                setImgQuality(next);
                saveImage({ quality: next });
              }}
            />
          </div>
        </SettingRow>

        <SettingRow
          title="API Key"
          description={
            llmImageConfig?.authenticated
              ? 'A key is already saved — leave empty to keep it.'
              : 'Required to call the image API.'
          }
        >
          <div className="flex items-center gap-1.5">
            {llmImageConfig?.authenticated ? (
              <Check size={14} className="text-success" />
            ) : (
              <Key size={14} className="text-warning" />
            )}
            <input
              type="password"
              placeholder={
                llmImageConfig?.authenticated ? '••••••••' : 'Azure key'
              }
              value={imgApiKey}
              onChange={(e) => {
                const v = e.target.value;
                setImgApiKey(v);
                if (v.trim()) debouncedSaveImage({ apiKey: v.trim() });
              }}
              className={`${TEXT_INPUT_CLASS} w-44`}
            />
          </div>
        </SettingRow>
      </SettingSection>
    </>
  );
};
