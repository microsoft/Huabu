// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  Person,
  SetPersonMemberRequest,
  SetPersonWorkspaceRoleRequest,
  WorkspaceRole,
} from '@huabu/shared';

export type { Person, WorkspaceRole };

/** Everyone the identity provider knows, for an administrator. */
export async function listPeople(): Promise<Person[]> {
  return apiFetch<Person[]>(routes.people, {
    fallbackMessage: 'Failed to list people',
  });
}

/** Admit someone to Huabu, or revoke their access. */
export async function setPersonMember(
  principalId: string,
  member: boolean,
): Promise<void> {
  const body: SetPersonMemberRequest = { member };
  await apiFetch<void>(routes.personMember(principalId), {
    method: 'PUT',
    json: body,
    fallbackMessage: 'Failed to change access',
  });
}

/** Give someone a role on a Workspace; `null` removes it. */
export async function setPersonWorkspaceRole(
  principalId: string,
  workspaceId: string,
  role: WorkspaceRole | null,
): Promise<void> {
  const body: SetPersonWorkspaceRoleRequest = { role };
  await apiFetch<void>(routes.personWorkspace(principalId, workspaceId), {
    method: 'PUT',
    json: body,
    fallbackMessage: 'Failed to change the Workspace role',
  });
}
