import type {
  AgentStateSnapshot,
  Namespace,
  ObservedAgentTurn,
} from '@agenetes/protocol';

/** Durable identity of a source thread used to realize a handle. */
export interface ThreadIdentity {
  readonly namespace: Namespace;
  readonly threadId: string;
}

/** Same-thread durable input used only for recovery. */
export interface AgentRecoveryInput<TDriverState = unknown> {
  readonly state: AgentStateSnapshot<TDriverState>;
  readonly turns: readonly ObservedAgentTurn[];
}

/** Cross-thread durable input used only for fork realization. */
export interface AgentForkInput {
  readonly source: ThreadIdentity;
  readonly turns: readonly ObservedAgentTurn[];
}

/** A history-loading operation a driver wants Agenetes to authorize. */
export interface HistoryLoadAuthorizationInput {
  readonly mode: 'recover' | 'fork';
  readonly turns: readonly ObservedAgentTurn[];
  /**
   * Size of the payload the driver will actually replay, in the same unit as
   * the policy limit. A driver that lowers turns into a different replay form
   * (native messages, projected text) must report it here; otherwise Agenetes
   * falls back to estimating the durable turns, which only matches drivers
   * that replay them verbatim.
   */
  readonly estimatedSize?: number;
}

/** Structured result of the instance-level history-load policy. */
export type HistoryLoadAuthorization =
  | {
      readonly allowed: true;
      readonly estimatedSize: number;
    }
  | {
      readonly allowed: false;
      readonly code:
        | 'auto_recover_disabled'
        | 'safe_limit_exceeded'
        | 'confirmation_unavailable'
        | 'confirmation_declined';
      readonly estimatedSize: number;
      readonly safeLimit: number;
    };

/** Instance-provided recovery services available to a driver-owned handle. */
export interface AgentRecoveryContext {
  authorizeHistoryLoad(
    input: HistoryLoadAuthorizationInput,
  ): Promise<HistoryLoadAuthorization>;
}

/**
 * Create-time context. Recovery receives same-driver prior state; fork
 * receives source identity and history only, never source spec or state.
 */
export interface AgentCreateContext<TDriverState = unknown> {
  readonly recoveryInput?: AgentRecoveryInput<TDriverState>;
  readonly forkInput?: AgentForkInput;
  readonly recovery: AgentRecoveryContext;
}

type HistoryLoadDenial = Extract<
  HistoryLoadAuthorization,
  { readonly allowed: false }
>;

/** Explicit error surfaced by a driver when instance policy denies history. */
export class HistoryLoadDeniedError extends Error {
  readonly code: HistoryLoadDenial['code'];
  readonly estimatedSize: number;
  readonly safeLimit: number;

  constructor(denial: HistoryLoadDenial) {
    super(
      `history load denied (${denial.code}): estimated ${denial.estimatedSize}, safe limit ${denial.safeLimit}`,
    );
    this.name = 'HistoryLoadDeniedError';
    this.code = denial.code;
    this.estimatedSize = denial.estimatedSize;
    this.safeLimit = denial.safeLimit;
  }
}
