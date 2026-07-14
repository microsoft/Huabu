import { Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  createAgentTeamDeployment,
  deleteAgentTeamDeployment,
  disableAgentTeamDeployment,
  enableAgentTeamDeployment,
  retryAgentTeamDeploymentSetup,
  updateAgentTeamDeployment,
} from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { Input, TEXT_INPUT_CLASS } from '@/components/Common/Input';
import { Modal } from '@/components/Common/Modal';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { toast } from '@/components/Common/Toast';
import { Toggle } from '@/components/Common/Toggle';

import type {
  AgentTeamDeploymentView,
  AgentTeamMemberView,
  AgentTeamSettingsState,
} from '@sediment/shared';

interface AgentTeamDeploymentsProps {
  member: AgentTeamMemberView;
  configReady: boolean;
  deployments: AgentTeamDeploymentView[];
  pendingAction: string | null;
  mutate: (
    action: string,
    operation: () => Promise<AgentTeamSettingsState>,
  ) => Promise<void>;
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
  status: AgentTeamDeploymentView['setup']['status'],
): string {
  if (status === 'ready') return 'bg-success-bg text-success';
  if (status === 'setting_up') return 'bg-info-bg text-info';
  if (status === 'error') return 'bg-danger-bg text-danger';
  return 'bg-bg-default text-fg-subtle';
}

const SETUP_STATUS_KEYS = {
  disabled: 'setupStatusDisabled',
  setting_up: 'setupStatusSettingUp',
  ready: 'setupStatusReady',
  error: 'setupStatusError',
} as const;

