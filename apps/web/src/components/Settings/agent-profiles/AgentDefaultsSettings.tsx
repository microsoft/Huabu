// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildAcpSessionSelectors } from '@huabu/shared';

import { Button } from '@/components/Common/Button';
import { Select, type SelectOption } from '@/components/Common/Select';
import { SettingControl } from '@/components/Settings/Common/SettingControl';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useDebouncedSave } from '@/components/Settings/utils';
import { useAcpProfileCapabilities } from '@/hooks/useAcpProfileCapabilities';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import { BuiltinUtilityModelSettings } from '../sections/LLMSettings';

import type { AgentDefaults, AgentDefaultsResponse } from '@huabu/shared';

export function AgentDefaultsSettings() {
  const { t } = useTranslation();
  const profiles = useAcpProfilesStore((state) => state.profiles);
  const profilesLoaded = useAcpProfilesStore((state) => state.loaded);
  const profilesError = useAcpProfilesStore((state) => state.error);
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const loadDefaults = useAcpProfilesStore((state) => state.loadDefaults);
  const saveDefaults = useAcpProfilesStore((state) => state.saveDefaults);
  const [snapshot, setSnapshot] = useState<AgentDefaultsResponse | null>(null);
  const [draft, setDraft] = useState<AgentDefaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const editRevision = useRef(0);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void refresh();
    void loadDefaults().then(
      (response) => {
        if (cancelled) return;
        setSnapshot(response);
        setDraft(response.defaults);
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      cancelled = true;
      active.current = false;
    };
  }, [refresh, loadDefaults]);

  const debouncedSave = useDebouncedSave(
    async ({
      config,
      revision,
    }: {
      config: AgentDefaults;
      revision: number;
    }) => {
      if (active.current) {
        setError(null);
      }
      try {
        const response = await saveDefaults(config);
        if (active.current && revision === editRevision.current) {
          setSnapshot(response);
          setDraft(response.defaults);
        }
      } catch (cause) {
        if (active.current && revision === editRevision.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : t('settings.agentDefaultsSaveFailed'),
          );
        }
      }
    },
  );

  function edit(config: AgentDefaults, immediate = false) {
    setDraft(config);
    setError(null);
    debouncedSave({ config, revision: ++editRevision.current });
    if (immediate) debouncedSave.flush();
  }

  const externalProfiles = profiles.filter((profile) => profile.id !== 'huabu');
  const isBuiltIn = draft?.profileId === 'huabu';
  const selectedProfile = externalProfiles.find(
    (profile) => profile.id === draft?.profileId,
  );
  const supportsModel = selectedProfile?.launch.kind === 'acp-harness';
  const capabilities = useAcpProfileCapabilities(
    draft?.profileId ?? null,
    profilesLoaded && supportsModel,
  );
  const models = capabilities.data
    ? (buildAcpSessionSelectors(capabilities.data.sessionMeta).find(
        (selector) =>
          selector.category === 'model' && selector.kind === 'select',
      )?.options ?? [])
    : [];
  const modelOptions: SelectOption[] = [
    { value: '', label: t('settings.agentDefaultsInherit') },
    ...models,
  ];
  const unavailableModel = Boolean(
    draft?.functionalModel &&
    !models.some((model) => model.value === draft.functionalModel),
  );
  if (unavailableModel && draft?.functionalModel) {
    modelOptions.push({
      value: draft.functionalModel,
      label: draft.functionalModel,
      disabled: true,
    });
  }
  const missing =
    profilesLoaded &&
    !isBuiltIn &&
    draft !== null &&
    draft.profileId !== null &&
    !externalProfiles.some((profile) => profile.id === draft.profileId);
  const options = [
    {
      value: 'huabu',
      label: t('settings.builtInPi'),
      description: t('settings.builtInPiSetup'),
    },
    ...externalProfiles.map((profile) => ({
      value: profile.id,
      label: profile.alias,
      description: undefined,
    })),
  ];
  if (missing && draft?.profileId) {
    options.unshift({
      value: draft.profileId,
      label: t('settings.agentDefaultsMissing', { id: draft.profileId }),
      description: undefined,
    });
  }
  const modelCapability = !supportsModel
    ? 'unsupported'
    : models.length > 0
      ? 'supported'
      : 'unknown';
  const showStatus =
    missing ||
    draft?.profileId === null ||
    (snapshot?.defaults.profileId === draft?.profileId &&
      snapshot?.selectionState === 'offline') ||
    (!isBuiltIn &&
      Boolean(draft?.functionalModel.trim()) &&
      modelCapability !== 'supported') ||
    Boolean(error || profilesError);

  return (
    <SettingSection
      title={t('settings.agentDefaultsTitle')}
      collapsible
      keepMounted
    >
      {!draft ? (
        <p
          className="text-fg-muted px-3 py-2 text-xs"
          role={error ? 'alert' : undefined}
        >
          {error ?? t('settings.loadingAgents')}
        </p>
      ) : (
        <>
          <SettingRow
            title={t('settings.agentDefaultsProfile')}
            description={t('settings.agentDefaultsSectionDescription')}
          >
            <SettingControl>
              <Select
                className="w-full"
                appearance="field"
                ariaLabel={t('settings.agentDefaultsProfile')}
                options={options}
                value={draft.profileId ?? ''}
                placeholder={t('settings.agentDefaultsUnconfigured')}
                onOpen={() => void refresh()}
                onChange={(profileId) => {
                  edit(
                    {
                      ...draft,
                      profileId,
                      functionalModel:
                        profileId === 'huabu' || profileId === draft.profileId
                          ? draft.functionalModel
                          : '',
                    },
                    true,
                  );
                }}
              />
            </SettingControl>
          </SettingRow>
          {isBuiltIn ? (
            <BuiltinUtilityModelSettings />
          ) : (
            <div>
              <SettingRow title={t('settings.agentDefaultsModel')}>
                <div className="w-40 min-w-0 sm:w-48">
                  <Select
                    appearance="field"
                    ariaLabel={t('settings.agentDefaultsModel')}
                    className="justify-between"
                    options={modelOptions}
                    value={draft.functionalModel}
                    placeholder={t('settings.agentDefaultsInherit')}
                    disabled={
                      missing ||
                      !profilesLoaded ||
                      !supportsModel ||
                      capabilities.loading
                    }
                    onChange={(functionalModel) =>
                      edit({ ...draft, functionalModel }, true)
                    }
                  />
                </div>
              </SettingRow>
              <div className="flex min-w-0 flex-col items-start gap-2 px-3 pb-2.5 [overflow-wrap:anywhere] empty:hidden">
                {capabilities.loading && (
                  <span role="status" className="text-fg-muted text-xs">
                    {t('chat.loadingAgentOptionsProgress')}
                  </span>
                )}
                {capabilities.error ? (
                  <div className="text-danger-fg text-xs" role="alert">
                    {capabilities.error.message}
                    <Button
                      size="field"
                      variant="ghost"
                      onClick={capabilities.retry}
                    >
                      {t('chat.retryAgentOptions')}
                    </Button>
                  </div>
                ) : capabilities.data && models.length === 0 ? (
                  <span role="status" className="text-fg-muted text-xs">
                    {t('settings.agentDefaultsNoModels')}
                  </span>
                ) : unavailableModel &&
                  !capabilities.loading &&
                  supportsModel ? (
                  <span role="status" className="text-warning-fg text-xs">
                    {t('settings.agentDefaultsModelUnavailable')}
                  </span>
                ) : !supportsModel && selectedProfile ? (
                  <span role="status" className="text-warning-fg text-xs">
                    {t('settings.agentDefaultsModelUnsupported')}
                  </span>
                ) : null}
                {error && (
                  <Button
                    size="field"
                    variant="ghost"
                    onClick={() => edit(draft, true)}
                  >
                    {t('settings.agentDefaultsRetrySave')}
                  </Button>
                )}
              </div>
            </div>
          )}
          {showStatus && (
            <div className="space-y-2 px-3 py-2 text-xs">
              {missing ? (
                <p className="text-warning-fg" role="status">
                  {t('settings.agentDefaultsDeleted')}
                </p>
              ) : draft.profileId === null ? (
                <p className="text-fg-muted">
                  {t('settings.agentDefaultsUnconfigured')}
                </p>
              ) : snapshot?.defaults.profileId === draft.profileId &&
                snapshot.selectionState === 'offline' ? (
                <p className="text-warning-fg">
                  {t('settings.agentDefaultsOffline')}
                </p>
              ) : null}
              {!isBuiltIn &&
                draft.functionalModel.trim() &&
                modelCapability !== 'supported' && (
                  <p className="text-warning-fg">
                    {modelCapability === 'unsupported'
                      ? t('settings.agentDefaultsModelUnsupported')
                      : t('settings.agentDefaultsModelUnknown')}
                  </p>
                )}
              {(error || profilesError) && (
                <p className="text-danger-fg" role="alert">
                  {error ?? profilesError?.message}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </SettingSection>
  );
}
