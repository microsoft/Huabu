import { AlertCircle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getAgentTeamMemberDetail } from '@/api/agent-team';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';

import { AgentTeamConfigs } from '../agent-team/AgentTeamConfigs';
import { AgentTeamProfiles } from '../agent-team/AgentTeamProfiles';
import { AgentTeamRoots } from '../agent-team/AgentTeamRoots';
import { useAgentTeamSettings } from '../agent-team/useAgentTeamSettings';

import type {
  AgentTeamMemberDetailView,
  AgentTeamMemberSummaryView,
  AgentTeamSettingsState,
} from '@sediment/shared';

function MemberSection({ summary }: { summary: AgentTeamMemberSummaryView }) {
  const { t } = useTranslation('agentTeam');
  const [detail, setDetail] = useState<AgentTeamMemberDetailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const loadingRef = useRef(false);
  const summaryVersion = JSON.stringify([
    summary.status,
    summary.profileCount,
    summary.preparationCounts,
  ]);
  const previousSummaryVersion = useRef(summaryVersion);

  const load = useCallback(
    async (force = false) => {
      if ((!force && detail) || loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        setDetail(
          await getAgentTeamMemberDetail({
            machine: summary.machine,
            manifestPath: summary.manifestPath,
          }),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('operationFailed'));
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [detail, summary.machine, summary.manifestPath, t],
  );

  useEffect(() => {
    if (previousSummaryVersion.current === summaryVersion) return;
    previousSummaryVersion.current = summaryVersion;
    setDetail(null);
    if (expanded) void load(true);
  }, [expanded, load, summaryVersion]);

  const setupActive = detail?.profiles.some(
    (profile) => profile.preparation.status === 'setting_up',
  );
  useEffect(() => {
    if (!expanded || !setupActive) return;
    const timer = window.setInterval(() => void load(true), 1_000);
    return () => window.clearInterval(timer);
  }, [expanded, load, setupActive]);

  return (
    <SettingSection
      title={`${summary.name} · ${summary.profileCount} ${t('profiles')}`}
      collapsible
      defaultCollapsed
      onCollapsedChange={(collapsed) => {
        setExpanded(!collapsed);
        if (!collapsed) void load();
      }}
    >
      {loading && (
        <SettingRow title={t('loadingMemberDetail')}>
          <Loader2 className="text-fg-muted animate-spin" size={16} />
        </SettingRow>
      )}
      {error && (
        <SettingRow title={t('loadMemberDetailFailed')} description={error}>
          <AlertCircle className="text-danger" size={16} />
        </SettingRow>
      )}
      {detail && (
        <>
          <AgentTeamConfigs config={detail.config} onDetailChange={setDetail} />
          <AgentTeamProfiles
            member={detail.member}
            configReady={detail.config.ready}
            profiles={detail.profiles}
            onProfilesChange={(profiles) =>
              setDetail((current) =>
                current ? { ...current, profiles } : current,
              )
            }
          />
        </>
      )}
    </SettingSection>
  );
}

export function AgentTeamSettings() {
  const { t } = useTranslation('agentTeam');
  const { state, loadError, pendingAction, mutate } = useAgentTeamSettings();

  if (!state && !loadError) {
    return (
      <div className="text-fg-muted flex items-center gap-2 py-8 text-sm">
        <Loader2 className="animate-spin" size={16} />
        {t('loading')}
      </div>
    );
  }

  if (loadError && !state) {
    return (
      <div className="border-danger/20 bg-danger-bg text-danger flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <AlertCircle size={16} />
        {t('loadFailed')}: {loadError}
      </div>
    );
  }

  if (!state) return null;

  const runMutation = async (
    action: string,
    operation: () => Promise<AgentTeamSettingsState>,
  ) => {
    await mutate(action, operation);
  };

  return (
    <div className="space-y-4">
      <AgentTeamRoots
        machines={state.machines}
        localMachine={state.localMachine}
        roots={state.roots}
        pendingAction={pendingAction}
        mutate={runMutation}
      />

      {state.members.length === 0 ? (
        <SettingSection title={t('profiles')}>
          <SettingRow
            title={t('noMembers')}
            description={t('rootsDescription')}
          >
            <div />
          </SettingRow>
        </SettingSection>
      ) : (
        state.members.map((member) => (
          <MemberSection
            key={`${member.machine}\u0000${member.manifestPath}`}
            summary={member}
          />
        ))
      )}
    </div>
  );
}
