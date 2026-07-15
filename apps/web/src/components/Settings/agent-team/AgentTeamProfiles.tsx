import { Play, Plus, Save, Square, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cancelAgentTeamProfileSetup,
  createAgentTeamProfile,
  deleteAgentTeamProfile,
  patchAgentTeamProfile,
  setupAgentTeamProfile,
} from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Input, TEXT_INPUT_CLASS } from '@/components/Common/Input';
import { Modal } from '@/components/Common/Modal';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { toast } from '@/components/Common/Toast';

import type {
  AgentProfileView,
  AgentTeamManifestProfileView,
  AgentTeamMemberView,
} from '@sediment/shared';

interface AgentTeamProfilesProps {
  member: AgentTeamMemberView;
  configReady: boolean;
  profiles: AgentTeamManifestProfileView[];
  onProfilesChange: (profiles: AgentTeamManifestProfileView[]) => void;
}

function workspaceDefault(manifestPath: string, harness: string): string {
  const slash = manifestPath.lastIndexOf('/');
  const backslash = manifestPath.lastIndexOf('\\');
  const index = Math.max(slash, backslash);
  const separator = backslash > slash ? '\\' : '/';
  const directory = index >= 0 ? manifestPath.slice(0, index) : manifestPath;
  return `${directory}${separator}workspaces${separator}${harness}`;
}

function statusTone(
  status: AgentTeamManifestProfileView['preparation']['status'],
): string {
  if (status === 'ready') return 'bg-success-bg text-success';
  if (status === 'setting_up') return 'bg-info-bg text-info';
  if (status === 'error') return 'bg-danger-bg text-danger';
  return 'bg-bg-default text-fg-subtle';
}

const STATUS_KEYS = {
  not_prepared: 'setupStatusNotPrepared',
  setting_up: 'setupStatusSettingUp',
  ready: 'setupStatusReady',
  error: 'setupStatusError',
} as const;

function requireManifestProfile(
  profile: AgentProfileView,
): AgentTeamManifestProfileView {
  if (!('preparation' in profile)) {
    throw new Error('Agent Team API returned an invalid Profile kind');
  }
  return profile;
}

