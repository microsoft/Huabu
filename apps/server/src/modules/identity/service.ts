// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { WorkspaceScope } from '../workspace/context.js';
import type {
  IdentityPrincipal,
  IdentityResponse,
  Person,
  WorkspaceRole,
} from '@huabu/shared';

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
  /**
   * Administers the deployment (`huabu.admin`): settings, credentials, agent
   * configuration and folder Workspaces. Every Workspace and Space, too.
   */
  owner: boolean;
  /** What this caller may do with individual Workspaces and Spaces. */
  access: ResourceAccess;
}

/** A Huabu resource whose access the identity provider decides; `id` is Huabu's. */
export interface HuabuResource {
  type: 'workspace' | 'space';
  id: string;
}

/**
 * A Space is named by its id alone: it is always the Space of that id in the
 * Workspace the call runs in (`../workspace/context.ts`).
 */
/** `manage`: rename, delete, grant on it; for a Workspace, its memory and Skills. */
export type AccessLevel = 'read' | 'write' | 'manage';

export interface ResourceAccess {
  can(level: AccessLevel, resource: HuabuResource): Promise<boolean>;
  /** Make the caller the owner of a resource it has just created. */
  claim(resource: HuabuResource): Promise<void>;
  /**
   * The Workspaces the caller may enter, or `'all'` for a caller who may
   * enter any registered one.
   */
  workspaces(): Promise<readonly string[] | 'all'>;
}

/**
 * For callers outside per-resource authorization: the local owner, and the
 * machine credential that already holds the whole RFS surface.
 */
export const UNRESTRICTED_ACCESS: ResourceAccess = {
  can: async () => true,
  claim: async () => {},
  workspaces: async () => 'all',
};

/** Where Huabu's resources sit, as the provider needs to know to authorize them. */
export interface ResourceDirectory {
  workspaceExists(workspaceId: string): Promise<boolean>;
  /**
   * The Space's parent Space, or its Workspace when it is a root; `null` when
   * there is no such Space in that Workspace.
   */
  spaceParent(
    workspaceId: string,
    canvasId: string,
  ): Promise<HuabuResource | null>;
  /** The Workspace holding a Space, for migrating grants that named none. */
  workspaceOfSpace(canvasId: string): Promise<string | null>;
  /** A registered Workspace, opened for calls to run in; `null` if none. */
  openWorkspace(workspaceId: string): Promise<WorkspaceScope | null>;
  /** Where a caller who may enter any Workspace lands first. */
  defaultWorkspace(): Promise<WorkspaceScope | null>;
  /** A new Workspace, wherever this backend keeps one, opened. */
  createWorkspace(name: string): Promise<WorkspaceScope>;
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
  /**
   * The Workspace an admitted member's request runs in: their current one.
   * Present when each request runs in its caller's own Workspace (Bubble
   * mode); absent when the process-active Workspace serves everyone (local
   * mode).
   */
  selectWorkspace?(identity: ResolvedIdentity): Promise<WorkspaceScope | null>;
  /** Who may use Huabu and with which Workspace roles; Bubble mode only. */
  readonly people?: PeopleDirectory;
  /** Make a Workspace the caller's current one; `null` when refused. */
  chooseWorkspace?(
    identity: ResolvedIdentity,
    workspaceId: string,
  ): Promise<WorkspaceScope | null>;
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

/**
 * Administering people: admitting them to Huabu and giving them Workspace
 * roles. Only an administrator's routes use it; the provider decides nothing
 * here beyond storing the grants its policy then answers from.
 */
export interface PeopleDirectory {
  list(): Promise<Person[]>;
  /** `false` when there is no such principal. */
  setMember(principalId: string, member: boolean, by: string): Promise<boolean>;
  /** `null` removes every Workspace role they hold there. */
  setWorkspaceRole(
    principalId: string,
    workspaceId: string,
    role: WorkspaceRole | null,
    by: string,
  ): Promise<boolean>;
}
