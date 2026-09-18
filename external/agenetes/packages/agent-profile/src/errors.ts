export type AgentProfileErrorCode =
  | 'invalid_agentlet'
  | 'invalid_alias'
  | 'invalid_command'
  | 'invalid_profile_kind'
  | 'invalid_profile_patch'
  | 'invalid_working_directory'
  | 'invalid_registry'
  | 'profile_conflict'
  | 'profile_not_found';

export class AgentProfileError extends Error {
  constructor(
    readonly code: AgentProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentProfileError';
  }
}
