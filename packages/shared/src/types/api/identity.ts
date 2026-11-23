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
  /** Administers the deployment: its settings, agents and people. */
  owner: z.boolean(),
  /** Signing out should also end the identity provider's own session. */
  providerSignOut: z.boolean().optional(),
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
  /**
   * Their `member` grant was made by automatic admission when they signed in,
   * not by an administrator. Always `false` while `member` is `false`.
   */
  joinedAutomatically: z.boolean(),
  /**
   * An administrator removed their access. Automatic admission never readmits
   * them; an administrator turning their access back on clears this. Always
   * `false` while `member` is `true`. `null` when the admission record cannot
   * be read, so whether a person without access was removed is unknown.
   */
  blocked: z.boolean().nullable(),
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

/**
 * A sign-in provider that automatic admission can admit people from: an
 * interactive authenticator configured in `HUABU_BUBBLE_AUTH`. `entra` admits
 * only accounts in the tenants its entries name (one per entry, and any number
 * of entries); `auth0` admits any account that can sign in through that Auth0
 * tenant's connections, but not an application's client-credentials token in
 * Auth0's default access-token profile, which marks it with `gty`. Under
 * Auth0's RFC 9068 profile an application's token carries no such mark and is
 * admitted like a person's; `docs/architecture/deployment-security.md` warns
 * operators about it. Local tokens and the master key are never admitted
 * automatically.
 */
export const admissionProviderSchema = z.enum(['entra', 'auth0']);
export type AdmissionProvider = z.infer<typeof admissionProviderSchema>;

/**
 * `GET /api/people/admission`, and the answer to a change: how a Bubble
 * deployment admits people who sign in. An administrator's alone.
 */
export const admissionSettingsSchema = z.object({
  /**
   * When `true`, a person who signs in through one of `providers` with no
   * system grant and no block gets an ordinary system `member` grant (and so a
   * personal Workspace), never ownership or a Workspace role. When `false`
   * (the default), an administrator admits each person in People. Turning it
   * off revokes nobody.
   */
  automatic: z.boolean(),
  /**
   * The configured sign-in providers automatic admission applies to, each
   * once, in {@link admissionProviderSchema} order; empty when none is
   * configured, in which case turning it on admits nobody.
   */
  providers: z.array(admissionProviderSchema),
});
export type AdmissionSettings = z.infer<typeof admissionSettingsSchema>;

/** `PUT /api/people/admission`. */
export const setAdmissionSchema = z.object({ automatic: z.boolean() });
export type SetAdmissionRequest = z.infer<typeof setAdmissionSchema>;
