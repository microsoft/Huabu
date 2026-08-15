// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export type ViteAccessDecision =
  | 'allow'
  | 'authentication-required'
  | 'remote-auth-configuration-required';

function isLoopbackPeer(peer: string | undefined): boolean {
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}

export function decideViteAccess(input: {
  peer: string | undefined;
  expectedAuthorization: string | null;
  receivedAuthorization: string | undefined;
}): ViteAccessDecision {
  if (
    input.expectedAuthorization &&
    input.receivedAuthorization === input.expectedAuthorization
  ) {
    return 'allow';
  }
  if (!input.expectedAuthorization && isLoopbackPeer(input.peer)) {
    return 'allow';
  }
  return input.expectedAuthorization
    ? 'authentication-required'
    : 'remote-auth-configuration-required';
}
