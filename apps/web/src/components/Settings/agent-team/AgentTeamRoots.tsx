import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  addAgentTeamRoot,
  removeAgentTeamRoot,
  rescanAgentTeamRoot,
} from '@/api/agent-team';
import { Button } from '@/components/Common/Button';
import { PathInput } from '@/components/Common/PathInput';
import { Select } from '@/components/Common/Select';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';

import type {
  AgentTeamMachineView,
  AgentTeamRootView,
  AgentTeamSettingsState,
} from '@sediment/shared';

interface AgentTeamRootsProps {
  machines: AgentTeamMachineView[];
  localMachine: string;
  roots: AgentTeamRootView[];
  pendingAction: string | null;
  mutate: (
    action: string,
    operation: () => Promise<AgentTeamSettingsState>,
  ) => Promise<void>;
}

function rootKey(root: Pick<AgentTeamRootView, 'machine' | 'path'>): string {
  return JSON.stringify([root.machine, root.path]);
}

const ROOT_STATUS_KEYS = {
  never_scanned: 'rootStatusNeverScanned',
  success: 'rootStatusSuccess',
  error: 'rootStatusError',
} as const;

export function AgentTeamRoots({
  machines,
  localMachine,
  roots,
  pendingAction,
  mutate,
}: AgentTeamRootsProps) {
  const { t } = useTranslation('agentTeam');
  const defaultMachine =
    machines.find((machine) => machine.machine === localMachine)?.machine ??
    machines[0]?.machine ??
    '';
  const [machine, setMachine] = useState(defaultMachine);
  const [path, setPath] = useState('');

  useEffect(() => {
    if (!machine && defaultMachine) setMachine(defaultMachine);
  }, [defaultMachine, machine]);

  const machineOptions = useMemo(
    () =>
      machines.map((item) => ({
        value: item.machine,
        label:
          item.machine === localMachine
            ? t('localMachine', {
                hostname: item.hostname,
              })
            : item.hostname,
        description: `${item.machine} · ${item.platform}`,
      })),
    [localMachine, machines, t],
  );

  const run = async (
    action: string,
    operation: () => Promise<AgentTeamSettingsState>,
    successMessage: string,
  ): Promise<boolean> => {
    try {
      await mutate(action, operation);
      toast(successMessage, { tone: 'success' });
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : t('operationFailed'), {
        tone: 'danger',
      });
      return false;
    }
  };

  const addRoot = async () => {
    const trimmedPath = path.trim();
    if (!machine || !trimmedPath) return;
    const added = await run(
      'add-root',
      () => addAgentTeamRoot({ machine, path: trimmedPath }),
      t('rootAdded'),
    );
    if (added) setPath('');
  };

  return (
    <SettingSection title={t('roots')}>
      <div className="space-y-2 px-3 py-3">
        <p className="text-fg-subtle text-[11px] leading-snug">
          {t('rootsDescription')}
        </p>
        <div className="grid grid-cols-[minmax(8rem,0.8fr)_minmax(0,1.4fr)_auto] gap-2">
          <Select
            options={machineOptions}
            value={machine}
            onChange={setMachine}
            placeholder={t('noMachines')}
            disabled={machines.length === 0 || pendingAction !== null}
            className="w-full"
          />
          <PathInput
            value={path}
            onChange={setPath}
            onPicked={setPath}
            pickerEnabled={machine === localMachine}
            placeholder={t('rootPathPlaceholder')}
            pickTitle={t('pickFolder')}
            disabled={!machine || pendingAction !== null}
            size="sm"
            mono
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addRoot();
            }}
          />
          <Button
            variant="solid"
            tone="info"
            size="sm"
            onClick={() => void addRoot()}
            disabled={!machine || !path.trim() || pendingAction !== null}
          >
            <Plus />
            {t('add')}
          </Button>
        </div>
      </div>

      {roots.map((root) => {
        const key = rootKey(root);
        const scanDescription =
          root.scan.status === 'error'
            ? root.scan.message
            : root.scan.status === 'success' && root.scan.diagnostics.length > 0
              ? t('diagnosticCount', {
                  count: root.scan.diagnostics.length,
                })
              : t(ROOT_STATUS_KEYS[root.scan.status]);
        return (
          <SettingRow
            key={key}
            title={root.path}
            description={`${root.machine} · ${scanDescription}`}
          >
            <div className="flex gap-1">
              <Button
                variant="ghost"
                tone="neutral"
                size="sm"
                iconOnly
                title={t('rescanRoot')}
                disabled={pendingAction !== null}
                onClick={() =>
                  void run(
                    `rescan:${key}`,
                    () => rescanAgentTeamRoot(root),
                    t('rootRescanned'),
                  )
                }
              >
                <RefreshCw
                  className={
                    pendingAction === `rescan:${key}`
                      ? 'animate-spin'
                      : undefined
                  }
                />
              </Button>
              <Button
                variant="ghost"
                tone="danger"
                size="sm"
                iconOnly
                title={t('removeRoot')}
                disabled={pendingAction !== null}
                onClick={() =>
                  void run(
                    `remove:${key}`,
                    () => removeAgentTeamRoot(root),
                    t('rootRemoved'),
                  )
                }
              >
                <Trash2 />
              </Button>
            </div>
          </SettingRow>
        );
      })}
    </SettingSection>
  );
}
