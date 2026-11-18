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
  CreateAcpHarnessProfileInput,
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
    ...(input.visible === undefined ? {} : { visible: input.visible }),
    agentletId: input.agentletId,
    workingDirPath: input.workingDirPath,
    launch: { kind: 'acp-command', command: input.command },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.customData === undefined ? {} : { customData: input.customData }),
  });
}

export function harnessProfile(
  input: CreateAcpHarnessProfileInput,
  generateId: () => string = randomUUID,
): AgentProfile {
  return parseProfile({
    id: input.id ?? generateId(),
    alias: input.alias,
    ...(input.visible === undefined ? {} : { visible: input.visible }),
    agentletId: input.agentletId,
    workingDirPath: input.workingDirPath,
    launch: {
      kind: 'acp-harness',
      harnessId: input.harnessId,
      ...(input.options === undefined ? {} : { options: input.options }),
    },
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.customData === undefined ? {} : { customData: input.customData }),
  });
}

/** Host authorization for the Profiles one registry operation touches. */
export type AgentProfileAccess = (profile: AgentProfile) => boolean;

export interface AgentProfileRegistryOptions {
  generateId?: () => string;
  /**
   * Resolve the host's authorization. Called once at the start of every read
   * and mutation; the predicate it returns answers for every Profile that
   * operation touches, so a host that reads ownership from storage reads it
   * once per operation rather than once per Profile. Defaults to allowing
   * every Profile.
   */
  resolveAccess?: () => AgentProfileAccess | Promise<AgentProfileAccess>;
}

export class AgentProfileRegistry {
  /** Open a registry over the state `store` last acknowledged. */
  static async open(
    store: AgentProfileRegistryStore,
    options: AgentProfileRegistryOptions = {},
  ): Promise<AgentProfileRegistry> {
    return new AgentProfileRegistry(
      store,
      parseState((await store.load()) ?? { profiles: [] }),
      options,
    );
  }

