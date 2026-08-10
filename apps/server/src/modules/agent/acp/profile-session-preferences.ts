// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getAgentTeamRegistry } from '@agenetes/agentlet-host';

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

export function getProfileSessionPreferences(
  profileId: string,
): AcpProfileSessionPreferences {
  const profile = getAgentTeamRegistry()?.getProfile(profileId);
  return parsePreferences(profile?.customData?.[CUSTOM_DATA_KEY]);
}

export function rememberProfileSessionPreference(
  profileId: string,
  key: keyof AcpProfileSessionPreferences,
  value: string,
): void {
  const registry = getAgentTeamRegistry();
  const profile = registry?.getProfile(profileId);
  if (!registry || !profile) return;

  const customData: CustomData = { ...profile.customData };
  customData[CUSTOM_DATA_KEY] = {
    ...parsePreferences(customData[CUSTOM_DATA_KEY]),
    [key]: value,
  };
  registry.patchProfile(profileId, { customData });
}

export function rememberProfileConfigPreference(
  profileId: string,
  configOptions: readonly unknown[],
  optionId: string,
  value: string | boolean,
): void {
  if (typeof value !== 'string') return;
  const option = configOptions.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    return String((candidate as { id?: unknown }).id ?? '') === optionId;
  }) as { category?: unknown } | undefined;
  const category = String(option?.category ?? '')
    .trim()
    .toLowerCase();
  if (category === 'model') {
    rememberProfileSessionPreference(profileId, 'model', value);
  } else if (category === 'thought_level') {
    rememberProfileSessionPreference(profileId, 'thoughtLevel', value);
  }
}
