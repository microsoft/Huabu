export type AgentTeamErrorCode =
  | 'alias_conflict'
  | 'config_field_not_found'
  | 'config_incomplete'
  | 'deployment_busy'
  | 'deployment_not_found'
  | 'invalid_alias'
  | 'invalid_config_value'
  | 'invalid_root'
  | 'invalid_setup_transition'
  | 'invalid_working_directory'
  | 'member_missing'
  | 'member_not_found'
  | 'root_not_found'
  | 'root_scan_stale'
  | 'setup_cancel_rejected'
  | 'unsupported_harness';

export class AgentTeamError extends Error {
  constructor(
    readonly code: AgentTeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentTeamError';
  }
}
