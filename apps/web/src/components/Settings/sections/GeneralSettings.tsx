// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getExternalAgentRuntimeConfig,
  updateExternalAgentRuntimeConfig,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Input } from '@/components/Common/Input';
import { Select } from '@/components/Common/Select';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';
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

const IDLE_TIMEOUT_PRESETS = new Set(['0', '300', '600', '1800', '3600']);

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
  const [idleTimeoutSecs, setIdleTimeoutSecs] = useState(600);
  const [idleTimeoutSelection, setIdleTimeoutSelection] = useState('600');
  const [customMinutes, setCustomMinutes] = useState('10');
  const [idleTimeoutLoading, setIdleTimeoutLoading] = useState(true);
  const [idleTimeoutSaving, setIdleTimeoutSaving] = useState(false);
  const { status: updateStatus, check: checkForUpdates } = useAppUpdate();
  const updaterAvailable = !!getElectronBridge()?.updater;

  const current = (i18n.resolvedLanguage ?? i18n.language) as SupportedLanguage;

  const handleChange = useCallback(
    (value: SupportedLanguage) => {
      void i18n.changeLanguage(value);
    },
    [i18n],
  );

  useEffect(() => {
    let active = true;
    void getExternalAgentRuntimeConfig()
      .then((config) => {
        if (!active) return;
        const value = String(config.idleTimeoutSecs);
        setIdleTimeoutSecs(config.idleTimeoutSecs);
        setIdleTimeoutSelection(
          IDLE_TIMEOUT_PRESETS.has(value) ? value : 'custom',
        );
        if (config.idleTimeoutSecs > 0) {
          setCustomMinutes(String(config.idleTimeoutSecs / 60));
        }
      })
      .catch((error) => {
        if (!active) return;
        toast(
          error instanceof Error
            ? error.message
            : t('settings.externalAgentIdleTimeoutLoadFailed'),
          { tone: 'danger' },
        );
      })
      .finally(() => {
        if (active) setIdleTimeoutLoading(false);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const saveIdleTimeout = useCallback(
    async (nextIdleTimeoutSecs: number) => {
      setIdleTimeoutSaving(true);
      try {
        const saved = await updateExternalAgentRuntimeConfig({
          idleTimeoutSecs: nextIdleTimeoutSecs,
        });
        setIdleTimeoutSecs(saved.idleTimeoutSecs);
        const value = String(saved.idleTimeoutSecs);
        setIdleTimeoutSelection(
          IDLE_TIMEOUT_PRESETS.has(value) ? value : 'custom',
        );
        toast(t('settings.externalAgentIdleTimeoutSaved'), {
          tone: 'success',
        });
      } catch (error) {
        const previous = String(idleTimeoutSecs);
        setIdleTimeoutSelection(
          IDLE_TIMEOUT_PRESETS.has(previous) ? previous : 'custom',
        );
        toast(
          error instanceof Error
            ? error.message
            : t('settings.externalAgentIdleTimeoutSaveFailed'),
          { tone: 'danger' },
        );
      } finally {
        setIdleTimeoutSaving(false);
      }
    },
    [idleTimeoutSecs, t],
  );

  const handleIdleTimeoutSelection = useCallback(
    (value: string) => {
      setIdleTimeoutSelection(value);
      if (value !== 'custom') void saveIdleTimeout(Number(value));
    },
    [saveIdleTimeout],
  );

  const parsedCustomMinutes = Number(customMinutes);
  const customMinutesValid =
    Number.isInteger(parsedCustomMinutes) &&
    parsedCustomMinutes >= 1 &&
    parsedCustomMinutes <= 1440;

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
      <SettingRow
        title={t('settings.externalAgentIdleTimeout')}
        description={t('settings.externalAgentIdleTimeoutDescription')}
      >
        <div className="flex shrink-0 items-center gap-2">
          <Select
            options={[
              { value: '300', label: t('settings.fiveMinutes') },
              {
                value: '600',
                label: t('settings.tenMinutesDefault'),
              },
              { value: '1800', label: t('settings.thirtyMinutes') },
              { value: '3600', label: t('settings.oneHour') },
              { value: '0', label: t('settings.never') },
              { value: 'custom', label: t('settings.custom') },
            ]}
            value={idleTimeoutSelection}
            onChange={handleIdleTimeoutSelection}
            disabled={idleTimeoutLoading || idleTimeoutSaving}
            title={t('settings.externalAgentIdleTimeout')}
          />
          {idleTimeoutSelection === 'custom' && (
            <>
              <Input
                className="border-edge-default bg-surface text-fg-default focus:ring-info-light w-20 rounded-md border px-2 py-1.5 text-xs focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                type="number"
                min={1}
                max={1440}
                step={1}
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && customMinutesValid) {
                    void saveIdleTimeout(parsedCustomMinutes * 60);
                  }
                }}
                aria-label={t('settings.customIdleTimeoutMinutes')}
                disabled={idleTimeoutSaving}
              />
              <span className="text-fg-muted text-xs">
                {t('settings.minutes')}
              </span>
              <Button
                variant="outline"
                tone="info"
                size="sm"
                onClick={() => void saveIdleTimeout(parsedCustomMinutes * 60)}
                disabled={!customMinutesValid || idleTimeoutSaving}
              >
                {t('settings.saveChanges')}
              </Button>
            </>
          )}
        </div>
      </SettingRow>
    </>
  );
};
