// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getAgentChangeReviewConfig,
  updateAgentChangeReviewConfig,
} from '@/api/agentChangeReview';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { SettingRow } from '@/components/Settings/Common/SettingRow';

export function AgentBehaviorSettings() {
  const { t } = useTranslation();
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
  );
}
