// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/Common/Toast';
import { ApiKeyRow } from '@/components/Settings/Common/ApiKeyRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDeploymentReadinessStore } from '@/store/deploymentReadinessStore';
import { useIntegrationsStore } from '@/store/integrationsStore';

/**
 * Third-party integration credentials (Tavily web search, RapidAPI
 * YouTube transcripts). Keys are stored server-side; environment
 * variables remain a fallback for headless deployments.
 */
export const IntegrationsSettings: React.FC = () => {
  const { t } = useTranslation();
  const config = useIntegrationsStore((s) => s.config);
  const saving = useIntegrationsStore((s) => s.saving);
  const error = useIntegrationsStore((s) => s.error);
  const init = useIntegrationsStore((s) => s.init);
  const updateConfig = useIntegrationsStore((s) => s.updateConfig);
  const credentialWritesDisabled = useDeploymentReadinessStore(
    (s) => s.readiness?.credentials.writable === false,
  );

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (error) toast(error, { tone: 'danger' });
  }, [error]);

  return (
    <SettingSection
      title={t('settings.otherCapabilities')}
      optional
      collapsible
    >
      <ApiKeyRow
        title={t('settings.webSearch')}
        description={t('settings.webSearchDescription')}
        saved={config?.hasTavilyKey ?? false}
        placeholder="tvly-…"
        saving={saving}
        disabled={credentialWritesDisabled}
        onSave={(key) => void updateConfig({ tavilyApiKey: key })}
        onRemove={() => void updateConfig({ tavilyApiKey: null })}
      />
      <ApiKeyRow
        title={t('settings.youtubeTranscripts')}
        description={t('settings.youtubeTranscriptsDescription')}
        saved={config?.hasRapidApiKey ?? false}
        placeholder="rapidapi-…"
        saving={saving}
        disabled={credentialWritesDisabled}
        onSave={(key) => void updateConfig({ rapidApiKey: key })}
        onRemove={() => void updateConfig({ rapidApiKey: null })}
      />
    </SettingSection>
  );
};
