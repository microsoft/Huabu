// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Common/Button';
import { Select } from '@/components/Common/Select';
import { Toggle } from '@/components/Common/Toggle';
import { CanaryRedeploySettings } from '@/components/Settings/CanaryRedeploySettings';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { canCheckForUpdates, useAppUpdate } from '@/hooks/useAppUpdate';
import { getElectronBridge } from '@/hooks/useElectron';
import { useEffectiveInputMode } from '@/hooks/useInputMode';
import { supportedLngs, type SupportedLanguage } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useToolStore, type InputModePreference } from '@/store/toolStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

/** Native language names, shown regardless of the active UI language. */
const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

const LANGUAGE_OPTIONS = supportedLngs.map((lng) => ({
  value: lng,
  label: LANGUAGE_LABELS[lng],
}));

/**
 * General application settings. Language changes persist to `localStorage`
 * (`huabu.language`) via i18next's language detector cache, while the
 * canvas store persists the minimap preference independently.
 *
 * Renders bare {@link SettingRow} entries; the parent supplies the card
 * wrapper so the General tab shows one flat list rather than redundant
 * one-row subsections.
 */
export const GeneralSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const minimapEnabled = useCanvasStore((s) => s.minimapEnabled);
  const toggleMinimap = useCanvasStore((s) => s.toggleMinimap);
  const worldEnabled = useWorkspaceStore((s) => s.worldEnabled);
  const setWorldEnabled = useWorkspaceStore((s) => s.setWorldEnabled);
  const inputModePreference = useToolStore(
    (state) => state.inputModePreference,
  );
  const setInputModePreference = useToolStore(
    (state) => state.setInputModePreference,
  );
  const effectiveInputMode = useEffectiveInputMode();
  const { status: updateStatus, check: checkForUpdates } = useAppUpdate();
  const updaterAvailable = !!getElectronBridge()?.updater;

  const current = (i18n.resolvedLanguage ?? i18n.language) as SupportedLanguage;

  const handleChange = useCallback(
    (value: SupportedLanguage) => {
      void i18n.changeLanguage(value);
    },
    [i18n],
  );

  return (
    <>
      <SettingRow
        title={t('settings.language')}
        description={t('settings.languageDescription')}
      >
        <Select
          options={LANGUAGE_OPTIONS}
          value={current}
          onChange={handleChange}
          title={t('settings.language')}
          ariaLabel={t('settings.language')}
        />
      </SettingRow>
      <SettingRow
        title={t('settings.showMiniMap')}
        description={t('settings.miniMapDescription')}
      >
        <Toggle
          checked={minimapEnabled}
          onChange={toggleMinimap}
          label={
            minimapEnabled
              ? t('settings.hideMiniMap')
              : t('settings.showMiniMap')
          }
        />
      </SettingRow>
      <SettingRow
        title={t('settings.worldCanvas')}
        description={t('settings.worldCanvasDescription')}
      >
        <Toggle
          checked={worldEnabled}
          onChange={setWorldEnabled}
          label={
            worldEnabled
              ? t('settings.hideWorldCanvas')
              : t('settings.showWorldCanvas')
          }
        />
      </SettingRow>
      {updaterAvailable && (
        <SettingRow
          title={t('update.check')}
          description={
            updateStatus.state === 'not-available'
              ? t('update.currentVersion', { version: updateStatus.version })
              : t('update.settingsDescription')
          }
        >
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={checkForUpdates}
            disabled={!canCheckForUpdates(updateStatus)}
          >
            {updateStatus.state === 'checking'
              ? t('update.checking')
              : t('update.check')}
          </Button>
        </SettingRow>
      )}
      {!updaterAvailable && <CanaryRedeploySettings />}
      <SettingRow
        title={t('settings.inputMode')}
        description={t('settings.inputModeDescription')}
      >
        <Select<InputModePreference>
          options={[
            {
              value: 'auto',
              label: t('settings.automaticResolved', {
                mode: t(`settings.inputMode_${effectiveInputMode}`),
              }),
            },
            { value: 'mouse', label: t('settings.inputMode_mouse') },
            { value: 'pen', label: t('settings.inputMode_pen') },
            { value: 'finger', label: t('settings.inputMode_finger') },
          ]}
          value={inputModePreference}
          onChange={setInputModePreference}
          title={t('settings.inputMode')}
          ariaLabel={t('settings.inputMode')}
        />
      </SettingRow>
    </>
  );
};
