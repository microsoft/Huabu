import { Check, Key } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { TEXT_INPUT_CLASS } from '@/components/Settings/utils';
import { useIntegrationsStore } from '@/store/integrationsStore';

interface IntegrationKeyRowProps {
  /** Label for the integration (e.g. "Web Search (Tavily)"). */
  title: string;
  /** Secondary description of what the key enables. */
  description: string;
  /** Whether a key is already saved on the server. */
  saved: boolean;
  /** Placeholder for the password input. */
  placeholder: string;
  /** Whether a save request is in flight. */
  saving: boolean;
  /** Persist a new key (already trimmed, guaranteed non-empty). */
  onSave: (key: string) => void;
}

/**
 * A single integration credential row: a status icon + Set/Update toggle
 * that reveals a password field. Mirrors the LLM provider key UX, so a
 * saved secret is never echoed back — the user just types a new one.
 */
const IntegrationKeyRow: React.FC<IntegrationKeyRowProps> = ({
  title,
  description,
  saved,
  placeholder,
  saving,
  onSave,
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const handleSave = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setValue('');
    setEditing(false);
  };

  return (
    <>
      <SettingRow title={title} description={description}>
        <div className="flex items-center gap-1.5">
          {saved ? (
            <Check size={14} className="text-success" />
          ) : (
            <Key size={14} className="text-warning" />
          )}
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={() => setEditing((prev) => !prev)}
          >
            {editing
              ? t('actions.cancel')
              : saved
                ? t('settings.updateKey')
                : t('settings.setApiKey')}
          </Button>
        </div>
      </SettingRow>

      {editing && (
        <div className="px-3 py-2.5">
          <p className="text-fg-subtle mb-1.5 text-[11px] leading-snug">
            {t('settings.savedKeyKeepEmpty')}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
              className={`${TEXT_INPUT_CLASS} min-w-0 flex-1`}
              autoFocus
            />
            <Button
              variant="solid"
              tone="info"
              size="sm"
              onClick={handleSave}
              disabled={!value.trim() || saving}
            >
              {saving ? t('settings.saving') : t('settings.saveChanges')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
};

/**
 * Third-party integration credentials (Tavily web search, RapidAPI
 * YouTube transcripts). Keys are stored server-side; environment
 * variables remain a fallback for headless deployments.
 */
export const IntegrationsSettings: React.FC = () => {
  const { t } = useTranslation();
  const config = useIntegrationsStore((s) => s.config);
  const saving = useIntegrationsStore((s) => s.saving);
  const init = useIntegrationsStore((s) => s.init);
  const updateConfig = useIntegrationsStore((s) => s.updateConfig);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <SettingSection title={t('settings.otherCapabilities')} collapsible>
      <IntegrationKeyRow
        title={t('settings.webSearch')}
        description={t('settings.webSearchDescription')}
        saved={config?.hasTavilyKey ?? false}
        placeholder="tvly-…"
        saving={saving}
        onSave={(key) => void updateConfig({ tavilyApiKey: key })}
      />
      <IntegrationKeyRow
        title={t('settings.youtubeTranscripts')}
        description={t('settings.youtubeTranscriptsDescription')}
        saved={config?.hasRapidApiKey ?? false}
        placeholder="rapidapi-…"
        saving={saving}
        onSave={(key) => void updateConfig({ rapidApiKey: key })}
      />
    </SettingSection>
  );
};
