// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared invocation-option contract every hosted-capability service
 * function accepts, independent of the capability-specific input and
 * result shapes owned by each `*.service.ts` module.
 */
export interface HostedCapabilityInvocationOptions {
  /**
   * Caller cancellation signal. Native tool adapters never supply
   * this today — only the service's own bounded provider deadline
   * applies. The RFS invocation adapter passes a signal tied
   * to the caller's session-scoped grant or connection lifetime.
   */
  signal?: AbortSignal;
}
