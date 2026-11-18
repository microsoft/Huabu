// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { AgentProfileError } from '@agenetes/agent-profile';
import { getAgentProfileRegistry } from '@agenetes/agentlet-host';

import type { AgentProfile } from '@agenetes/agent-profile';
import type { CustomData, JsonValue } from '@huabu/shared';

const CUSTOM_DATA_KEY = 'sessionPreferences';

export interface AcpProfileSessionPreferences {
  model?: string;
  thoughtLevel?: string;
}

function parsePreferences(
  value: JsonValue | undefined,
): AcpProfileSessionPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return {
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
    ...(typeof value.thoughtLevel === 'string'
      ? { thoughtLevel: value.thoughtLevel }
      : {}),
  };
}

/** The session preferences remembered on `profile`. */
export function profileSessionPreferences(
  profile: AgentProfile | undefined,
): AcpProfileSessionPreferences {
  if (profile?.launch.kind !== 'acp-harness') return {};
  return parsePreferences(profile.customData?.[CUSTOM_DATA_KEY]);
}

/** {@link profileSessionPreferences} for a Profile read from the registry. */
export async function getProfileSessionPreferences(
  profileId: string,
): Promise<AcpProfileSessionPreferences> {
  return profileSessionPreferences(
    await getAgentProfileRegistry()?.getProfile(profileId),
  );
}

/**
 * Remember a session preference on the Profile it was chosen for, unless the
 * Profile has since been relaunched under another execution revision.
 *
 * The patch is fenced on the revision it was merged against, so a concurrent
 * preference or launch edit is never overwritten with a stale copy: on a
 * conflict the Profile is read again, its execution revision rechecked, and
 * the preference merged into what is now stored.
 */
export async function rememberProfileSessionPreference(
  profileId: string,
  key: keyof AcpProfileSessionPreferences,
  value: string,
  executionRevision = 0,
): Promise<void> {
  const registry = getAgentProfileRegistry();
  if (!registry) return;
  for (;;) {
    const profile = await registry.getProfile(profileId);
    if (
      !profile ||
      profile.launch.kind !== 'acp-harness' ||
      (profile.executionRevision ?? 0) !== executionRevision
    )
      return;
    const customData: CustomData = { ...profile.customData };
    customData[CUSTOM_DATA_KEY] = {
      ...parsePreferences(customData[CUSTOM_DATA_KEY]),
      [key]: value,
    };
    try {
      await registry.patchProfile(profileId, {
        customData,
        expectedRevision: profile.revision ?? 0,
      });
      return;
    } catch (error) {
      // Another edit committed first; every retry follows one that did.
      if (
        !(
          error instanceof AgentProfileError &&
          error.code === 'profile_conflict'
        )
      )
        throw error;
    }
  }
}

export async function rememberProfileConfigPreference(
  profileId: string,
  configOptions: readonly unknown[],
  optionId: string,
  value: string | boolean,
  executionRevision = 0,
): Promise<void> {
  if (typeof value !== 'string') return;
  const option = configOptions.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return String((candidate as { id?: unknown }).id ?? '') === optionId;
  }) as { category?: unknown } | undefined;
  const category = String(option?.category ?? '')
    .trim()
    .toLowerCase();
  if (category === 'model') {
    await rememberProfileSessionPreference(
      profileId,
      'model',
      value,
      executionRevision,
    );
  } else if (category === 'thought_level') {
    await rememberProfileSessionPreference(
      profileId,
      'thoughtLevel',
      value,
      executionRevision,
    );
  }
}
