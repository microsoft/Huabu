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

/** Durable thread-table entry supplied to a driver at create time. */
export interface AgentDurableRecord<TSpec = unknown> {
  readonly spec: TSpec;
  readonly state: AgentStateSnapshot;
}

/** Driver-agnostic durable source material for recovery or forking. */
export interface AgentDurableInput<TSpec = unknown> {
  readonly source: ThreadIdentity;
  readonly record: AgentDurableRecord<TSpec>;
  readonly turns: readonly ObservedAgentTurn[];
}

/** A history-loading operation a driver wants Agenetes to authorize. */
export interface HistoryLoadAuthorizationInput {
  readonly mode: 'recover' | 'fork';
  readonly turns: readonly ObservedAgentTurn[];
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

/** Create-time context separating durable source data from target spec. */
export interface AgentCreateContext<TSpec = unknown> {
  readonly durableInput?: AgentDurableInput<TSpec>;
  readonly recovery: AgentRecoveryContext;
}

export type AgentRealizationMode = 'fresh' | 'recover' | 'fork';

/** Classify realization by comparing source and target durable identity. */
export function classifyAgentRealization(
  target: ThreadIdentity,
  durableInput?: AgentDurableInput,
): AgentRealizationMode {
  if (!durableInput) return 'fresh';
  return durableInput.source.threadId === target.threadId &&
    durableInput.source.namespace.name === target.namespace.name
    ? 'recover'
    : 'fork';
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
