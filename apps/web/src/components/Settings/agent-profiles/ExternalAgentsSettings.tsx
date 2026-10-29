// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/api/_client';
import {
  deleteAcpProfile,
  restartAcpAgentlet,
  updateAcpProfile,
} from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { toast } from '@/components/Common/Toast';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { readAgentIcon, withAgentIcon } from '@/utils/agentIcon';
import { resolveConnectedDevice } from '@/utils/agentletDevice';

import { AgentletHealthBanner } from './AgentletHealthBanner';
import { AgentProfileEditor } from './AgentProfileEditor';
import { ConnectedDevicesSetting } from './ConnectedDevicesSetting';
import { PersistedAgentIconPicker } from './PersistedAgentIconPicker';
import { ProfileFormFooterTarget } from './ProfileFormFooter';
import { useDetectedClis } from './useDetectedClis';
import { AgentConnectionSettings } from '../sections/ExternalAgentRuntimeSettings';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type { AgentProfileView } from '@huabu/shared';

type EditorState =
  | { kind: 'connect-device' }
  | { kind: 'create'; agentletId: string }
  | { kind: 'edit-command'; profile: AgentProfileView };

const PROFILE_REFRESH_INTERVAL_MS = 5_000;

interface PendingDelete {
  id: string;
  alias: string;
}

export interface ExternalAgentsNavigation {
  title: string;
  onBack: () => void;
}

interface ExternalAgentsSettingsProps {
  onNavigationChange: (navigation: ExternalAgentsNavigation | null) => void;
}

