// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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

import { AgentletHealthBanner } from './AgentletHealthBanner';
import { AgentProfileEditor } from './AgentProfileEditor';
import { PersistedAgentIconPicker } from './PersistedAgentIconPicker';
import { ProfileFormFooterTarget } from './ProfileFormFooter';
import { useDetectedClis } from './useDetectedClis';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type { AcpCommandProfileView } from '@huabu/shared';

type EditorState =
  | { kind: 'create' }
  | { kind: 'edit-command'; profile: AcpCommandProfileView };

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
  const loading = useAcpProfilesStore((state) => state.loading);
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
    ? editor.kind === 'create'
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

  const needsCliNames = profiles.some(
    (profile) => profile.metadata?.cliId && profile.metadata.cliId !== 'custom',
  );
  const { detectedClis, loaded: detectionLoaded } = useDetectedClis(
    needsCliNames || editor !== null,
  );

  const saveIcon = useCallback(
    async (profile: AcpCommandProfileView, icon: AgentIconValue) => {
      try {
        await updateAcpProfile(profile.id, {
          customData: withAgentIcon(profile.customData, icon),
        });
        await refresh();
      } catch (err) {
        toast(
          err instanceof Error ? err.message : t('settings.profileSaveFailed'),
          { tone: 'danger' },
        );
        throw err;
      }
    },
    [refresh, t],
  );

  const describeProfile = (profile: AcpCommandProfileView): string => {
    const cliId = profile.metadata?.cliId;
    if (!cliId || cliId === 'custom') {
      return [t('settings.agentCustomBadge'), profile.launch.command].join(
        ' · ',
      );
    }
    return detectedClis.find((cli) => cli.id === cliId)?.displayName ?? cliId;
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
            <ProfileFormFooterTarget target={footerTarget}>
              <SettingSection>
                <AgentProfileEditor
                  {...(editor.kind === 'create'
                    ? { mode: 'create' as const }
                    : {
                        mode: 'edit-command' as const,
                        profile: editor.profile,
                      })}
                  detectedClis={detectedClis}
                  detectionLoaded={detectionLoaded}
                  onClose={closeEditor}
                  onSaved={refresh}
                />
              </SettingSection>
            </ProfileFormFooterTarget>
            <div ref={setFooterTarget} className="mt-3" />
          </div>
        ) : (
          <div key="list" ref={activeViewRef}>
            <SettingSection>
              {loading ? (
                <SettingRow title={t('settings.loadingAgents')}>
                  <Loading layout="inline" size="sm" />
                </SettingRow>
              ) : (
                <>
                  {profiles.map((profile) => (
                    <SettingRow
                      key={profile.id}
                      leading={
                        <PersistedAgentIconPicker
                          value={readAgentIcon(profile)}
                          alias={profile.alias}
                          onSave={(icon) => saveIcon(profile, icon)}
                        />
                      }
                      title={profile.alias}
                      description={describeProfile(profile)}
                    >
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          tone="neutral"
                          size="sm"
                          iconOnly
                          title={t('settings.editProfile')}
                          ref={restoreTriggerFocus(`command:${profile.id}`)}
                          data-editor-trigger={`command:${profile.id}`}
                          onClick={() =>
                            openEditor(
                              { kind: 'edit-command', profile },
                              `command:${profile.id}`,
                            )
                          }
                        >
                          <Pencil size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          tone="danger"
                          size="sm"
                          iconOnly
                          title={t('settings.deleteProfile')}
                          onClick={() => setPendingDelete(profile)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </SettingRow>
                  ))}
                  <SettingRow
                    title={
                      profiles.length === 0
                        ? t('settings.noAgents')
                        : t('settings.addAnotherAgent')
                    }
                    description={
                      profiles.length === 0
                        ? t('settings.noAgentsDescription')
                        : t('settings.addAnotherAgentDescription')
                    }
                  >
                    <Button
                      variant="outline"
                      tone="info"
                      size="sm"
                      ref={restoreTriggerFocus('create')}
                      data-editor-trigger="create"
                      onClick={() => openEditor({ kind: 'create' }, 'create')}
                    >
                      <Plus size={12} />
                      <span>{t('settings.addAgent')}</span>
                    </Button>
                  </SettingRow>
                </>
              )}
            </SettingSection>
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
            size="sm"
            onClick={() => setPendingDelete(null)}
            disabled={isDeleting}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            ref={confirmDeleteRef}
            variant="solid"
            tone="danger"
            size="sm"
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
