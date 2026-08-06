// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `ExternalAgentsSettings` — the single unified "External Agents" tab.
 *
 * Merges what used to be two separate tabs (Agent Teams + External
 * Agents) into one flat list. Each row is one Profile:
 *
 *  - **Template** (`agent-team-manifest`) — a bundled Agent Team Profile.
 *    Shows a preparation badge and an explicit Set up / Retry / Cancel
 *    button (setup is a heavy op, kept manual). Editing opens a dialog
 *    with the member-level Config/Token (shared across the template's
 *    Profiles) and the alias.
 *  - **Custom** (`acp-command`) — a raw launch-command Profile edited
 *    through the inline {@link AgentProfileEditor}.
 *
 * The agentlet daemon banner sits above the list because both Profile
 * kinds run on the same daemon.
 */

import { Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deleteAcpProfile,
  restartAcpAgentlet,
  updateAcpProfile,
} from '@/api/acp';
import {
  cancelAgentTeamProfileSetup,
  deleteAgentTeamProfile,
  patchAgentTeamProfile,
  setupAgentTeamProfile,
} from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { toast } from '@/components/Common/Toast';
import { SettingRow } from '@/components/Settings/Common/SettingRow';
import { SettingSection } from '@/components/Settings/Common/SettingSection';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import { readAgentIcon, withAgentIcon } from '@/utils/agentIcon';
import { copyToClipboard } from '@/utils/io/clipboard';

import { AgentletHealthBanner } from './AgentletHealthBanner';
import { AgentProfileEditor } from './AgentProfileEditor';
import { PersistedAgentIconPicker } from './PersistedAgentIconPicker';
import { ProfileFormFooterTarget } from './ProfileFormFooter';
import { useDetectedClis } from './useDetectedClis';
import { useUnifiedAgents, type ManifestProfileRow } from './useUnifiedAgents';

import type { AgentIconValue } from '@/components/Common/AgentIcon';
import type {
  AcpCommandProfileView,
  AgentTeamManifestProfileView,
} from '@huabu/shared';

/** The single open editor: create, or editing one of the two Profile kinds. */
type EditorState =
  | { kind: 'create' }
  | { kind: 'edit-command'; profile: AcpCommandProfileView }
  | { kind: 'edit-manifest'; row: ManifestProfileRow };

type PreparationStatus = AgentTeamManifestProfileView['preparation']['status'];

const STATUS_CLASS: Record<PreparationStatus, string> = {
  ready: 'bg-success-bg text-success',
  setting_up: 'bg-info-bg text-info',
  error: 'bg-danger-bg text-danger',
  not_prepared: 'bg-hover text-fg-muted',
};

const STATUS_KEY: Record<PreparationStatus, string> = {
  not_prepared: 'setupStatusNotPrepared',
  setting_up: 'setupStatusSettingUp',
  ready: 'setupStatusReady',
  error: 'setupStatusError',
};

