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
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { deleteAcpProfile, restartAcpAgentlet } from '@/api/acp';
import {
  cancelAgentTeamProfileSetup,
  deleteAgentTeamProfile,
  setupAgentTeamProfile,
} from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Loading } from '@/components/Common/Loading';
import { Modal } from '@/components/Common/Modal';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import { AgentletHealthBanner } from './AgentletHealthBanner';
import { AgentProfileEditor } from './AgentProfileEditor';
import { useDetectedClis } from './useDetectedClis';
import { useUnifiedAgents, type ManifestProfileRow } from './useUnifiedAgents';

import type {
  AcpCommandProfileView,
  AgentTeamManifestProfileView,
} from '@sediment/shared';

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

export function ExternalAgentsSettings() {
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
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);

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
                detectedClis.find((c) => c.id === row.profile.launch.harness)
                  ?.displayName ?? row.profile.launch.harness;
              return (
                <SettingRow
                  key={row.profile.id}
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
                    {status !== 'ready' ? (
                      <span
                        className={`${STATUS_CLASS[status]} inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
                        title={errorMessage}
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
                      onClick={() => setEditor({ kind: 'edit-manifest', row })}
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
                    onClick={() => setEditor({ kind: 'edit-command', profile })}
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
                isEmpty ? t('settings.noAgents') : t('settings.addAnotherAgent')
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
                onClick={() => setEditor({ kind: 'create' })}
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

      {editor && (
        <SettingSection
          title={
            editor.kind === 'create'
              ? t('settings.addAgent')
              : t('settings.editExternalAgent')
          }
        >
          {editor.kind === 'create' ? (
            <AgentProfileEditor
              mode="create"
              members={members}
              manifestError={manifestError}
              detectedClis={detectedClis}
              detectionLoaded={detectionLoaded}
              onClose={() => setEditor(null)}
              onCommandCreated={async () => {
                await refreshCommand();
                setEditor(null);
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
              onClose={() => setEditor(null)}
              onSaved={refreshCommand}
            />
          ) : (
            <AgentProfileEditor
              mode="edit-manifest"
              row={editor.row}
              detectedClis={detectedClis}
              onClose={() => setEditor(null)}
              applyMemberDetail={applyMemberDetail}
              onAliasSaved={async () => {
                await refreshMember(memberRefOf(editor.row));
              }}
            />
          )}
        </SettingSection>
      )}

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
