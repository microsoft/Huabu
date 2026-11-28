// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { getElectronBridge } from '@/hooks/useElectron';
import {
  readNoticePreferences,
  writeNoticePreference,
} from '@/utils/turnNoticePreferences';

import type { NoticePreferences } from '@/utils/turnNotices';

/** Whether this page may show system notifications at all. */
function permitted(): boolean {
  if (getElectronBridge()?.tabs) return true;
  return (
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  );
}

/**
 * The two kinds of system notification about Agents, each with its own
 * switch. A browser must also grant permission: turning a switch on asks for
 * it, and without it both switches read as off.
 */
export const TurnNoticeSettings: React.FC = () => {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(readNoticePreferences);
  const [allowed, setAllowed] = useState(permitted);

  const change = useCallback(
    async (kind: keyof NoticePreferences, on: boolean) => {
      try {
        if (on && !permitted()) {
          const granted =
            typeof Notification !== 'undefined' &&
            (await Notification.requestPermission()) === 'granted';
          setAllowed(granted);
          if (!granted) {
            toast(t('settings.turnNoticesBlocked'), { tone: 'danger' });
            return;
          }
        }
        writeNoticePreference(kind, on);
        setPreferences(readNoticePreferences());
      } catch (error) {
        console.error('[settings] Could not change notifications:', error);
        toast(error instanceof Error ? error.message : String(error), {
          tone: 'danger',
        });
      }
    },
    [t],
  );

  return (
    <>
      <SettingRow
        title={t('settings.notifyTurnDone')}
        description={t('settings.notifyTurnDoneDescription')}
      >
        <Toggle
          checked={allowed && preferences.done}
          onChange={(on) => void change('done', on)}
          label={t('settings.notifyTurnDone')}
        />
      </SettingRow>
      <SettingRow
        title={t('settings.notifyNeedsYou')}
        description={t('settings.notifyNeedsYouDescription')}
      >
        <Toggle
          checked={allowed && preferences.needsYou}
          onChange={(on) => void change('needsYou', on)}
          label={t('settings.notifyNeedsYou')}
        />
      </SettingRow>
    </>
  );
};