interface PendingDelete {
  kind: 'command' | 'manifest';
  id: string;
  alias: string;
  member?: { machine: string; manifestPath: string };
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
  const { t: tAgent } = useTranslation('agentTeam');
  const {
    loading,
    manifestError,
    commandProfiles,
    members,
    manifestProfiles,
    refreshCommand,
    refreshMember,
    applyMemberDetail,
  } = useUnifiedAgents();
  const agentlet = useAcpProfilesStore((s) => s.agentlet);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [pendingSetup, setPendingSetup] = useState<string | null>(null);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const returnTargetRef = useRef<string | null>(null);
  const activeViewRef = useRef<HTMLDivElement>(null);
  const enterDirectionRef = useRef<'forward' | 'back' | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const exitAnimationRef = useRef<Animation | null>(null);

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
      : t('settings.editAgentProfile', {
          name:
            editor.kind === 'edit-command'
              ? editor.profile.alias
              : editor.row.profile.alias,
        })
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
    if (!direction) return;
    if (
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

  // CLI detection feeds the two host-CLI forms *and* the list, which
  // resolves a Profile's agent id (command `cliId` or manifest `harness`)
  // to its display name so both kinds read the same (e.g. "GitHub Copilot").
  const needsCliNames =
    manifestProfiles.length > 0 ||
    commandProfiles.some(
      (p) => p.metadata?.cliId && p.metadata.cliId !== 'custom',
    );
  const detectionEnabled =
    needsCliNames || (editor !== null && editor.kind !== 'edit-manifest');
  const { detectedClis, loaded: detectionLoaded } =
    useDetectedClis(detectionEnabled);

  const memberRefOf = (row: ManifestProfileRow) => ({
    machine: row.member.machine,
    manifestPath: row.member.manifestPath,
  });

  const saveCommandIcon = useCallback(
    async (profile: AcpCommandProfileView, icon: AgentIconValue) => {
      try {
        await updateAcpProfile(profile.id, {
          customData: withAgentIcon(profile.customData, icon),
        });
        await refreshCommand();
      } catch (err) {
        toast(
          err instanceof Error ? err.message : t('settings.profileSaveFailed'),
          { tone: 'danger' },
        );
        throw err;
      }
    },
    [refreshCommand, t],
  );

  const saveManifestIcon = useCallback(
    async (row: ManifestProfileRow, icon: AgentIconValue) => {
      try {
        await patchAgentTeamProfile(row.profile.id, {
          customData: withAgentIcon(row.profile.customData, icon),
        });
        await refreshMember(memberRefOf(row));
      } catch (err) {
        toast(
          err instanceof Error ? err.message : t('settings.profileSaveFailed'),
          { tone: 'danger' },
        );
        throw err;
      }
    },
    [refreshMember, t],
  );

  /**
   * Row description for a command Profile. A structured (detected-CLI)
   * Profile is named after its agent and never exposes the raw launch
   * command — only genuinely custom-command Profiles show it, because for
   * them the command *is* the identifying configuration.
   */
  const describeCommandProfile = useCallback(
    (profile: AcpCommandProfileView): string => {
      const cliId = profile.metadata?.cliId;
      if (!cliId || cliId === 'custom') {
        return [t('settings.agentCustomBadge'), profile.launch.command]
          .filter(Boolean)
          .join(' · ');
      }
      return detectedClis.find((c) => c.id === cliId)?.displayName ?? cliId;
    },
    [detectedClis, t],
  );

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const next = await restartAcpAgentlet();
      await refreshCommand();
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
  }, [refreshCommand, t]);

  const runSetup = useCallback(
    async (row: ManifestProfileRow) => {
      setPendingSetup(row.profile.id);
      try {
        await setupAgentTeamProfile(row.profile.id);
        await refreshMember(memberRefOf(row));
      } catch (err) {
        toast(err instanceof Error ? err.message : tAgent('operationFailed'), {
          tone: 'danger',
        });
      } finally {
        setPendingSetup(null);
      }
    },
    [refreshMember, tAgent],
  );

  const cancelSetup = useCallback(
    async (row: ManifestProfileRow) => {
      setPendingSetup(row.profile.id);
      try {
        await cancelAgentTeamProfileSetup(row.profile.id);
        await refreshMember(memberRefOf(row));
      } catch (err) {
        toast(err instanceof Error ? err.message : tAgent('operationFailed'), {
          tone: 'danger',
        });
      } finally {
        setPendingSetup(null);
      }
    },
    [refreshMember, tAgent],
  );

  const copyPreparationError = useCallback(
    (message: string) => {
      void copyToClipboard(message).then(() => {
        toast(t('settings.errorMessageCopied'), { tone: 'success' });
      });
    },
    [t],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      if (pendingDelete.kind === 'command') {
        await deleteAcpProfile(pendingDelete.id);
        await refreshCommand();
      } else {
        await deleteAgentTeamProfile(pendingDelete.id);
        if (pendingDelete.member) await refreshMember(pendingDelete.member);
      }
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
  }, [pendingDelete, refreshCommand, refreshMember, t]);

  const isEmpty = manifestProfiles.length === 0 && commandProfiles.length === 0;

  const sortedManifest = useMemo(
    () =>
      [...manifestProfiles].sort((a, b) =>
        a.profile.alias.localeCompare(b.profile.alias),
      ),
    [manifestProfiles],
  );

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
                {editor.kind === 'create' ? (
                  <AgentProfileEditor
                    mode="create"
                    members={members}
                    manifestError={manifestError}
                    detectedClis={detectedClis}
                    detectionLoaded={detectionLoaded}
                    onClose={closeEditor}
                    onCommandCreated={async () => {
                      await refreshCommand();
                      closeEditor();
                    }}
                    onManifestCreated={async (ref) => {
                      await refreshMember(ref);
                    }}
                    applyMemberDetail={applyMemberDetail}
                  />
                ) : editor.kind === 'edit-command' ? (
                  <AgentProfileEditor
                    mode="edit-command"
                    profile={editor.profile}
                    detectedClis={detectedClis}
                    detectionLoaded={detectionLoaded}
                    onClose={closeEditor}
                    onSaved={refreshCommand}
                  />
                ) : (
                  <AgentProfileEditor
                    mode="edit-manifest"
                    row={editor.row}
                    detectedClis={detectedClis}
                    onClose={closeEditor}
                    applyMemberDetail={applyMemberDetail}
                    onAliasSaved={async () => {
                      await refreshMember(memberRefOf(editor.row));
                    }}
                  />
                )}
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
                  {sortedManifest.map((row) => {
                    const status = row.profile.preparation.status;
                    const busy = pendingSetup === row.profile.id;
                    const errorMessage =
                      status === 'error'
                        ? row.profile.preparation.error.message
                        : undefined;
                    // Subtitle is just the agent it runs on, resolved to the same
                    // display name command rows use (e.g. "GitHub Copilot") so both
                    // kinds read consistently. Working directory, a "Preset" tag,
                    // and the error text are intentionally omitted — the error
                    // travels with the Error badge instead of a grey detail line.
                    const harnessLabel =
                      detectedClis.find(
                        (c) => c.id === row.profile.launch.harness,
                      )?.displayName ?? row.profile.launch.harness;
                    return (
                      <SettingRow
                        key={row.profile.id}
                        leading={
                          <PersistedAgentIconPicker
                            value={readAgentIcon(row.profile)}
                            alias={row.profile.alias}
                            onSave={(icon) => saveManifestIcon(row, icon)}
                          />
                        }
                        title={row.profile.alias}
                        description={harnessLabel}
                      >
                        <div className="flex shrink-0 items-center gap-1.5">
                          {/*
                           * Only badge states that need attention (setting up, not
                           * prepared, error). A ready preset shows no badge so it
                           * reads the same as an always-ready command agent. The
                           * Error badge carries the failure message as its tooltip
                           * so the detail stays with the status it belongs to.
                           */}
                          {status === 'error' && errorMessage ? (
                            <Button
                              variant="ghost"
                              shape="pill"
                              tone="danger"
                              size="sm"
                              title={errorMessage}
                              aria-label={t('settings.copyErrorMessage')}
                              onClick={() => copyPreparationError(errorMessage)}
                              className={`${STATUS_CLASS[status]} px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
                            >
                              {tAgent(STATUS_KEY[status])}
                            </Button>
                          ) : status !== 'ready' ? (
                            <span
                              className={`${STATUS_CLASS[status]} inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
                            >
                              {tAgent(STATUS_KEY[status])}
                            </span>
                          ) : null}
                          {status === 'setting_up' ? (
                            <Button
                              variant="outline"
                              tone="neutral"
                              size="sm"
                              title={tAgent('cancelSetup')}
                              disabled={busy}
                              onClick={() => void cancelSetup(row)}
                            >
                              <Square size={12} />
                              <span>{tAgent('cancelSetup')}</span>
                            </Button>
                          ) : status !== 'ready' ? (
                            <Button
                              variant="outline"
                              tone="info"
                              size="sm"
                              title={
                                status === 'error'
                                  ? tAgent('retrySetup')
                                  : tAgent('setup')
                              }
                              disabled={busy || !row.config.ready}
                              onClick={() => void runSetup(row)}
                            >
                              <Play size={12} />
                              <span>
                                {status === 'error'
                                  ? tAgent('retrySetup')
                                  : tAgent('setup')}
                              </span>
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            tone="neutral"
                            size="sm"
                            iconOnly
                            title={t('settings.editProfile')}
                            ref={restoreTriggerFocus(
                              `manifest:${row.profile.id}`,
                            )}
                            data-editor-trigger={`manifest:${row.profile.id}`}
                            onClick={() =>
                              openEditor(
                                { kind: 'edit-manifest', row },
                                `manifest:${row.profile.id}`,
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
                            onClick={() =>
                              setPendingDelete({
                                kind: 'manifest',
                                id: row.profile.id,
                                alias: row.profile.alias,
                                member: memberRefOf(row),
                              })
                            }
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </SettingRow>
                    );
                  })}

                  {commandProfiles.map((profile) => (
                    <SettingRow
                      key={profile.id}
                      leading={
                        <PersistedAgentIconPicker
                          value={readAgentIcon(profile)}
                          alias={profile.alias}
                          onSave={(icon) => saveCommandIcon(profile, icon)}
                        />
                      }
                      title={profile.alias}
                      description={describeCommandProfile(profile)}
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
                          onClick={() =>
                            setPendingDelete({
                              kind: 'command',
                              id: profile.id,
                              alias: profile.alias,
                            })
                          }
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </SettingRow>
                  ))}

                  <SettingRow
                    title={
                      isEmpty
                        ? t('settings.noAgents')
                        : t('settings.addAnotherAgent')
                    }
                    description={
                      isEmpty
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

                  {manifestError && (
                    <SettingRow
                      title={tAgent('loadFailed')}
                      description={manifestError}
                    >
                      <span />
                    </SettingRow>
                  )}
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