export function AgentTeamProfiles({
  member,
  configReady,
  profiles,
  onProfilesChange,
}: AgentTeamProfilesProps) {
  const { t } = useTranslation('agentTeam');
  const firstHarness = member.harnesses[0] ?? '';
  const [showCreate, setShowCreate] = useState(profiles.length === 0);
  const [alias, setAlias] = useState('');
  const [harness, setHarness] = useState(firstHarness);
  const [workingDirPath, setWorkingDirPath] = useState(() =>
    workspaceDefault(member.manifestPath, firstHarness),
  );
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<AgentTeamManifestProfileView | null>(null);

  const harnessOptions = useMemo(
    () => member.harnesses.map((value) => ({ value, label: value })),
    [member.harnesses],
  );

  const upsert = (profile: AgentTeamManifestProfileView) => {
    onProfilesChange([
      ...profiles.filter((candidate) => candidate.id !== profile.id),
      profile,
    ]);
  };

  const run = async (
    action: string,
    operation: () => Promise<AgentTeamManifestProfileView>,
  ) => {
    setPending(action);
    try {
      upsert(await operation());
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    } finally {
      setPending(null);
    }
  };

  const create = async () => {
    if (!alias.trim() || !harness || !workingDirPath.trim()) return;
    await run('create', async () => {
      const created = requireManifestProfile(
        await createAgentTeamProfile({
          alias: alias.trim(),
          agentletId: member.machine,
          workingDirPath: workingDirPath.trim(),
          launch: {
            kind: 'agent-team-manifest',
            manifestPath: member.manifestPath,
            harness,
          },
        }),
      );
      setAlias('');
      setShowCreate(false);
      toast(t('profileCreated'), { tone: 'success' });
      return created;
    });
  };

  return (
    <>
      {profiles.map((profile) => {
        const busy = pending !== null;
        const status = profile.preparation.status;
        const aliasDraft = aliasDrafts[profile.id] ?? profile.alias;
        const statusDetail =
          status === 'error'
            ? profile.preparation.error.message
            : profile.setupLog.at(-1)?.message;
        return (
          <SettingRow
            key={profile.id}
            title={
              <Input
                value={aliasDraft}
                onChange={(event) =>
                  setAliasDrafts((current) => ({
                    ...current,
                    [profile.id]: event.target.value,
                  }))
                }
                aria-label={t('alias')}
                disabled={busy}
                className={TEXT_INPUT_CLASS}
              />
            }
            description={[
              profile.launch.harness,
              profile.workingDirPath,
              statusDetail,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(status)}`}
              >
                {t(STATUS_KEYS[status])}
              </span>
              {aliasDraft.trim() !== profile.alias && (
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  iconOnly
                  title={t('save')}
                  disabled={busy || !aliasDraft.trim()}
                  onClick={() =>
                    void run(`patch:${profile.id}`, async () =>
                      requireManifestProfile(
                        await patchAgentTeamProfile(profile.id, {
                          alias: aliasDraft.trim(),
                        }),
                      ),
                    )
                  }
                >
                  <Save />
                </Button>
              )}
              {status === 'setting_up' ? (
                <Button
                  variant="outline"
                  tone="neutral"
                  size="sm"
                  title={t('cancelSetup')}
                  disabled={busy}
                  onClick={() =>
                    void run(`cancel:${profile.id}`, async () =>
                      requireManifestProfile(
                        await cancelAgentTeamProfileSetup(profile.id),
                      ),
                    )
                  }
                >
                  <Square size={13} />
                  {t('cancelSetup')}
                </Button>
              ) : status !== 'ready' ? (
                <Button
                  variant="outline"
                  tone="neutral"
                  size="sm"
                  title={status === 'error' ? t('retrySetup') : t('setup')}
                  disabled={busy || !configReady}
                  onClick={() =>
                    void run(`setup:${profile.id}`, async () =>
                      requireManifestProfile(
                        await setupAgentTeamProfile(profile.id),
                      ),
                    )
                  }
                >
                  <Play size={13} />
                  {status === 'error' ? t('retrySetup') : t('setup')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                tone="danger"
                size="sm"
                iconOnly
                title={t('deleteProfile')}
                disabled={busy}
                onClick={() => setDeleteTarget(profile)}
              >
                <Trash2 />
              </Button>
            </div>
          </SettingRow>
        );
      })}

      {showCreate ? (
        <SettingRow
          title={t('newProfile')}
          description={t('addProfileDescription')}
        >
          <div className="flex min-w-80 flex-col gap-2 py-1">
            <Input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder={t('alias')}
              disabled={pending !== null}
              className={TEXT_INPUT_CLASS}
            />
            <Select
              value={harness}
              options={harnessOptions}
              disabled={pending !== null}
              title={t('harness')}
              onChange={(value) => {
                setHarness(value);
                setWorkingDirPath(workspaceDefault(member.manifestPath, value));
              }}
            />
            <PathInput
              value={workingDirPath}
              onChange={setWorkingDirPath}
              placeholder={t('workingDirectory')}
              disabled={pending !== null}
            />
            <div className="flex justify-end gap-1.5">
              {profiles.length > 0 && (
                <Button
                  variant="ghost"
                  tone="neutral"
                  size="sm"
                  onClick={() => setShowCreate(false)}
                >
                  {t('cancel')}
                </Button>
              )}
              <Button
                variant="solid"
                tone="neutral"
                size="sm"
                disabled={
                  pending !== null ||
                  !alias.trim() ||
                  !harness ||
                  !workingDirPath.trim()
                }
                onClick={() => void create()}
              >
                <Save size={13} />
                {t('save')}
              </Button>
            </div>
          </div>
        </SettingRow>
      ) : (
        <SettingRow
          title={t('profiles')}
          description={t('addProfileDescription')}
        >
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={13} />
            {t('addProfile')}
          </Button>
        </SettingRow>
      )}

      <Modal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('deleteProfileTitle')}
      >
        <p className="text-fg-muted text-sm">
          {t('deleteProfileDescription', { alias: deleteTarget?.alias })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            onClick={() => setDeleteTarget(null)}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="solid"
            tone="danger"
            size="sm"
            disabled={pending !== null}
            onClick={() => {
              if (!deleteTarget) return;
              const target = deleteTarget;
              setPending(`delete:${target.id}`);
              void deleteAgentTeamProfile(target.id)
                .then(() => {
                  onProfilesChange(
                    profiles.filter((profile) => profile.id !== target.id),
                  );
                  setDeleteTarget(null);
                  toast(t('profileDeleted'), { tone: 'success' });
                })
                .catch((error: unknown) => {
                  toast(
                    error instanceof Error
                      ? error.message
                      : t('operationFailed'),
                    { tone: 'danger' },
                  );
                })
                .finally(() => setPending(null));
            }}
          >
            {t('deleteProfile')}
          </Button>
        </div>
      </Modal>
    </>
  );
}
