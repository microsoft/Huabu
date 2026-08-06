export type AgenetesErrorCode =
  | 'invalid_workload'
  | 'unknown_driver_kind'
  | 'unsupported_workload_type'
  | 'invalid_driver_spec'
  | 'invalid_driver_state'
  | 'invalid_driver_definition'
  | 'invalid_persisted_record';

/** Structured synchronous failure surfaced by the Agenetes control plane. */
export class AgenetesError extends Error {
  constructor(
    readonly code: AgenetesErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgenetesError';
  }
}
