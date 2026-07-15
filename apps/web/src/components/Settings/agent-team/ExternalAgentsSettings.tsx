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
 *    through the inline {@link ProfileEditorForm}.
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
import {
  ProfileEditorForm,
  useDetectedClis,
} from '@/components/Settings/sections/ProfileEditor';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import { AddAgentFlow } from './AddAgentFlow';
import { AgentletHealthBanner } from './AgentletHealthBanner';
import { ManifestProfileEditor } from './ManifestProfileEditor';
import { useUnifiedAgents, type ManifestProfileRow } from './useUnifiedAgents';

import type {
  AcpCommandProfileView,
  AgentTeamManifestProfileView,
} from '@sediment/shared';

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

  const [addOpen, setAddOpen] = useState(false);
  const [editingCommand, setEditingCommand] =
    useState<AcpCommandProfileView | null>(null);
  const [editingManifest, setEditingManifest] =
    useState<ManifestProfileRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [pendingSetup, setPendingSetup] = useState<string | null>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);

  const editorEnabled = addOpen || editingCommand !== null;
  const { detectedClis, loaded: detectionLoaded } =
    useDetectedClis(editorEnabled);

  const memberRefOf = (row: ManifestProfileRow) => ({
    machine: row.member.machine,
    manifestPath: row.member.manifestPath,
  });

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
              const lastLog =
                row.profile.setupLog[row.profile.setupLog.length - 1];
              const statusDetail =
                status === 'error'
                  ? row.profile.preparation.error.message
                  : lastLog?.message;
              return (
                <SettingRow
                  key={row.profile.id}
                  title={row.profile.alias}
                  description={[
                    t('settings.agentTemplateBadge'),
                    row.profile.launch.harness,
                    row.profile.workingDirPath,
                    statusDetail,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                >
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`${STATUS_CLASS[status]} inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap`}
                    >
                      {tAgent(STATUS_KEY[status])}
                    </span>
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
                      onClick={() => {
                        setAddOpen(false);
                        setEditingCommand(null);
                        setEditingManifest(row);
                      }}
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
                description={[
                  t('settings.agentCustomBadge'),
                  profile.launch.command,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    tone="neutral"
                    size="sm"
                    iconOnly
                    title={t('settings.editProfile')}
                    onClick={() => {
                      setAddOpen(false);
                      setEditingManifest(null);
                      setEditingCommand(profile);
                    }}
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
                onClick={() => {
                  setEditingCommand(null);
                  setEditingManifest(null);
                  setAddOpen(true);
                }}
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

      {addOpen && (
        <SettingSection title={t('settings.addAgent')}>
          <AddAgentFlow
            members={members}
            manifestError={manifestError}
            detectedClis={detectedClis}
            detectionLoaded={detectionLoaded}
            onClose={() => setAddOpen(false)}
            onCommandCreated={async () => {
              await refreshCommand();
              setAddOpen(false);
            }}
            onManifestCreated={async (ref) => {
              await refreshMember(ref);
            }}
            applyMemberDetail={applyMemberDetail}
          />
        </SettingSection>
      )}

      {editingCommand && (
        <SettingSection title={t('settings.editExternalAgent')}>
          <ProfileEditorForm
            editing={editingCommand}
            detectedClis={detectedClis}
            detectionLoaded={detectionLoaded}
            onClose={() => setEditingCommand(null)}
            onSaved={refreshCommand}
          />
        </SettingSection>
      )}

      {editingManifest && (
        <SettingSection title={t('settings.editExternalAgent')}>
          <ManifestProfileEditor
            row={editingManifest}
            onClose={() => setEditingManifest(null)}
            applyMemberDetail={applyMemberDetail}
            onAliasSaved={async () => {
              await refreshMember(memberRefOf(editingManifest));
            }}
          />
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
