// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  probeAcpCapabilities,
  resolveInitialPreferenceSelections,
} from '@agenetes/acp-driver';
import {
  getAgentProfileRegistry,
  resolveConnectedAgentletId,
} from '@agenetes/agentlet-host';

import {
  getProfileSchemaCache,
  mergeProfileSchemaCache,
} from './profile-schema-cache.js';
import { profileSessionPreferences } from './profile-session-preferences.js';
import {
  profileSnapshot,
  recipeFromProfileSnapshot,
} from './profile-snapshot.js';

import type { AcpProfileSchemaCacheEntry } from './profile-schema-cache.js';
import type { AgentProfile } from '@agenetes/agent-profile';
import type {
  AcpProfileCapabilitiesResponse,
  AcpSessionMetaSnapshot,
} from '@huabu/shared';
import type { FastifyBaseLogger } from 'fastify';

export class ProfileCapabilitiesError extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Session metadata for a conversation of this Profile that has no session yet.
 *
 * The catalogue is the Profile's last observation, whose current values
 * belong to whichever thread reported last. A new session starts from the
 * Profile's remembered preferences instead, so they are carried as selections:
 * otherwise the selectors would name one model and the first turn would run
 * on another.
 */
export function profileSessionMetaSnapshot(
  profile: AgentProfile,
  cache: AcpProfileSchemaCacheEntry | null,
): AcpSessionMetaSnapshot {
  const availableModels = cache?.availableModels ?? [];
  const configOptions = cache?.configOptions ?? [];
  return {
    availableModes: cache?.availableModes ?? [],
    currentModeId: cache?.currentModeId ?? null,
    availableModels,
    currentModelId: cache?.currentModelId ?? null,
    configOptions,
    selections: resolveInitialPreferenceSelections(
      profileSessionPreferences(profile),
      { configOptions, availableModels },
    ),
    sessionInfo: null,
    usage: null,
    updatedAt: cache?.metaUpdatedAt ?? 0,
  };
}

export function projectProfileCapabilities(
  profile: AgentProfile,
  cache: AcpProfileSchemaCacheEntry | null,
): AcpProfileCapabilitiesResponse {
  const observed = Boolean(cache && (cache.metaUpdatedAt ?? 0) > 0);
  return {
    source: observed ? 'profile' : 'none',
    availableCommands: cache?.availableCommands ?? [],
    commandsUpdatedAt: cache?.commandsUpdatedAt ?? 0,
    sessionMeta: profileSessionMetaSnapshot(profile, cache),
  };
}

/**
 * The Profile's observed catalogue, or `null` when nothing usable is cached.
 *
 * An observation recorded under another execution revision describes a
 * launch the Profile no longer has, so it is treated as absent.
 */
export function readProfileObservation(
  profile: AgentProfile,
): AcpProfileSchemaCacheEntry | null {
  const cache = getProfileSchemaCache(profile.id);
  if (!cache) return null;
  return cache.executionRevision !== undefined &&
    cache.executionRevision !== (profile.executionRevision ?? 0)
    ? null
    : cache;
}

/** A Profile the caller may use, or a 404. */
async function requireProfile(profileId: string): Promise<AgentProfile> {
  const profile = await getAgentProfileRegistry()?.getProfile(profileId);
  if (!profile) {
    throw new ProfileCapabilitiesError(
      404,
      'profile_not_found',
      'Agent Profile is unavailable',
    );
  }
  return profile;
}

function observedCapabilities(
  profile: AgentProfile,
): AcpProfileCapabilitiesResponse {
  return projectProfileCapabilities(profile, readProfileObservation(profile));
}

export async function readProfileCapabilities(
  profileId: string,
): Promise<AcpProfileCapabilitiesResponse> {
  return observedCapabilities(await requireProfile(profileId));
}

const discoveries = new Map<string, Promise<AcpProfileCapabilitiesResponse>>();

export async function discoverProfileCapabilities(
  profileId: string,
  logger: FastifyBaseLogger,
): Promise<AcpProfileCapabilitiesResponse> {
  const read = await requireProfile(profileId);
  const cached = observedCapabilities(read);
  if (cached.source === 'profile') return cached;
  const profile = profileSnapshot(read);
  const agentletId = resolveConnectedAgentletId(profile.agentletId);
  if (!agentletId) {
    throw new ProfileCapabilitiesError(
      503,
      'placement_unavailable',
      'The selected Agentlet is not connected',
    );
  }
  const key = JSON.stringify([
    profileId,
    profile.executionRevision,
    agentletId,
  ]);
  let operation = discoveries.get(key);
  if (!operation) {
    operation = (async () => {
      const alias = read.alias;
      const observation = await probeAcpCapabilities({
        agentletId,
        binding: { profileId, alias },
        profileExecutionRevision: profile.executionRevision,
        recipe: recipeFromProfileSnapshot(profile, alias),
        logger,
      });
      const current = await getAgentProfileRegistry()?.getProfile(profileId);
      if (
        !current ||
        (current.executionRevision ?? 0) !== profile.executionRevision
      ) {
        throw new ProfileCapabilitiesError(
          409,
          'profile_changed',
          'Agent Profile changed during capability discovery; retry',
        );
      }
      // A live user session may have published a newer catalogue during the probe.
      const latest = observedCapabilities(current);
      if (latest.source === 'profile') return latest;
      const entry = {
        ...observation,
        executionRevision: profile.executionRevision,
      };
      mergeProfileSchemaCache(profileId, entry);
      return projectProfileCapabilities(current, entry);
    })();
    discoveries.set(key, operation);
  }
  try {
    return await operation;
  } finally {
    if (discoveries.get(key) === operation) discoveries.delete(key);
  }
}
