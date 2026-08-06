export type AgentTeamErrorCode =
  | 'config_field_not_found'
  | 'config_incomplete'
  | 'invalid_agentlet'
  | 'invalid_alias'
  | 'invalid_command'
  | 'invalid_config_value'
  | 'invalid_profile_kind'
  | 'invalid_profile_patch'
  | 'invalid_root'
  | 'invalid_setup_transition'
  | 'invalid_working_directory'
  | 'member_missing'
  | 'member_not_found'
  | 'profile_busy'
  | 'profile_conflict'
  | 'profile_not_found'
  | 'root_not_found'
  | 'root_scan_stale'
  | 'setup_cancel_rejected'
  | 'unsupported_harness'
  | 'workspace_invalid';

export class AgentTeamError extends Error {
  constructor(
    readonly code: AgentTeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentTeamError';
  }
}