  private state: AgentProfileRegistryState;
  private readonly generateId: () => string;
  private readonly resolveAccess: () =>
    | AgentProfileAccess
    | Promise<AgentProfileAccess>;
  /**
   * Mutations run one at a time, each against the state the previous one
   * committed, because a store acknowledges a save asynchronously.
   */
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly subscriptions = new Set<{
    handler: AgentProfileRegistryChangeHandler;
    onError: AgentProfileRegistryChangeErrorHandler;
  }>();
  private constructor(
    private readonly store: AgentProfileRegistryStore,
    state: AgentProfileRegistryState,
    options: AgentProfileRegistryOptions,
  ) {
    this.state = state;
    this.generateId = options.generateId ?? randomUUID;
    this.resolveAccess = options.resolveAccess ?? (() => () => true);
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
  async getProfile(id: string): Promise<AgentProfile | undefined> {
    const profile = this.findProfile(id, await this.resolveAccess());
    return profile && structuredClone(profile);
  }
  async listProfiles(): Promise<AgentProfile[]> {
    return structuredClone(
      this.state.profiles.filter(await this.resolveAccess()),
    );
  }
  async listSelectableProfileIds(): Promise<string[]> {
    const canAccess = await this.resolveAccess();
    return this.state.profiles
      .filter((profile) => profile.visible !== false && canAccess(profile))
      .map(({ id }) => id);
  }
  async snapshotProfile(id: string): Promise<AgentProfileSnapshot> {
    const { agentletId, workingDirPath, launch, executionRevision } =
      structuredClone(this.requireProfile(id, await this.resolveAccess()));
    return {
      profileId: id,
      agentletId,
      workingDirPath,
      launch,
      ...(executionRevision === undefined ? {} : { executionRevision }),
    };
  }
  createProfile(input: CreateAgentProfileInput): Promise<AgentProfile> {
    return this.mutate(async (canAccess) => {
      if (
        input.launchKind !== 'acp-command' &&
        input.launchKind !== 'acp-harness'
      )
        throw new AgentProfileError(
          'invalid_profile_kind',
          'Only ACP command or harness Profiles are supported',
        );
      const profile =
        input.launchKind === 'acp-command'
          ? commandProfile(input, this.generateId)
          : harnessProfile(input, this.generateId);
      profile.revision = 0;
      profile.executionRevision = 0;
      if (!canAccess(profile))
        throw new AgentProfileError(
          'profile_not_found',
          'Agent Profile is unavailable',
        );
      if (this.state.profiles.some((entry) => entry.id === profile.id))
        throw new AgentProfileError(
          'profile_conflict',
          `Agent Profile already exists: ${profile.id}`,
        );
      await this.commit({ profiles: [...this.state.profiles, profile] });
      return structuredClone(profile);
    });
  }
  importCommandProfiles(
    inputs: CreateAcpCommandProfileInput[],
  ): Promise<string[]> {
    return this.mutate(async (canAccess) => {
      const profiles = structuredClone(this.state.profiles);
      const imported = inputs.map((input) =>
        commandProfile(input, this.generateId),
      );
      for (const profile of imported) {
        if (!canAccess(profile))
          throw new AgentProfileError(
            'profile_not_found',
            'Agent Profile is unavailable',
          );
        const existing = profiles.find(({ id }) => id === profile.id);
        if (existing && !canAccess(existing))
          throw new AgentProfileError(
            'profile_conflict',
            `Agent Profile already exists: ${profile.id}`,
          );
        if (existing?.revision !== undefined)
          profile.revision = existing.revision;
        if (existing?.executionRevision !== undefined)
          profile.executionRevision = existing.executionRevision;
        if (existing && !isDeepStrictEqual(existing, profile))
          throw new AgentProfileError(
            'profile_conflict',
            `Conflicting Agent Profile ID: ${profile.id}`,
          );
        if (!existing) profiles.push(profile);
      }
      if (profiles.length !== this.state.profiles.length)
        await this.commit({ profiles });
      return imported.map(({ id }) => id);
    });
  }
  patchProfile(
    id: string,
    input: PatchAgentProfileInput,
  ): Promise<AgentProfile> {
    return this.mutate(async (canAccess) => {
      if (
        Object.keys(input).some(
          (key) =>
            ![
              'alias',
              'metadata',
              'customData',
              'workingDirPath',
              'launch',
              'expectedRevision',
            ].includes(key),
        )
      )
        throw new AgentProfileError(
          'invalid_profile_patch',
          'Profile launch identity is immutable',
        );
      const current = this.requireProfile(id, canAccess);
      if (input.expectedRevision !== undefined) {
        if (
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 0
        )
          throw new AgentProfileError(
            'invalid_profile_patch',
            'expectedRevision must be a nonnegative safe integer',
          );
        if (input.expectedRevision !== (current.revision ?? 0))
          throw new AgentProfileError(
            'profile_conflict',
            'Agent Profile changed; reload before editing',
          );
      }
      const next = structuredClone(current);
      if (input.workingDirPath !== undefined)
        next.workingDirPath = input.workingDirPath;
      if (input.launch !== undefined) next.launch = input.launch;
      if (input.alias !== undefined) next.alias = input.alias;
      if (input.metadata === null) delete next.metadata;
      else if (input.metadata !== undefined) next.metadata = input.metadata;
      if (input.customData === null) delete next.customData;
      else if (input.customData !== undefined)
        next.customData = input.customData;
      const profile = parseProfile(next);
      if (
        profile.launch.kind !== current.launch.kind ||
        (profile.launch.kind === 'acp-harness' &&
          current.launch.kind === 'acp-harness' &&
          profile.launch.harnessId !== current.launch.harnessId)
      )
        throw new AgentProfileError(
          'invalid_profile_patch',
          'Profile wrapper identity is immutable',
        );
      if (isDeepStrictEqual(current, profile)) return structuredClone(current);
      profile.revision = (current.revision ?? 0) + 1;
      if (
        profile.workingDirPath !== current.workingDirPath ||
        !isDeepStrictEqual(profile.launch, current.launch)
      )
        profile.executionRevision = (current.executionRevision ?? 0) + 1;
      await this.commit({
        profiles: this.state.profiles.map((entry) =>
          entry.id === id ? profile : entry,
        ),
      });
      return structuredClone(profile);
    });
  }
  deleteProfile(id: string): Promise<boolean> {
    return this.mutate(async (canAccess) => {
      if (!this.findProfile(id, canAccess)) return false;
      const profiles = this.state.profiles.filter(
        (profile) => profile.id !== id,
      );
      if (profiles.length === this.state.profiles.length) return false;
      await this.commit({ profiles });
      return true;
    });
  }
  /**
   * Run one mutation after every earlier one has committed or failed, with
   * the host's authorization resolved for it.
   */
  private mutate<T>(
    operation: (canAccess: AgentProfileAccess) => Promise<T>,
  ): Promise<T> {
    const run = async () => operation(await this.resolveAccess());
    const result = this.mutations.then(run, run);
    this.mutations = result.catch(() => undefined);
    return result;
  }
  /** The stored Profile, uncloned, when `canAccess` allows it. */
  private findProfile(
    id: string,
    canAccess: AgentProfileAccess,
  ): AgentProfile | undefined {
    const profile = this.state.profiles.find((entry) => entry.id === id);
    return profile && canAccess(profile) ? profile : undefined;
  }
  private requireProfile(
    id: string,
    canAccess: AgentProfileAccess,
  ): AgentProfile {
    const profile = this.findProfile(id, canAccess);
    if (!profile)
      throw new AgentProfileError(
        'profile_not_found',
        `Agent Profile not found: ${id}`,
      );
    return profile;
  }
  /** Publish `state` only after the store has acknowledged it. */
  private async commit(state: AgentProfileRegistryState): Promise<void> {
    const next = parseState(state);
    await this.store.save(next);
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
