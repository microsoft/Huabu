// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { apiFetch } from './_client';
import { routes } from './_routes';

import type {
  AdmissionSettings,
  Person,
  SetAdmissionRequest,
  SetPersonMemberRequest,
  SetPersonWorkspaceRoleRequest,
  WorkspaceRole,
} from '@huabu/shared';

export type { AdmissionSettings, Person, WorkspaceRole };

/** Everyone the identity provider knows, for an administrator. */
export async function listPeople(): Promise<Person[]> {
  return apiFetch<Person[]>(routes.people, {
    fallbackMessage: 'Failed to list people',
  });
}

/** Whether people who sign in are admitted automatically, and through which providers. */
export async function getAdmission(): Promise<AdmissionSettings> {
  return apiFetch<AdmissionSettings>(routes.peopleAdmission, {
    fallbackMessage: 'Failed to load admission settings',
  });
}

/** Turn automatic admission on or off. Turning it off revokes nobody. */
export async function setAutomaticAdmission(
  automatic: boolean,
): Promise<AdmissionSettings> {
  const body: SetAdmissionRequest = { automatic };
  return apiFetch<AdmissionSettings>(routes.peopleAdmission, {
    method: 'PUT',
    json: body,
    fallbackMessage: 'Failed to change automatic admission',
  });
}

/** Admit someone to Huabu, or revoke their access; revoking keeps automatic admission from readmitting them. */
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

/** Revoke someone's device connection credentials and disconnect their devices. */
export async function resetPersonDeviceCredentials(
  principalId: string,
): Promise<void> {
  await apiFetch<void>(routes.personAgentCredentialsReset(principalId), {
    method: 'POST',
    fallbackMessage: 'Failed to reset device credentials',
  });
}