function DeploymentRow({
  deployment,
  member,
  configReady,
  pendingAction,
  mutate,
  onRequestDelete,
}: {
  deployment: AgentTeamDeploymentView;
  member: AgentTeamMemberView;
  configReady: boolean;
  pendingAction: string | null;
  mutate: AgentTeamDeploymentsProps['mutate'];
  onRequestDelete: (deployment: AgentTeamDeploymentView) => void;
}) {
  const { t } = useTranslation('agentTeam');
  const [alias, setAlias] = useState(deployment.alias);
  const [harness, setHarness] = useState(deployment.harness);
  const [workingDirPath, setWorkingDirPath] = useState(
    deployment.workingDirPath,
  );
  const busy = pendingAction !== null;
  const placementLocked =
    deployment.enabled || deployment.setup.status === 'setting_up';
  const action = `deployment:${deployment.id}`;

  useEffect(() => {
    setAlias(deployment.alias);
    setHarness(deployment.harness);
    setWorkingDirPath(deployment.workingDirPath);
  }, [deployment.alias, deployment.harness, deployment.workingDirPath]);

  const run = async (
    suffix: string,
    operation: () => Promise<AgentTeamSettingsState>,
    successMessage?: string,
  ) => {
    try {
      await mutate(`${action}:${suffix}`, operation);
      if (successMessage) toast(successMessage, { tone: 'success' });
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    }
  };

  const save = () =>
    run(
      'save',
      () =>
        updateAgentTeamDeployment(deployment.id, {
          alias: alias.trim(),
          harness,
          workingDirPath: workingDirPath.trim(),
        }),
      t('deploymentSaved'),
    );

  const toggle = (enabled: boolean) =>
    run(enabled ? 'enable' : 'disable', () =>
      enabled
        ? enableAgentTeamDeployment(deployment.id)
        : disableAgentTeamDeployment(deployment.id),
    );

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-fg-default truncate text-xs font-medium">
            {deployment.alias}
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(deployment.setup.status)}`}
          >
            {t(SETUP_STATUS_KEYS[deployment.setup.status])}
          </span>
        </div>
        <Toggle
          checked={deployment.enabled}
          onChange={toggle}
          disabled={busy || (!deployment.enabled && !configReady)}
          label={t('enabled')}
        />
      </div>

      <div className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(7rem,0.6fr)_minmax(0,1.4fr)_auto_auto] gap-2">
        <Input
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          aria-label={t('alias')}
          placeholder={t('alias')}
          disabled={busy}
          className={`${TEXT_INPUT_CLASS} min-w-0`}
        />
        <Select
          options={member.harnesses.map((value) => ({ value, label: value }))}
          value={harness}
          onChange={(value) => {
            setHarness(value);
            if (!placementLocked) {
              setWorkingDirPath(workspaceDefault(member.manifestPath, value));
            }
          }}
          disabled={busy || placementLocked}
          className="w-full"
        />
        <PathInput
          value={workingDirPath}
          onChange={setWorkingDirPath}
          pickerEnabled={false}
          placeholder={t('workingDirectory')}
          disabled={busy || placementLocked}
          size="sm"
          mono
        />
        <Button
          variant="outline"
          tone="neutral"
          size="sm"
          iconOnly
          title={t('save')}
          onClick={() => void save()}
          disabled={
            busy ||
            !alias.trim() ||
            !workingDirPath.trim() ||
            (alias === deployment.alias &&
              harness === deployment.harness &&
              workingDirPath === deployment.workingDirPath)
          }
        >
          <Save />
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          size="sm"
          iconOnly
          title={t('deleteDeployment')}
          disabled={busy || deployment.enabled}
          onClick={() => onRequestDelete(deployment)}
        >
          <Trash2 />
        </Button>
      </div>

      {deployment.setup.status === 'error' && (
        <div className="bg-danger-bg text-danger flex items-start justify-between gap-2 rounded-md px-2.5 py-2 text-[11px]">
          <span className="wrap-break-word">
            {deployment.setup.error.message}
          </span>
          {deployment.enabled && (
            <Button
              variant="outline"
              tone="danger"
              size="sm"
              onClick={() =>
                void run('retry', () =>
                  retryAgentTeamDeploymentSetup(deployment.id),
                )
              }
              disabled={busy}
            >
              <RotateCcw />
              {t('retrySetup')}
            </Button>
          )}
        </div>
      )}

      {deployment.setupLog.length > 0 && (
        <details className="text-fg-subtle text-[11px]">
          <summary className="hover:text-fg-default cursor-pointer">
            {t('setupLog', {
              count: deployment.setupLog.length,
            })}
          </summary>
          <div className="border-edge-default mt-1 max-h-32 space-y-1 overflow-y-auto border-l pl-2 font-mono">
            {deployment.setupLog.map((entry, index) => (
              <p key={`${entry.receivedAt}:${entry.phase}:${index}`}>
                {entry.phase} · {entry.status} · {entry.message}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function AgentTeamDeployments({
  member,
  configReady,
  deployments,
  pendingAction,
  mutate,
}: AgentTeamDeploymentsProps) {
  const { t } = useTranslation('agentTeam');
  const defaultHarness = member.harnesses[0] ?? '';
  const [creating, setCreating] = useState(false);
  const [alias, setAlias] = useState(member.name);
  const [harness, setHarness] = useState(defaultHarness);
  const [workingDirPath, setWorkingDirPath] = useState(() =>
    workspaceDefault(member.manifestPath, defaultHarness),
  );
  const [pendingDelete, setPendingDelete] =
    useState<AgentTeamDeploymentView | null>(null);
  const busy = pendingAction !== null;

  const harnessOptions = useMemo(
    () => member.harnesses.map((value) => ({ value, label: value })),
    [member.harnesses],
  );

  const create = async () => {
    try {
      await mutate(`create:${member.machine}:${member.manifestPath}`, () =>
        createAgentTeamDeployment({
          alias: alias.trim(),
          machine: member.machine,
          manifestPath: member.manifestPath,
          harness,
          workingDirPath: workingDirPath.trim(),
        }),
      );
      toast(t('deploymentCreated'), { tone: 'success' });
      setCreating(false);
      setAlias(member.name);
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    }
  };

  const beginCreate = () => {
    const nextHarness = member.harnesses[0] ?? '';
    setAlias(member.name);
    setHarness(nextHarness);
    setWorkingDirPath(workspaceDefault(member.manifestPath, nextHarness));
    setCreating(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await mutate(`deployment:${pendingDelete.id}:delete`, () =>
        deleteAgentTeamDeployment(pendingDelete.id),
      );
      toast(t('deploymentDeleted'), { tone: 'success' });
      setPendingDelete(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
    }
  };

  return (
    <>
      {deployments.map((deployment) => (
        <DeploymentRow
          key={deployment.id}
          deployment={deployment}
          member={member}
          configReady={configReady}
          pendingAction={pendingAction}
          mutate={mutate}
          onRequestDelete={setPendingDelete}
        />
      ))}

      {creating ? (
        <div className="space-y-2 px-3 py-3">
          <p className="text-fg-default text-xs font-medium">
            {t('newDeployment')}
          </p>
          <div className="grid grid-cols-[minmax(7rem,0.7fr)_minmax(7rem,0.6fr)_minmax(0,1.4fr)] gap-2">
            <Input
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              placeholder={t('alias')}
              aria-label={t('alias')}
              className={`${TEXT_INPUT_CLASS} min-w-0`}
              autoFocus
            />
            <Select
              options={harnessOptions}
              value={harness}
              onChange={(value) => {
                setHarness(value);
                setWorkingDirPath(workspaceDefault(member.manifestPath, value));
              }}
              className="w-full"
            />
            <PathInput
              value={workingDirPath}
              onChange={setWorkingDirPath}
              pickerEnabled={false}
              placeholder={t('workingDirectory')}
              size="sm"
              mono
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => setCreating(false)}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="solid"
              tone="info"
              size="sm"
              onClick={() => void create()}
              disabled={
                busy || !alias.trim() || !harness || !workingDirPath.trim()
              }
            >
              <Plus />
              {t('add')}
            </Button>
          </div>
        </div>
      ) : (
        <SettingRow
          title={t('addDeployment')}
          description={t('addDeploymentDescription')}
        >
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={beginCreate}
            disabled={busy || member.status !== 'active'}
          >
            <Plus />
            {t('add')}
          </Button>
        </SettingRow>
      )}

      <Modal
        isOpen={pendingDelete !== null}
        title={t('deleteDeploymentTitle')}
        description={t('deleteDeploymentDescription', {
          alias: pendingDelete?.alias ?? '',
        })}
        onClose={() => {
          if (!busy) setPendingDelete(null);
        }}
        closeOnBackdropClick={!busy}
        closeOnEscape={!busy}
        footer={
          <>
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="solid"
              tone="danger"
              size="sm"
              onClick={() => void confirmDelete()}
              disabled={busy}
            >
              <Trash2 />
              {t('deleteDeployment')}
            </Button>
          </>
        }
      />
    </>
  );
}
