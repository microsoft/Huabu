/**
 * Execution-layer types for command batching, validation, undo, and tracing.
 */

import type { CanvasCommand } from './command.js';

export type CanvasExecutionSource = 'ui' | 'agent' | 'system';

/**
 * One logical batch of commands that should validate and commit together.
 */
export interface CanvasExecution {
  /** Defaults to `'ui'` when omitted. */
  source?: CanvasExecutionSource;
  commands: CanvasCommand[];
}

export type CanvasCommandFailureReason =
  | 'no-op'
  | 'not-found'
  | 'invalid-parent'
  | 'invalid-target'
  | 'invalid-scope'
  | 'cycle'
  | 'duplicate-id';

export interface CanvasCommandResult {
  command: CanvasCommand;
  applied: boolean;
  reason?: CanvasCommandFailureReason;
}
