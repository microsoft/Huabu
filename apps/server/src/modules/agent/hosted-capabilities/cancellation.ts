// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared provider-deadline + cancellation helper for hosted-capability
 * services.
 *
 * Every hosted capability enforces its own bounded provider deadline
 * server-side (docs/proposals/agent-resource-registry.md §13); native
 * tool calls never pass a caller signal today, so only the internal
 * timer fires in practice. An RFS invocation can also carry a
 * caller-supplied `AbortSignal` (e.g. the external agent process
 * exiting mid-call, or the session-scoped grant expiring); this helper
 * combines both without adding an invocation parameter to the native
 * tool path or changing native behavior.
 */
export interface TimeoutControllerOptions {
  /** Bounded provider deadline in milliseconds. */
  timeoutMs: number;
  /** Optional caller-supplied cancellation signal (unused by native tool adapters today). */
  signal?: AbortSignal;
}

export interface TimeoutController {
  /** Combined signal to pass to the outbound provider call. */
  readonly signal: AbortSignal;
  /** True once the internal deadline (not the caller signal) has fired. */
  didTimeout(): boolean;
  /** Release the internal timer; call in a `finally` block. */
  clear(): void;
}

export function createTimeoutController(
  opts: TimeoutControllerOptions,
): TimeoutController {
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, opts.timeoutMs);
  // Node/undici timers otherwise hold the event loop open; a pending
  // hosted-capability call must never block process shutdown.
  timer.unref?.();

  const signal = opts.signal
    ? AbortSignal.any([deadline.signal, opts.signal])
    : deadline.signal;

  return {
    signal,
    didTimeout: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}

/**
 * Classify an abort as `'timeout'` (the service's own deadline fired)
 * or `'cancelled'` (the caller's signal fired first). Defaults to
 * `'timeout'` when neither signal is distinguishable, which matches
 * today's native path where no caller signal is ever supplied.
 */
export function classifyAbort(
  controller: TimeoutController,
  callerSignal?: AbortSignal,
): 'timeout' | 'cancelled' {
  if (controller.didTimeout()) return 'timeout';
  if (callerSignal?.aborted) return 'cancelled';
  return 'timeout';
}
