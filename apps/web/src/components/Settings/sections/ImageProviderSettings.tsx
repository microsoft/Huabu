import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_AZURE_IMAGE_API_VERSION,
  DEFAULT_IMAGE_MODEL_FAMILY,
  IMAGE_MODEL_FAMILIES,
  getImageCapabilities,
} from '@sediment/shared';

import { ApiKeyRow } from '@/components/Common/ApiKeyRow';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { TextInput } from '@/components/Common/TextInput';
import { useLLMStore } from '@/store/llmStore';

import { useDebouncedSave } from '../utils';

import type { ImageModelFamily, LLMImageConfigUpdate } from '@sediment/shared';

/** Static family options for the model-family dropdown. */
const IMAGE_MODEL_FAMILY_OPTIONS = IMAGE_MODEL_FAMILIES.map((f) => ({
  value: f,
  label: f,
}));

/**
 * Image-generation provider configuration — the credentials behind the
 * agent's `generate_image` capability. Independent of the chat LLM
 * provider (its own store slice + `/api/llm/image-config` endpoint), so
 * users can pair any chat model with a separate Azure image deployment.
 *
 * Today only `azure-openai` is supported; the provider Select is a
 * single-option dropdown, structured so adding a second image provider
 * later is purely a data change.
 *
 * Every field auto-saves on a 600 ms debounce after the last keystroke —
 * no Save button. Selecting from a `<Select>` saves immediately.
 */
export const ImageProviderSettings: React.FC = () => {
  const { t } = useTranslation();
  const llmImageConfig = useLLMStore((s) => s.imageConfig);
  const llmImageSaving = useLLMStore((s) => s.imageSaving);
  const llmUpdateImageConfig = useLLMStore((s) => s.updateImageConfig);

  const [imgEndpoint, setImgEndpoint] = useState('');
  const [imgDeployment, setImgDeployment] = useState('');
  const [imgModelFamily, setImgModelFamily] = useState<ImageModelFamily>(
    DEFAULT_IMAGE_MODEL_FAMILY,
  );
  const [imgApiVersion, setImgApiVersion] = useState('');
  const [imgQuality, setImgQuality] = useState<
    'low' | 'medium' | 'high' | 'auto'
  >('low');

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
  }, [
    llmImageConfig?.baseUrl,
    llmImageConfig?.model,
    llmImageConfig?.modelFamily,
    llmImageConfig?.apiVersion,
  ]);

  // Image quality default depends on the selected family (see shared
  // capability registry). Recompute whenever the family or persisted
  // quality changes so the dropdown lines up with what the server uses.
  useEffect(() => {
    const caps = getImageCapabilities(imgModelFamily);
    setImgQuality(llmImageConfig?.quality ?? caps.defaultQuality);
  }, [imgModelFamily, llmImageConfig?.quality]);

  const saveImage = useCallback(
    (patch: LLMImageConfigUpdate) => {
      void llmUpdateImageConfig({ provider: 'azure-openai', ...patch });
    },
    [llmUpdateImageConfig],
  );
  const debouncedSaveImage = useDebouncedSave(saveImage);

  // Image provider dropdown — only Azure supported today.
  const imageProviderOptions = useMemo(
    () => [{ value: 'azure-openai', label: 'Azure OpenAI' }],
    [],
  );

  return (
    <SettingSection title={t('settings.imageGeneration')} collapsible>
      <SettingRow title={t('settings.provider')}>
        <div className="w-44">
          <Select
            options={imageProviderOptions}
            value={llmImageConfig?.provider || 'azure-openai'}
            onChange={(v) => saveImage({ provider: v })}
            placeholder={t('settings.selectProvider')}
          />
        </div>
      </SettingRow>

      <SettingRow title={t('settings.endpoint')}>
        <TextInput
          type="text"
          placeholder="https://…cognitiveservices.azure.com"
          value={imgEndpoint}
          onChange={(e) => {
            const v = e.target.value;
            setImgEndpoint(v);
            debouncedSaveImage({ baseUrl: v });
          }}
          className="w-56"
        />
      </SettingRow>

      <SettingRow title={t('settings.model')}>
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
        title={t('settings.deployment')}
        description={t('settings.deploymentOptional')}
      >
        <TextInput
          type="text"
          placeholder={imgModelFamily}
          value={imgDeployment}
          onChange={(e) => {
            const v = e.target.value;
            setImgDeployment(v);
            debouncedSaveImage({ model: v });
          }}
          className="w-56"
        />
      </SettingRow>

      <SettingRow
        title={t('settings.apiVersion')}
        description={t('settings.optional')}
      >
        <TextInput
          type="text"
          placeholder={t('settings.imageApiVersionPlaceholder')}
          value={imgApiVersion}
          onChange={(e) => {
            const v = e.target.value;
            setImgApiVersion(v);
            debouncedSaveImage({ apiVersion: v });
          }}
          className="w-56"
        />
      </SettingRow>

      <SettingRow title={t('settings.imageQuality')}>
        <div className="w-56">
          <Select
            options={getImageCapabilities(imgModelFamily).qualities.map((q) => {
              const isDefault =
                q === getImageCapabilities(imgModelFamily).defaultQuality;
              return {
                value: q,
                label: isDefault
                  ? t('settings.defaultSuffix', { value: q })
                  : q,
              };
            })}
            value={imgQuality}
            onChange={(v) => {
              const next = v as 'low' | 'medium' | 'high' | 'auto';
              setImgQuality(next);
              saveImage({ quality: next });
            }}
          />
        </div>
      </SettingRow>

      <ApiKeyRow
        title={t('settings.apiKey')}
        description={
          llmImageConfig?.authenticated
            ? undefined
            : t('settings.imageKeyRequired')
        }
        saved={llmImageConfig?.authenticated ?? false}
        placeholder="Azure key"
        saving={llmImageSaving}
        onSave={(key) => saveImage({ apiKey: key })}
      />
    </SettingSection>
  );
};
