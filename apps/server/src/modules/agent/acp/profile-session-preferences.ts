// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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

export async function rememberProfileSessionPreference(
  profileId: string,
  key: keyof AcpProfileSessionPreferences,
  value: string,
  executionRevision = 0,
): Promise<void> {
  const registry = getAgentProfileRegistry();
  const profile = await registry?.getProfile(profileId);
  if (!registry || !profile) return;
  if (
    profile.launch.kind !== 'acp-harness' ||
    (profile.executionRevision ?? 0) !== executionRevision
  )
    return;

  const customData: CustomData = { ...profile.customData };
  customData[CUSTOM_DATA_KEY] = {
    ...parsePreferences(customData[CUSTOM_DATA_KEY]),
    [key]: value,
  };
  await registry.patchProfile(profileId, { customData });
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
