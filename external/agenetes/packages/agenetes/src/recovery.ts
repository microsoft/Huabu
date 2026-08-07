import type { AgentTurn } from '@agenetes/protocol';
import type {
  AgentRecoveryContext,
  HistoryLoadAuthorizationInput,
} from '@agenetes/runtime';

/** Context supplied to a host when an oversized history needs approval. */
export interface RecoveryConfirmationContext extends HistoryLoadAuthorizationInput {
  readonly estimatedSize: number;
  readonly safeLimit: number;
}

/** Instance-wide policy governing driver-requested history loading. */
export interface AutoRecoverPolicy {
  readonly enabled: boolean;
  readonly safeHistoryLoadLimit: number;
  readonly onThresholdExceeded: 'confirm' | 'deny';
  readonly confirm?: (context: RecoveryConfirmationContext) => Promise<boolean>;
}

/** Default recovery policy used when a host supplies no override. */
export const DEFAULT_AUTO_RECOVER_POLICY: AutoRecoverPolicy = Object.freeze({
  enabled: true,
  safeHistoryLoadLimit: 10_000,
  onThresholdExceeded: 'deny',
});

/** Cheap token-like estimate used only for history-load admission. */
export function estimateHistoryLoadSize(turns: readonly AgentTurn[]): number {
  const textualBytes = turns.reduce((total, turn) => {
    const serialized = JSON.stringify(turn) ?? '';
    return total + Buffer.byteLength(serialized, 'utf8');
  }, 0);
  return Math.ceil(textualBytes / 4.5);
}

/** Build the recovery service passed to every driver create context. */
export function createAgentRecoveryContext(
  policy: AutoRecoverPolicy,
): AgentRecoveryContext {
  if (
    !Number.isFinite(policy.safeHistoryLoadLimit) ||
    policy.safeHistoryLoadLimit < 0
  ) {
    throw new RangeError('safeHistoryLoadLimit must be a non-negative number');
  }

  return {
    async authorizeHistoryLoad(input) {
      const estimatedSize =
        input.estimatedSize ?? estimateHistoryLoadSize(input.turns);
      const denied = (
        code:
          | 'auto_recover_disabled'
          | 'safe_limit_exceeded'
          | 'confirmation_unavailable'
          | 'confirmation_declined',
      ) => ({
        allowed: false as const,
        code,
        estimatedSize,
        safeLimit: policy.safeHistoryLoadLimit,
      });

      if (input.mode === 'recover' && !policy.enabled) {
        return denied('auto_recover_disabled');
      }
      if (estimatedSize <= policy.safeHistoryLoadLimit) {
        return { allowed: true, estimatedSize };
      }
      if (policy.onThresholdExceeded === 'deny') {
        return denied('safe_limit_exceeded');
      }
      if (!policy.confirm) {
        return denied('confirmation_unavailable');
      }
      return (await policy.confirm({
        ...input,
        estimatedSize,
        safeLimit: policy.safeHistoryLoadLimit,
      }))
        ? { allowed: true, estimatedSize }
        : denied('confirmation_declined');
    },
  };
}
