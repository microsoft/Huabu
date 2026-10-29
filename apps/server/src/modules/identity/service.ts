// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { IdentityPrincipal, IdentityResponse } from '@huabu/shared';

/** Supplied by a trusted transport, never copied from a request body. */
export interface IdentityCredentials {
  authorization?: string;
  loopback: boolean;
  /** Other request headers, for verifiers that read more than Authorization. */
  header?: (name: string) => string | undefined;
}

export interface ResolvedIdentity {
  principal: IdentityPrincipal;
  /** May use Huabu; every owner is a member. */
  member: boolean;
  /** May also change settings, credentials and agent configuration. */
  owner: boolean;
  /** What this caller may do with individual Workspaces and Spaces. */
  access: ResourceAccess;
}

/** A Huabu resource whose access the identity provider decides; `id` is Huabu's. */
export interface HuabuResource {
  type: 'workspace' | 'space';
  id: string;
}

export interface ResourceAccess {
  can(level: 'read' | 'write', resource: HuabuResource): Promise<boolean>;
  /** Make the caller the owner of a resource it has just created. */
  claim(resource: HuabuResource): Promise<void>;
}

/**
 * For callers outside per-resource authorization: the local owner, and the
 * machine credential that already holds the whole RFS surface.
 */
export const UNRESTRICTED_ACCESS: ResourceAccess = {
  can: async () => true,
  claim: async () => {},
};

/** Where Huabu's resources sit, as the provider needs to know to authorize them. */
export interface ResourceDirectory {
  workspaceExists(workspaceId: string): Promise<boolean>;
  /**
   * The Space's parent Space, or its Workspace when it is a root; `null` when
   * there is no such Space.
   */
  spaceParent(canvasId: string): Promise<HuabuResource | null>;
}

/** Resolve afresh for each request so revocation is not hidden by a host cache. */
export interface IdentityService {
  readonly provider: IdentityResponse['provider'];
  readonly challenge: string;
  /**
   * Admits callers without any credential, as local mode does without Basic
   * Auth; the RFS surface then still requires the machine credential.
   */
  readonly credentialFree?: boolean;
  authenticate(
    credentials: IdentityCredentials,
  ): Promise<ResolvedIdentity | null>;
  /**
   * Whether the machine credential also carries owner authority. Local mode
   * keeps its loopback rule for it; without this the machine is never an owner.
   */
  machineOwner?(loopback: boolean): boolean;
}

export class IdentityError extends Error {
  constructor(
    readonly statusCode: 403 | 503,
    readonly code: 'IDENTITY_FORBIDDEN' | 'IDENTITY_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}
