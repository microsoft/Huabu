import { AlertTriangle, Package } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/Common/EmptyState';
import { Loading } from '@/components/Common/Loading';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';

import { AgentTeamConfigs } from '../agent-team/AgentTeamConfigs';
import { AgentTeamDeployments } from '../agent-team/AgentTeamDeployments';
import { AgentTeamRoots } from '../agent-team/AgentTeamRoots';
import { useAgentTeamSettings } from '../agent-team/useAgentTeamSettings';

export function AgentTeamSettings() {
  const { t } = useTranslation('agentTeam');
  const { state, streamError, pendingAction, mutate } = useAgentTeamSettings();

  const configsByMember = useMemo(
    () =>
      new Map(
        state?.configs.map((config) => [
          JSON.stringify([config.machine, config.manifestPath]),
          config,
        ]) ?? [],
      ),
    [state?.configs],
  );
  const deploymentsByMember = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof state>['deployments']>();
    for (const deployment of state?.deployments ?? []) {
      const key = JSON.stringify([deployment.machine, deployment.manifestPath]);
      const deployments = grouped.get(key);
      if (deployments) deployments.push(deployment);
      else grouped.set(key, [deployment]);
    }
    return grouped;
  }, [state?.deployments]);

  if (!state) {
    if (streamError) {
      return <EmptyState message={streamError} className="py-12" />;
    }
    return <Loading layout="block" message={t('loading')} className="py-12" />;
  }

  return (
    <>
      {streamError && (
        <div className="border-warning bg-warning-bg text-warning mb-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 shrink-0" size={14} />
          <span>{streamError}</span>
        </div>
      )}

      <AgentTeamRoots
        machines={state.machines}
        localMachine={state.localMachine}
        roots={state.roots}
        pendingAction={pendingAction}
        mutate={mutate}
      />

      {state.members.length === 0 ? (
        <EmptyState message={t('noMembers')} className="py-12" />
      ) : (
        state.members.map((member) => {
          const key = JSON.stringify([member.machine, member.manifestPath]);
          const config = configsByMember.get(key);
          if (!config) return null;
          return (
            <SettingSection
              key={key}
              title={`${member.name} · ${member.machine}`}
              collapsible
            >
              <SettingRow
                title={member.description || member.name}
                description={member.manifestPath}
              >
                <span
                  className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    member.status === 'active'
                      ? 'bg-success-bg text-success'
                      : 'bg-warning-bg text-warning'
                  }`}
                >
                  <Package size={11} />
                  {t(
                    member.status === 'active'
                      ? 'memberStatusActive'
                      : 'memberStatusMissing',
                  )}
                </span>
              </SettingRow>

              <div className="bg-bg-default px-3 py-1.5">
                <p className="text-fg-muted text-[10px] font-semibold tracking-wide uppercase">
                  {t('configs')}
                </p>
              </div>
              <AgentTeamConfigs
                config={config}
                pendingAction={pendingAction}
                mutate={mutate}
              />

              <div className="bg-bg-default px-3 py-1.5">
                <p className="text-fg-muted text-[10px] font-semibold tracking-wide uppercase">
                  {t('deployments')}
                </p>
              </div>
              <AgentTeamDeployments
                member={member}
                configReady={config.ready}
                deployments={deploymentsByMember.get(key) ?? []}
                pendingAction={pendingAction}
                mutate={mutate}
              />
            </SettingSection>
          );
        })
      )}
    </>
  );
}
