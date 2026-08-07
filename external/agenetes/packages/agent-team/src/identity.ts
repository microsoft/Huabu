import type { AgentTeamMember, AgentTeamRootRef } from './types.js';

export function agentTeamRootKey(root: AgentTeamRootRef): string {
  return JSON.stringify([root.machine, root.path]);
}

export function agentTeamMemberKey(
  member: Pick<AgentTeamMember, 'machine' | 'manifestPath'>,
): string {
  return JSON.stringify([member.machine, member.manifestPath]);
}

export function sameAgentTeamRoot(
  left: AgentTeamRootRef,
  right: AgentTeamRootRef,
): boolean {
  return agentTeamRootKey(left) === agentTeamRootKey(right);
}
