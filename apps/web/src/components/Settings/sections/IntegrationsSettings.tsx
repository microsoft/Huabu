import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiKeyRow } from '@/components/Common/ApiKeyRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
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
        onSave={(key) => void updateConfig({ tavilyApiKey: key })}
        onRemove={() => void updateConfig({ tavilyApiKey: null })}
      />
      <ApiKeyRow
        title={t('settings.youtubeTranscripts')}
        description={t('settings.youtubeTranscriptsDescription')}
        saved={config?.hasRapidApiKey ?? false}
        placeholder="rapidapi-…"
        saving={saving}
        onSave={(key) => void updateConfig({ rapidApiKey: key })}
        onRemove={() => void updateConfig({ rapidApiKey: null })}
      />
    </SettingSection>
  );
};
