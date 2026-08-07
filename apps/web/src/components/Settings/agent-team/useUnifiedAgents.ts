// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `useUnifiedAgents` — data layer behind the single "External Agents"
 * Settings tab.
 *
 * It fuses the two backend surfaces that used to power separate tabs:
 *
 *  - `acpProfilesStore` (`GET /api/acp/profiles`) — command-backed ACP
 *    Profiles and the agentlet daemon health snapshot.
 *  - Agent Team Settings (`GET /api/agent-team/*`) — the bundled manifest
 *    members, their member-level Configs, and every manifest Profile
 *    (including ones that are not yet prepared, which the ACP list omits
 *    because they are not selectable).
 *
 * The bundled collection is fixed and tiny (a handful of members), so we
 * eagerly load every member detail on mount and merge them into one flat
 * view rather than lazy-loading per expanded member. Setup progress for a
 * `setting_up` Profile is polled by refreshing that member's detail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getAgentTeamMemberDetail,
  getAgentTeamSettings,
} from '@/api/agent-team';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';

import type {
  AcpCommandProfileView,
  AgentProfileView,
  AgentTeamManifestProfileDetailView,
  AgentTeamMemberConfigView,
  AgentTeamMemberDetailView,
  AgentTeamMemberView,
} from '@huabu/shared';

function isCommandProfile(
  profile: AgentProfileView,
): profile is AcpCommandProfileView {
  return !('preparation' in profile);
}

function memberKey(ref: { machine: string; manifestPath: string }): string {
  return `${ref.machine}\u0000${ref.manifestPath}`;
}

/** One bundled manifest member plus its shared Config and Profiles. */
export interface ManifestMemberGroup {
  member: AgentTeamMemberView;
  config: AgentTeamMemberConfigView;
  profiles: AgentTeamManifestProfileDetailView[];
}

/** A manifest Profile flattened together with its owning member. */
export interface ManifestProfileRow {
  profile: AgentTeamManifestProfileDetailView;
  member: AgentTeamMemberView;
  config: AgentTeamMemberConfigView;
}

export interface UnifiedAgents {
  /** True until both surfaces have resolved at least once. */
  loading: boolean;
  /** Fatal manifest-load error (the ACP list surfaces its own via toast). */
  manifestError: string | null;
  /** Command-backed ACP Profiles (custom launch commands). */
  commandProfiles: AcpCommandProfileView[];
  /** Bundled members with their shared Config and manifest Profiles. */
  members: ManifestMemberGroup[];
  /** Every manifest Profile flattened with its owning member for the list. */
  manifestProfiles: ManifestProfileRow[];
  /** Refresh the ACP surface (command Profiles + daemon snapshot). */
  refreshCommand: () => Promise<void>;
  /** Refresh every bundled member detail. */
  refreshManifest: () => Promise<void>;
  /** Refresh a single member detail (used by setup polling). */
  refreshMember: (ref: {
    machine: string;
    manifestPath: string;
  }) => Promise<void>;
  /** Replace one member detail in the cache from a mutation response. */
  applyMemberDetail: (detail: AgentTeamMemberDetailView) => void;
}

export function useUnifiedAgents(): UnifiedAgents {
  const rawProfiles = useAcpProfilesStore((s) => s.profiles);
  const refreshCommandStore = useAcpProfilesStore((s) => s.refresh);
  const commandLoaded = useAcpProfilesStore((s) => s.loaded);

  const [details, setDetails] = useState<Map<
    string,
    AgentTeamMemberDetailView
  > | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshMember = useCallback(
    async (ref: { machine: string; manifestPath: string }) => {
      const detail = await getAgentTeamMemberDetail(ref);
      if (!mounted.current) return;
      setDetails((current) => {
        const next = new Map(current ?? []);
        next.set(memberKey(detail.member), detail);
        return next;
      });
    },
    [],
  );

  const applyMemberDetail = useCallback((detail: AgentTeamMemberDetailView) => {
    if (!mounted.current) return;
    setDetails((current) => {
      const next = new Map(current ?? []);
      next.set(memberKey(detail.member), detail);
      return next;
    });
  }, []);

  const refreshManifest = useCallback(async () => {
    try {
      const state = await getAgentTeamSettings();
      const activeMembers = state.members.filter(
        (member) => member.status === 'active',
      );
      const loaded = await Promise.all(
        activeMembers.map((member) =>
          getAgentTeamMemberDetail({
            machine: member.machine,
            manifestPath: member.manifestPath,
          }),
        ),
      );
      if (!mounted.current) return;
      setDetails(
        new Map(loaded.map((detail) => [memberKey(detail.member), detail])),
      );
      setManifestError(null);
    } catch (error) {
      if (!mounted.current) return;
      setDetails(new Map());
      setManifestError(
        error instanceof Error ? error.message : 'Failed to load Agent Teams',
      );
    }
  }, []);

  useEffect(() => {
    void refreshManifest();
  }, [refreshManifest]);

  const commandProfiles = useMemo(
    () => rawProfiles.filter(isCommandProfile),
    [rawProfiles],
  );

  const members = useMemo<ManifestMemberGroup[]>(() => {
    if (!details) return [];
    return [...details.values()].map((detail) => ({
      member: detail.member,
      config: detail.config,
      profiles: detail.profiles,
    }));
  }, [details]);

  const manifestProfiles = useMemo<ManifestProfileRow[]>(
    () =>
      members.flatMap((group) =>
        group.profiles.map((profile) => ({
          profile,
          member: group.member,
          config: group.config,
        })),
      ),
    [members],
  );

  // Poll member detail while any of its Profiles is setting up so the
  // status badge and setup log advance without user interaction.
  const settingUpKeys = useMemo(
    () =>
      members
        .filter((group) =>
          group.profiles.some(
            (profile) => profile.preparation.status === 'setting_up',
          ),
        )
        .map((group) => ({
          machine: group.member.machine,
          manifestPath: group.member.manifestPath,
        })),
    [members],
  );
  const settingUpSignature = settingUpKeys.map(memberKey).join('|');
  useEffect(() => {
    if (settingUpKeys.length === 0) return;
    const timer = window.setInterval(() => {
      for (const ref of settingUpKeys) void refreshMember(ref);
    }, 1_000);
    return () => window.clearInterval(timer);
    // settingUpSignature captures the set of polled members as a string so
    // the interval only re-arms when that set actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingUpSignature, refreshMember]);

  return {
    loading: !commandLoaded || details === null,
    manifestError,
    commandProfiles,
    members,
    manifestProfiles,
    refreshCommand: refreshCommandStore,
    refreshManifest,
    refreshMember,
    applyMemberDetail,
  };
}
