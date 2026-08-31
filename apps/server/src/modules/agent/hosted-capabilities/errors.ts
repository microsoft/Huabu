// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Stable, sanitized error taxonomy shared by every hosted-capability
 * service invocation path (native tool adapters today; an external RFS
 * invocation adapter — see
 * docs/proposals/agent-resource-registry.md §14).
 *
 * A hosted-capability service never lets a raw provider error, a
 * SecretStore value, or an internal stack trace escape — it maps every
 * failure into one of these codes plus an already-sanitized message.
 *
 * `HostedCapabilityError extends Error`, so today's native tool
 * contract (pi-agent-core's `AgentTool.execute` catches a thrown
 * `Error` and surfaces `.message` as `isError: true` tool-result text)
 * keeps working unchanged: handlers can let this error propagate
 * as-is. `.code` is additive metadata the RFS adapter can branch
 * on without any change to native behavior today.
 */
export type HostedCapabilityErrorCode =
  | 'unsupported_version'
  | 'resource_not_found'
  | 'forbidden'
  | 'unavailable'
  | 'invalid_input'
  | 'cancelled'
  | 'timeout'
  | 'quota_exceeded'
  | 'provider_failure'
  | 'internal_error';

export class HostedCapabilityError extends Error {
  readonly code: HostedCapabilityErrorCode;

  constructor(code: HostedCapabilityErrorCode, message: string) {
    super(message);
    this.name = 'HostedCapabilityError';
    this.code = code;
  }
}

export function isHostedCapabilityError(
  err: unknown,
): err is HostedCapabilityError {
  return err instanceof HostedCapabilityError;
}

/**
 * Wrap an unexpected non-`HostedCapabilityError` failure (a bug, an
 * unmapped exception type) into the taxonomy's catch-all code without
 * leaking the original error's message, which may carry internal
 * detail.
 */
export function toInternalError(err: unknown): HostedCapabilityError {
  if (isHostedCapabilityError(err)) return err;
  return new HostedCapabilityError(
    'internal_error',
    'Hosted capability invocation failed unexpectedly.',
  );
}
