// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getAgentChangeReviewConfig,
  updateAgentChangeReviewConfig,
} from '@/api/agentChangeReview';
import { Select } from '@/components/Common/Select';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import {
  MAX_RECENT_CHAT_TURNS,
  MIN_RECENT_CHAT_TURNS,
  useChatPreferencesStore,
} from '@/store/chatPreferencesStore';

const RECENT_TURN_OPTIONS = Array.from(
  { length: MAX_RECENT_CHAT_TURNS - MIN_RECENT_CHAT_TURNS + 1 },
  (_, index) => {
    const value = String(index + MIN_RECENT_CHAT_TURNS);
    return { value, label: value };
  },
);

export function AgentBehaviorSettings() {
  const { t } = useTranslation();
  const recentTurnCount = useChatPreferencesStore(
    (state) => state.recentTurnCount,
  );
  const setRecentTurnCount = useChatPreferencesStore(
    (state) => state.setRecentTurnCount,
  );
  const [autoAcceptSpaceChanges, setAutoAcceptSpaceChanges] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getAgentChangeReviewConfig()
      .then((config) => {
        if (active) setAutoAcceptSpaceChanges(config.autoAcceptSpaceChanges);
      })
      .catch((error) => {
        if (!active) return;
        toast(
          error instanceof Error
            ? error.message
            : t('settings.autoAcceptAgentChangesLoadFailed'),
          { tone: 'danger' },
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const saveAutoAccept = useCallback(
    async (enabled: boolean) => {
      const previous = autoAcceptSpaceChanges;
      setAutoAcceptSpaceChanges(enabled);
      setSaving(true);
      try {
        const saved = await updateAgentChangeReviewConfig({
          autoAcceptSpaceChanges: enabled,
        });
        setAutoAcceptSpaceChanges(saved.autoAcceptSpaceChanges);
      } catch (error) {
        setAutoAcceptSpaceChanges(previous);
        toast(
          error instanceof Error
            ? error.message
            : t('settings.autoAcceptAgentChangesSaveFailed'),
          { tone: 'danger' },
        );
      } finally {
        setSaving(false);
      }
    },
    [autoAcceptSpaceChanges, t],
  );

  return (
    <>
      <SettingRow
        title={t('settings.autoAcceptAgentChanges')}
        description={t('settings.autoAcceptAgentChangesDescription')}
      >
        <Toggle
          checked={autoAcceptSpaceChanges}
          onChange={(enabled) => void saveAutoAccept(enabled)}
          disabled={loading || saving}
          label={t('settings.autoAcceptAgentChanges')}
        />
      </SettingRow>
      <SettingRow
        title={t('settings.recentChatTurns')}
        description={t('settings.recentChatTurnsDescription')}
      >
        <Select
          options={RECENT_TURN_OPTIONS}
          value={String(recentTurnCount)}
          onChange={(value) => setRecentTurnCount(Number(value))}
          title={t('settings.recentChatTurns')}
          ariaLabel={t('settings.recentChatTurns')}
        />
      </SettingRow>
    </>
  );
}