export function ExternalAgentsSettings({
  onNavigationChange,
}: ExternalAgentsSettingsProps) {
  const { t } = useTranslation();
  const profiles = useAcpProfilesStore((state) => state.profiles);
  const connectedDevices = useAcpProfilesStore(
    (state) => state.connectedDevices,
  );
  const selectableProfileIds = useAcpProfilesStore(
    (state) => state.selectableProfileIds,
  );
  const loading = useAcpProfilesStore((state) => state.loading);
  const loaded = useAcpProfilesStore((state) => state.loaded);
  const error = useAcpProfilesStore((state) => state.error);
  const agentlet = useAcpProfilesStore((state) => state.agentlet);
  const init = useAcpProfilesStore((state) => state.init);
  const refresh = useAcpProfilesStore((state) => state.refresh);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const returnTargetRef = useRef<string | null>(null);
  const activeViewRef = useRef<HTMLDivElement>(null);
  const enterDirectionRef = useRef<'forward' | 'back' | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const exitAnimationRef = useRef<Animation | null>(null);

  useEffect(() => {
    void init();
    void refresh();
  }, [init, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh({ background: true });
      }
    }, PROFILE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (error) toast(error.message, { tone: 'danger' });
  }, [error]);

  const switchView = useCallback(
    (direction: 'forward' | 'back', complete: () => void) => {
      const view = activeViewRef.current;
      const reducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      if (!view || reducedMotion) {
        complete();
        return;
      }
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      view.getAnimations().forEach((animation) => animation.cancel());
      view.style.pointerEvents = 'none';
      const offset = direction === 'forward' ? '-16px' : '16px';
      exitAnimationRef.current = view.animate(
        [
          { transform: 'translateX(0)' },
          { transform: `translateX(${offset})` },
        ],
        { duration: 110, easing: 'ease-in', fill: 'forwards' },
      );
      transitionTimerRef.current = window.setTimeout(() => {
        transitionTimerRef.current = null;
        exitAnimationRef.current?.cancel();
        exitAnimationRef.current = null;
        view.style.pointerEvents = '';
        enterDirectionRef.current = direction;
        complete();
      }, 110);
    },
    [],
  );

  const openEditor = useCallback(
    (next: EditorState, triggerKey: string) => {
      returnTargetRef.current = triggerKey;
      switchView('forward', () => setEditor(next));
    },
    [switchView],
  );

  const closeEditor = useCallback(() => {
    switchView('back', () => setEditor(null));
  }, [switchView]);

  const editorTitle = editor
    ? editor.kind === 'connect-device'
      ? t('settings.addDevice')
      : editor.kind === 'create'
        ? t('settings.newAgentProfile')
        : t('settings.editAgentProfile', { name: editor.profile.alias })
    : null;

  useEffect(() => {
    onNavigationChange(
      editorTitle ? { title: editorTitle, onBack: closeEditor } : null,
    );
    return () => onNavigationChange(null);
  }, [closeEditor, editorTitle, onNavigationChange]);

  useEffect(
    () => () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
      exitAnimationRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    const direction = enterDirectionRef.current;
    const view = activeViewRef.current;
    enterDirectionRef.current = null;
    if (
      !direction ||
      !view ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const offset = direction === 'forward' ? '16px' : '-16px';
    view.animate(
      [{ transform: `translateX(${offset})` }, { transform: 'translateX(0)' }],
      { duration: 170, easing: 'ease-out' },
    );
  }, [editor]);

  const restoreTriggerFocus = useCallback(
    (triggerKey: string) => (element: HTMLButtonElement | null) => {
      if (!element || returnTargetRef.current !== triggerKey) return;
      element.focus();
      returnTargetRef.current = null;
    },
    [],
  );

  const {
    detectedClis,
    loaded: detectionLoaded,
    error: detectionError,
    recheck,
  } = useDetectedClis(
    editor !== null && editor.kind !== 'connect-device',
    editor?.kind === 'edit-command'
      ? { profileId: editor.profile.id }
      : editor?.kind === 'create'
        ? { agentletId: editor.agentletId }
        : { agentletId: '' },
    (() => {
      const target =
        editor?.kind === 'create'
          ? editor.agentletId
          : editor?.kind === 'edit-command'
            ? editor.profile.agentletId
            : '';
      const device = resolveConnectedDevice(target, connectedDevices);
      return device
        ? `${device.agentletId}:${device.connectedAt}`
        : 'unavailable';
    })(),
  );

  const saveIcon = useCallback(
    async (profile: AgentProfileView, icon: AgentIconValue) => {
      try {
        await updateAcpProfile(profile.id, {
          expectedRevision: profile.revision ?? 0,
          customData: withAgentIcon(profile.customData, icon),
        });
        await refresh();
      } catch (err) {
        toast(
          err instanceof ApiError && err.status === 409
            ? t('settings.profileEditConflict')
            : err instanceof Error
              ? err.message
              : t('settings.profileSaveFailed'),
          { tone: 'danger' },
        );
        throw err;
      }
    },
    [refresh, t],
  );

  const renderProfile = (profile: AgentProfileView) => {
    const harness =
      profile.launch.kind === 'acp-harness'
        ? profile.launch.harnessId
        : t('settings.customCommand');
    return (
      <div key={profile.id} className="group/profile mr-2.5 ml-8">
        <SettingRow
          density="compact"
          className="px-0 py-1 [&.setting-row]:flex-row [&.setting-row]:items-center [&.setting-row]:gap-2 [&>.setting-row-control]:w-auto"
          leading={
            <PersistedAgentIconPicker
              value={readAgentIcon(profile)}
              alias={profile.alias}
              onSave={(icon) => saveIcon(profile, icon)}
            />
          }
          title={
            <span className="flex min-w-0 items-center gap-2 font-normal">
              <span className="truncate" title={profile.alias}>
                {profile.alias}
              </span>
              {profile.alias !== harness && (
                <span
                  className="text-fg-muted max-w-[35%] shrink-0 truncate text-xs"
                  title={harness}
                >
                  {harness}
                </span>
              )}
            </span>
          }
          description={
            selectableProfileIds.includes(profile.id) ||
            !resolveConnectedDevice(profile.agentletId, connectedDevices)
              ? undefined
              : t('settings.agentUnavailable')
          }
        >
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="field"
              iconOnly
              title={t('menu.edit')}
              aria-label={t('settings.editAgentProfile', {
                name: profile.alias,
              })}
              className="focus-visible:outline-info enabled:hover:text-fg-default focus-visible:text-fg-default focus-visible:outline-2"
              ref={restoreTriggerFocus(`command:${profile.id}`)}
              data-editor-trigger={`command:${profile.id}`}
              onClick={() =>
                openEditor(
                  { kind: 'edit-command', profile },
                  `command:${profile.id}`,
                )
              }
            >
              <Pencil aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="field"
              iconOnly
              title={t('actions.delete')}
              aria-label={t('settings.deleteAgentProfile', {
                name: profile.alias,
              })}
              className="focus-visible:outline-info enabled:hover:text-danger-fg focus-visible:text-danger-fg focus-visible:outline-2"
              onClick={() => setPendingDelete(profile)}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        </SettingRow>
      </div>
    );
  };

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const next = await restartAcpAgentlet();
      await refresh();
      if (next.online)
        toast(t('settings.workerRestarted'), { tone: 'success' });
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t('settings.workerRestartFailed'),
        { tone: 'danger' },
      );
    } finally {
      setRestarting(false);
    }
  }, [refresh, t]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await deleteAcpProfile(pendingDelete.id);
      await refresh();
      toast(t('settings.profileDeleted'), { tone: 'success' });
      setPendingDelete(null);
    } catch (err) {
      toast(
        err instanceof Error ? err.message : t('settings.profileDeleteFailed'),
        { tone: 'danger' },
      );
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, refresh, t]);

  return (
    <>
      <AgentletHealthBanner
        agentlet={agentlet}
        onRestart={handleRestart}
        restarting={restarting}
      />
      <div className="-mx-px overflow-x-clip px-px">
        {editor ? (
          <div key="editor" ref={activeViewRef}>
            {editor.kind === 'connect-device' ? (
              <SettingSection>
                <AgentConnectionSettings />
              </SettingSection>
            ) : (
              <>
                <ProfileFormFooterTarget target={footerTarget}>
                  <AgentProfileEditor
                    {...(editor.kind === 'create'
                      ? { mode: 'create' as const }
                      : {
                          mode: 'edit-command' as const,
                          profile: editor.profile,
                        })}
                    detectedClis={detectedClis}
                    detectionLoaded={detectionLoaded}
                    detectionError={detectionError}
                    onRecheck={recheck}
                    connectedDevices={connectedDevices}
                    agentletId={
                      editor.kind === 'create'
                        ? editor.agentletId
                        : editor.profile.agentletId
                    }
                    onClose={closeEditor}
                    onSaved={() => refresh({ afterMutation: true })}
                  />
                </ProfileFormFooterTarget>
                <div ref={setFooterTarget} className="mt-3" />
              </>
            )}
          </div>
        ) : (
          <div key="list" ref={activeViewRef}>
            {loading && !loaded ? (
              <SettingRow title={t('settings.loadingAgents')}>
                <Loading layout="inline" size="sm" />
              </SettingRow>
            ) : (
              <>
                <ConnectedDevicesSetting
                  profiles={profiles}
                  renderProfile={renderProfile}
                  onAdd={(agentletId) =>
                    openEditor(
                      { kind: 'create', agentletId },
                      `create:${agentletId}`,
                    )
                  }
                  addRef={(agentletId) =>
                    restoreTriggerFocus(`create:${agentletId}`)
                  }
                />
              </>
            )}
            <Button
              variant="outline"
              size="field"
              ref={restoreTriggerFocus('connect-device')}
              data-editor-trigger="connect-device"
              onClick={() =>
                openEditor({ kind: 'connect-device' }, 'connect-device')
              }
            >
              <Plus />
              {t('settings.addDevice')}
            </Button>
          </div>
        )}
      </div>
      <Modal
        isOpen={pendingDelete !== null}
        onClose={() => {
          if (!isDeleting) setPendingDelete(null);
        }}
        title={t('settings.deleteProfile')}
        initialFocusRef={confirmDeleteRef}
      >
        <p className="text-fg-muted text-sm">
          {t('settings.deleteProfileConfirm', { alias: pendingDelete?.alias })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            tone="neutral"
            size="field"
            onClick={() => setPendingDelete(null)}
            disabled={isDeleting}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            ref={confirmDeleteRef}
            variant="solid"
            tone="danger"
            size="field"
            onClick={() => void confirmDelete()}
            disabled={isDeleting}
          >
            {t('settings.deleteProfile')}
          </Button>
        </div>
      </Modal>
    </>
  );
}
