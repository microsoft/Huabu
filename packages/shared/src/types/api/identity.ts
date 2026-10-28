// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

/** Huabu's principal projection; credentials and provider claims stay server-side. */
export const identityPrincipalSchema = z.object({
  principalId: z.string().min(1),
  kind: z.enum(['user', 'bot', 'system']),
  displayName: z.string().optional(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type IdentityPrincipal = z.infer<typeof identityPrincipalSchema>;

export const identityResponseSchema = z.object({
  provider: z.enum(['local', 'bubble']),
  principal: identityPrincipalSchema,
  /** May use Huabu at all. */
  member: z.boolean(),
  /** May also change settings, credentials and agent configuration. */
  owner: z.boolean(),
});
export type IdentityResponse = z.infer<typeof identityResponseSchema>;

/** A Workspace role a person administration grant can give. */
export const workspaceRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

/** One principal, as `GET /api/people` lists them for an administrator. */
export const personSchema = z.object({
  principal: identityPrincipalSchema,
  /** Holds system `member`: admitted to Huabu. */
  member: z.boolean(),
  /** Holds system `owner`: administers the deployment. */
  admin: z.boolean(),
  /** Workspace roles held directly, one entry per Workspace. */
  workspaces: z.array(
    z.object({ workspaceId: z.string().min(1), role: workspaceRoleSchema }),
  ),
});
export type Person = z.infer<typeof personSchema>;

/** `PUT /api/people/:principalId/member`. */
export const setPersonMemberSchema = z.object({ member: z.boolean() });
export type SetPersonMemberRequest = z.infer<typeof setPersonMemberSchema>;

/** `PUT /api/people/:principalId/workspaces/:workspaceId`; `null` removes it. */
export const setPersonWorkspaceRoleSchema = z.object({
  role: workspaceRoleSchema.nullable(),
});
export type SetPersonWorkspaceRoleRequest = z.infer<
  typeof setPersonWorkspaceRoleSchema
>;
