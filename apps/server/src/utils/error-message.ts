// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Return the deepest non-empty message from an Error cause chain.
 *
 * Wrapper errors often describe only the failed subsystem, while their cause
 * contains the actionable configuration or provider message. Cycles are
 * guarded because Error.cause is caller-controlled.
 */
export function getRootErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;

  let current = error;
  let message = current.message.trim() || fallback;
  const seen = new Set<Error>();

  while (!seen.has(current)) {
    seen.add(current);
    const currentMessage = current.message.trim();
    if (currentMessage) message = currentMessage;
    const cause =
      'cause' in current
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
    if (!(cause instanceof Error)) break;
    current = cause;
  }

  return message;
}
