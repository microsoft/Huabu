import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { AgentProfileError } from './errors.js';
import { parseProfile, parseState } from './store.js';

import type {
  AgentProfile,
  AgentProfileRegistryState,
  AgentProfileRegistryStore,
  AgentProfileSnapshot,
  CreateAcpCommandProfileInput,
  CreateAgentProfileInput,
  PatchAgentProfileInput,
  AgentProfileRegistryChangeHandler,
  AgentProfileRegistryChangeErrorHandler,
} from './types.js';

export function commandProfile(
  input: CreateAcpCommandProfileInput,
  generateId: () => string = randomUUID,
): AgentProfile {
  return parseProfile({
    id: input.id ?? generateId(),
    alias: input.alias,
    agentletId: input.agentletId,
    workingDirPath: input.workingDirPath,
    launch: { kind: 'acp-command', command: input.command },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.customData === undefined ? {} : { customData: input.customData }),
  });
}

export class AgentProfileRegistry {
  private state: AgentProfileRegistryState;
  private readonly subscriptions = new Set<{
    handler: AgentProfileRegistryChangeHandler;
    onError: AgentProfileRegistryChangeErrorHandler;
  }>();
  constructor(
    private readonly store: AgentProfileRegistryStore,
    private readonly generateId: () => string = randomUUID,
  ) {
    this.state = parseState(store.load());
  }
  dispose(): void {
    this.subscriptions.clear();
  }
  onChange(
    handler: AgentProfileRegistryChangeHandler,
    onError: AgentProfileRegistryChangeErrorHandler = () => {},
  ): () => void {
    const subscription = { handler, onError };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }
  getProfile(id: string): AgentProfile | undefined {
    const profile = this.state.profiles.find((entry) => entry.id === id);
    return profile ? structuredClone(profile) : undefined;
  }
  listProfiles(): AgentProfile[] {
    return structuredClone(this.state.profiles);
  }
  listSelectableProfileIds(): string[] {
    return this.state.profiles.map(({ id }) => id);
  }
  snapshotProfile(id: string): AgentProfileSnapshot {
    const { agentletId, workingDirPath, launch } = this.requireProfile(id);
    return { profileId: id, agentletId, workingDirPath, launch };
  }
  createProfile(input: CreateAgentProfileInput): AgentProfile {
    if (input.launchKind !== 'acp-command')
      throw new AgentProfileError(
        'invalid_profile_kind',
        'Only ACP command Profiles are supported',
      );
    const profile = commandProfile(input, this.generateId);
    if (this.getProfile(profile.id))
      throw new AgentProfileError(
        'profile_conflict',
        `Agent Profile already exists: ${profile.id}`,
      );
    this.commit({ profiles: [...this.state.profiles, profile] });
    return structuredClone(profile);
  }
  importCommandProfiles(inputs: CreateAcpCommandProfileInput[]): string[] {
    const profiles = this.listProfiles();
    const imported = inputs.map((input) =>
      commandProfile(input, this.generateId),
    );
    for (const profile of imported) {
      const existing = profiles.find(({ id }) => id === profile.id);
      if (existing && !isDeepStrictEqual(existing, profile))
        throw new AgentProfileError(
          'profile_conflict',
          `Conflicting Agent Profile ID: ${profile.id}`,
        );
      if (!existing) profiles.push(profile);
    }
    if (profiles.length !== this.state.profiles.length)
      this.commit({ profiles });
    return imported.map(({ id }) => id);
  }
  patchProfile(id: string, input: PatchAgentProfileInput): AgentProfile {
    if (
      Object.keys(input).some(
        (key) => !['alias', 'metadata', 'customData'].includes(key),
      )
    )
      throw new AgentProfileError(
        'invalid_profile_patch',
        'Profile launch identity is immutable',
      );
    const next = this.requireProfile(id);
    if (input.alias !== undefined) next.alias = input.alias;
    if (input.metadata === null) delete next.metadata;
    else if (input.metadata !== undefined) next.metadata = input.metadata;
    if (input.customData === null) delete next.customData;
    else if (input.customData !== undefined) next.customData = input.customData;
    const profile = parseProfile(next);
    this.commit({
      profiles: this.state.profiles.map((entry) =>
        entry.id === id ? profile : entry,
      ),
    });
    return structuredClone(profile);
  }
  deleteProfile(id: string): boolean {
    const profiles = this.state.profiles.filter((profile) => profile.id !== id);
    if (profiles.length === this.state.profiles.length) return false;
    this.commit({ profiles });
    return true;
  }
  private requireProfile(id: string): AgentProfile {
    const profile = this.getProfile(id);
    if (!profile)
      throw new AgentProfileError(
        'profile_not_found',
        `Agent Profile not found: ${id}`,
      );
    return profile;
  }
  private commit(state: AgentProfileRegistryState): void {
    const next = parseState(state);
    this.store.save(next);
    this.state = next;
    for (const { handler, onError } of this.subscriptions) {
      try {
        handler();
      } catch (error) {
        onError(error);
      }
    }
  }
}
