import { randomUUID } from 'node:crypto';

import { AgentTeamError } from './errors.js';
import {
  agentTeamMemberKey,
  agentTeamRootKey,
  sameAgentTeamRoot,
} from './identity.js';
import { agentTeamMemberSecretId } from './secret-id.js';

import type {
  AcpCommandProfile,
  AgentProfile,
  AgentProfileSnapshot,
  AgentTeamControlPort,
  AgentTeamManifestProfile,
  AgentTeamManifestRuntime,
  AgentTeamMemberDetail,
  AgentTeamMemberConfigView,
  AgentTeamMember,
  AgentTeamMachine,
  AgentTeamMemberSummary,
  AgentTeamRegistryChangeErrorHandler,
  AgentTeamRegistryChangeHandler,
  AgentTeamRegistryState,
  AgentTeamRegistryStore,
  AgentTeamRescanResult,
  AgentTeamRoot,
  AgentTeamRootRef,
  AgentTeamScanPort,
  AgentTeamSecretStore,
  AgentTeamSetupError,
  CreateAcpCommandProfileInput,
  CreateAgentProfileInput,
  CreateAgentTeamManifestProfileInput,
  PatchAgentProfileInput,
  UpdateAgentTeamMemberConfigsInput,
} from './types.js';
import type { AgentTeamSetupProgressParams } from '@agentlet/protocol';

function cloneState(state: AgentTeamRegistryState): AgentTeamRegistryState {
  return structuredClone(state);
}

function setRecordValue(
  record: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function setupError(error: unknown, fallbackCode: string): AgentTeamSetupError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    typeof error === 'object' &&
    error !== null &&
    'data' in error &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'code' in error.data &&
    typeof error.data.code === 'string'
  ) {
    return { code: error.data.code, message };
  }
  return { code: fallbackCode, message };
}

function isManifestProfile(
  profile: AgentProfile,
): profile is AgentTeamManifestProfile {
  return profile.launch.kind === 'agent-team-manifest';
}

export class AgentTeamRegistry {
  private state: AgentTeamRegistryState;
  private readonly rootEpochs = new Map<string, number>();
  private readonly inFlightScans = new Map<
    string,
    { epoch: number; promise: Promise<AgentTeamRescanResult> }
  >();
  private readonly unsubscribeSetupProgress?: () => void;
  private readonly unsubscribeMachinesChanged?: () => void;
  private readonly changeSubscriptions = new Set<{
    handler: AgentTeamRegistryChangeHandler;
    onError: AgentTeamRegistryChangeErrorHandler;
  }>();

  constructor(
    private readonly store: AgentTeamRegistryStore,
    private readonly scanPort: AgentTeamScanPort,
    private readonly now: () => number = Date.now,
    private readonly generateId: () => string = randomUUID,
    private readonly secretStore?: AgentTeamSecretStore,
    private readonly controlPort?: AgentTeamControlPort,
  ) {
    this.state = store.load();
    this.recoverInterruptedSetups();
    for (const root of this.state.roots) {
      this.rootEpochs.set(agentTeamRootKey(root), 0);
    }
    this.unsubscribeSetupProgress = controlPort?.onAgentTeamSetupProgress(
      (machine, progress) => this.handleSetupProgress(machine, progress),
    );
    this.unsubscribeMachinesChanged = controlPort?.onAgentTeamMachinesChanged(
      () => this.notifyChange(),
    );
  }

  dispose(): void {
    this.unsubscribeSetupProgress?.();
    this.unsubscribeMachinesChanged?.();
    this.changeSubscriptions.clear();
  }

  onChange(
    handler: AgentTeamRegistryChangeHandler,
    onError: AgentTeamRegistryChangeErrorHandler,
  ): () => void {
    const subscription = { handler, onError };
    this.changeSubscriptions.add(subscription);
    return () => this.changeSubscriptions.delete(subscription);
  }

  listRoots(): AgentTeamRoot[] {
    return structuredClone(this.state.roots);
  }

  listMachines(): AgentTeamMachine[] {
    return this.controlPort?.listAgentTeamMachines() ?? [];
  }

  listMembers(): AgentTeamMember[] {
    return structuredClone(this.state.members);
  }

  getMember(
    machine: string,
    manifestPath: string,
  ): AgentTeamMember | undefined {
    const key = agentTeamMemberKey({ machine, manifestPath });
    const member = this.state.members.find(
      (candidate) => agentTeamMemberKey(candidate) === key,
    );
    return member ? structuredClone(member) : undefined;
  }

  getMemberConfig(
    machine: string,
    manifestPath: string,
  ): AgentTeamMemberConfigView {
    const member = this.requireMember(machine, manifestPath);
    const persisted = this.state.configs.find(
      (config) =>
        config.machine === machine && config.manifestPath === manifestPath,
    );
    const fields = member.env.map((field) => {
      if (field.secret) {
        return {
          name: field.name,
          description: field.description,
          required: field.required,
          secret: true,
          configured:
            this.secretStore?.get(
              agentTeamMemberSecretId(machine, manifestPath, field.name),
            ) !== null && this.secretStore !== undefined,
        };
      }
      const hasOverride = Object.hasOwn(persisted?.values ?? {}, field.name);
      const value = hasOverride ? persisted?.values[field.name] : field.default;
      return {
        name: field.name,
        description: field.description,
        required: field.required,
        secret: false,
        configured: value !== undefined,
        ...(value === undefined ? {} : { value }),
      };
    });
    const missingRequired = fields
      .filter((field) => field.required && !field.configured)
      .map((field) => field.name);
    return {
      machine,
      manifestPath,
      fields,
      missingRequired,
      ready: missingRequired.length === 0,
    };
  }

  resolveMemberEnvironment(
    machine: string,
    manifestPath: string,
  ): Record<string, string> {
    const member = this.requireMember(machine, manifestPath);
    const persisted = this.state.configs.find(
      (config) =>
        config.machine === machine && config.manifestPath === manifestPath,
    );
    const environment: Record<string, string> = {};
    for (const field of member.env) {
      const value = field.secret
        ? this.secretStore?.get(
            agentTeamMemberSecretId(machine, manifestPath, field.name),
          )
        : Object.hasOwn(persisted?.values ?? {}, field.name)
          ? persisted?.values[field.name]
          : field.default;
      if (value !== undefined && value !== null) {
        setRecordValue(environment, field.name, value);
      }
    }
    return environment;
  }

  async updateMemberConfigs(
    machine: string,
    manifestPath: string,
    updates: UpdateAgentTeamMemberConfigsInput,
  ): Promise<AgentTeamMemberConfigView> {
    const member = this.requireMember(machine, manifestPath);
    const fields = new Map(member.env.map((field) => [field.name, field]));
    const previous = this.state.configs.find(
      (config) =>
        config.machine === machine && config.manifestPath === manifestPath,
    );
    const values = { ...(previous?.values ?? {}) };
    const secretUpdates: Record<string, string | null> = {};
    const previousSecrets: Record<string, string | null> = {};
    let ordinaryChanged = false;

    for (const [name, value] of Object.entries(updates)) {
      const field = fields.get(name);
      if (!field) {
        throw new AgentTeamError(
          'config_field_not_found',
          `Agent Team member does not declare environment field: ${name}`,
        );
      }
      if (typeof value !== 'string' && value !== null) {
        throw new AgentTeamError(
          'invalid_config_value',
          `Agent Team config value must be a string or null: ${name}`,
        );
      }
      if (field.secret) {
        if (!this.secretStore) {
          throw new Error('Agent Team SecretStore is not configured');
        }
        const secretId = agentTeamMemberSecretId(machine, manifestPath, name);
        secretUpdates[secretId] = value;
        previousSecrets[secretId] = this.secretStore.get(secretId);
        if (Object.hasOwn(values, name)) {
          delete values[name];
          ordinaryChanged = true;
        }
      } else if (value === null) {
        if (Object.hasOwn(values, name)) {
          delete values[name];
          ordinaryChanged = true;
        }
      } else if (values[name] !== value) {
        setRecordValue(values, name, value);
        ordinaryChanged = true;
      }
    }

    const configs = this.state.configs.filter(
      (config) =>
        config.machine !== machine || config.manifestPath !== manifestPath,
    );
    if (Object.keys(values).length > 0) {
      configs.push({ machine, manifestPath, values });
    }

    if (Object.keys(secretUpdates).length > 0) {
      await this.secretStore?.setMany(secretUpdates);
    }
    try {
      if (ordinaryChanged) {
        this.commit({ ...cloneState(this.state), configs });
      } else if (Object.keys(secretUpdates).length > 0) {
        this.notifyChange();
      }
    } catch (error) {
      if (Object.keys(secretUpdates).length > 0 && this.secretStore) {
        try {
          await this.secretStore.setMany(previousSecrets);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Agent Team config persistence and secret rollback both failed',
          );
        }
      }
      throw error;
    }
    return this.getMemberConfig(machine, manifestPath);
  }

  listProfiles(): AgentProfile[] {
    return structuredClone(this.state.profiles);
  }

  listSelectableProfileIds(): string[] {
    return this.state.profiles
      .filter((profile) => {
        if (!isManifestProfile(profile)) return true;
        if (profile.preparation.status !== 'ready') return false;
        const member = this.state.members.find(
          (candidate) =>
            candidate.machine === profile.agentletId &&
            candidate.manifestPath === profile.launch.manifestPath,
        );
        return (
          member?.status === 'active' &&
          this.getMemberConfig(profile.agentletId, profile.launch.manifestPath)
            .ready
        );
      })
      .map(({ id }) => id);
  }

  getProfile(id: string): AgentProfile | undefined {
    const profile = this.state.profiles.find(
      (candidate) => candidate.id === id,
    );
    return profile ? structuredClone(profile) : undefined;
  }

  listMemberSummaries(): AgentTeamMemberSummary[] {
    return this.state.members.map((member) => {
      const profiles = this.manifestProfilesFor(
        member.machine,
        member.manifestPath,
      );
      const preparationCounts: AgentTeamMemberSummary['preparationCounts'] = {
        not_prepared: 0,
        setting_up: 0,
        ready: 0,
        error: 0,
      };
      for (const profile of profiles) {
        preparationCounts[profile.preparation.status] += 1;
      }
      return {
        machine: member.machine,
        manifestPath: member.manifestPath,
        name: member.name,
        description: member.description,
        status: member.status,
        profileCount: profiles.length,
        preparationCounts,
      };
    });
  }

  getMemberDetail(
    machine: string,
    manifestPath: string,
  ): AgentTeamMemberDetail {
    return {
      member: structuredClone(this.requireMember(machine, manifestPath)),
      config: this.getMemberConfig(machine, manifestPath),
      profiles: this.manifestProfilesFor(machine, manifestPath).map(
        (profile) => ({
          ...structuredClone(profile),
          setupLog: this.store.loadSetupLog(profile.id),
        }),
      ),
    };
  }

  async resolveManifestRuntime(
    snapshot: AgentProfileSnapshot,
  ): Promise<AgentTeamManifestRuntime> {
    if (snapshot.launch.kind !== 'agent-team-manifest') {
      throw new AgentTeamError(
        'invalid_profile_kind',
        'Manifest runtime resolution requires an Agent Team Profile snapshot',
      );
    }
    const config = this.getMemberConfig(
      snapshot.agentletId,
      snapshot.launch.manifestPath,
    );
    if (!config.ready) {
      throw new AgentTeamError(
        'config_incomplete',
        `Agent Team Profile is missing required Configs: ${config.missingRequired.join(', ')}`,
      );
    }
    const result = await this.requireControlPort().validateAgentTeam(
      snapshot.agentletId,
      {
        manifestPath: snapshot.launch.manifestPath,
        harness: snapshot.launch.harness,
        workingDirPath: snapshot.workingDirPath,
      },
    );
    if (!result.valid) {
      const current = this.state.profiles.find(
        (profile) => profile.id === snapshot.profileId,
      );
      if (current && isManifestProfile(current)) {
        this.persistProfile({
          ...current,
          preparation: {
            status: 'error',
            failedAt: this.now(),
            error: {
              code: 'workspace_invalid',
              message: result.issues.map(({ message }) => message).join('; '),
            },
          },
        });
      }
      throw new AgentTeamError(
        'workspace_invalid',
        result.issues.map(({ message }) => message).join('; '),
      );
    }
    return {
      environment: this.resolveMemberEnvironment(
        snapshot.agentletId,
        snapshot.launch.manifestPath,
      ),
    };
  }

  createProfile(input: CreateAgentProfileInput): AgentProfile {
    return input.launchKind === 'agent-team-manifest'
      ? this.createManifestProfile(input)
      : this.createCommandProfile(input);
  }

  importCommandProfiles(inputs: CreateAcpCommandProfileInput[]): string[] {
    const imported: string[] = [];
    for (const input of inputs) {
      if (input.id && this.state.profiles.some(({ id }) => id === input.id)) {
        imported.push(input.id);
        continue;
      }
      imported.push(this.createCommandProfile(input).id);
    }
    return imported;
  }

  patchProfile(id: string, input: PatchAgentProfileInput): AgentProfile {
    const current = this.requireProfile(id);
    this.assertAlias(input.alias ?? current.alias);
    if (input.metadata !== undefined && current.launch.kind !== 'acp-command') {
      throw new AgentTeamError(
        'invalid_profile_patch',
        'Only ACP command Profiles accept metadata patches',
      );
    }
    // `customData` is opaque host data on the base Profile: undefined leaves it,
    // null clears it, an object replaces the whole bag.
    const customDataPatch =
      input.customData === undefined
        ? {}
        : input.customData === null
          ? { customData: undefined }
          : { customData: input.customData };
    const next: AgentProfile =
      current.launch.kind === 'acp-command'
        ? {
            ...current,
            alias: input.alias ?? current.alias,
            ...(input.metadata === undefined
              ? {}
              : input.metadata === null
                ? { metadata: undefined }
                : { metadata: input.metadata }),
            ...customDataPatch,
          }
        : {
            ...current,
            alias: input.alias ?? current.alias,
            ...customDataPatch,
          };
    this.persistProfile(next);
    return structuredClone(next);
  }

  deleteProfile(id: string): boolean {
    const current = this.state.profiles.find((profile) => profile.id === id);
    if (
      current !== undefined &&
      isManifestProfile(current) &&
      current.preparation.status === 'setting_up'
    ) {
      throw new AgentTeamError(
        'profile_busy',
        `Cancel Agent Team Profile setup before deleting it: ${id}`,
      );
    }
    const profiles = this.state.profiles.filter((profile) => profile.id !== id);
    if (profiles.length === this.state.profiles.length) return false;
    this.commit({ ...cloneState(this.state), profiles });
    if (current && isManifestProfile(current)) {
      this.store.deleteSetupLog(id);
    }
    return true;
  }

  async setupProfile(id: string): Promise<AgentTeamManifestProfile> {
    const profile = this.requireManifestProfile(id);
    if (profile.preparation.status === 'setting_up') {
      throw new AgentTeamError(
        'profile_busy',
        `Agent Team Profile setup is already in progress: ${id}`,
      );
    }
    return this.startSetup(profile);
  }

  async cancelProfileSetup(id: string): Promise<AgentTeamManifestProfile> {
    const profile = this.requireManifestProfile(id);
    if (profile.preparation.status !== 'setting_up') {
      throw new AgentTeamError(
        'invalid_setup_transition',
        `Agent Team Profile setup is not active: ${id}`,
      );
    }

    const controlPort = this.requireControlPort();
    try {
      const result = await controlPort.cancelAgentTeamSetup(
        profile.agentletId,
        { operationId: profile.preparation.operationId },
      );
      if (!result.cancelled) {
        const current = this.requireManifestProfile(id);
        if (
          current.preparation.status !== 'setting_up' ||
          current.preparation.operationId !== profile.preparation.operationId
        ) {
          return structuredClone(current);
        }
        const error = {
          code: 'setup_cancel_rejected',
          message: `Setup operation is no longer cancellable: ${profile.preparation.operationId}`,
        };
        this.failSetupIfCurrent(
          profile.id,
          profile.preparation.operationId,
          error,
        );
        throw new AgentTeamError('setup_cancel_rejected', error.message);
      }
    } catch (error) {
      const current = this.requireManifestProfile(id);
      if (
        current.preparation.status === 'setting_up' &&
        current.preparation.operationId === profile.preparation.operationId
      ) {
        this.failSetupIfCurrent(
          id,
          profile.preparation.operationId,
          setupError(error, 'setup_cancel_failed'),
        );
      }
      throw error;
    }

    const current = this.requireManifestProfile(id);
    if (
      current.preparation.status === 'setting_up' &&
      current.preparation.operationId === profile.preparation.operationId
    ) {
      const cancelled: AgentTeamManifestProfile = {
        ...current,
        preparation: { status: 'not_prepared' },
      };
      this.persistProfile(cancelled);
      return structuredClone(cancelled);
    }
    return structuredClone(current);
  }

  async addRoot(root: AgentTeamRootRef): Promise<AgentTeamRescanResult> {
    if (!root.machine.trim() || !root.path.trim()) {
      throw new AgentTeamError(
        'invalid_root',
        'Agent Team root machine and path must be non-empty',
      );
    }
    if (!this.findRoot(root)) {
      this.bumpRootEpoch(root);
      this.commit({
        ...cloneState(this.state),
        roots: [
          ...this.state.roots,
          { ...structuredClone(root), scan: { status: 'never_scanned' } },
        ],
      });
    }
    return this.rescanRoot(root);
  }

  async rescanRoot(root: AgentTeamRootRef): Promise<AgentTeamRescanResult> {
    const key = agentTeamRootKey(root);
    const epoch = this.rootEpochs.get(key) ?? 0;
    const inFlight = this.inFlightScans.get(key);
    if (inFlight?.epoch === epoch) return inFlight.promise;

    const promise = this.performRescan(root, epoch).finally(() => {
      const current = this.inFlightScans.get(key);
      if (current?.promise === promise) this.inFlightScans.delete(key);
    });
    this.inFlightScans.set(key, { epoch, promise });
    return promise;
  }

  private async performRescan(
    root: AgentTeamRootRef,
    epoch: number,
  ): Promise<AgentTeamRescanResult> {
    const existingRoot = this.findRoot(root);
    if (!existingRoot) {
      throw new AgentTeamError(
        'root_not_found',
        `Agent Team root not found: ${agentTeamRootKey(root)}`,
      );
    }

    const attemptedAt = this.now();
    let result;
    try {
      result = await this.scanPort.scanAgentTeams(root.machine, {
        rootPath: root.path,
      });
    } catch (error) {
      if (!this.isCurrentRoot(root, epoch)) {
        throw new AgentTeamError(
          'root_scan_stale',
          `Agent Team root was removed or replaced during scan: ${agentTeamRootKey(root)}`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const failedRoot: AgentTeamRoot = {
        ...existingRoot,
        scan: { status: 'error', attemptedAt, message },
      };
      this.commit({
        ...cloneState(this.state),
        roots: this.state.roots.map((candidate) =>
          sameAgentTeamRoot(candidate, root) ? failedRoot : candidate,
        ),
      });
      return { ok: false, root: structuredClone(failedRoot), error: message };
    }

    if (!this.isCurrentRoot(root, epoch)) {
      throw new AgentTeamError(
        'root_scan_stale',
        `Agent Team root was removed or replaced during scan: ${agentTeamRootKey(root)}`,
      );
    }
    const rootRef: AgentTeamRootRef = {
      machine: existingRoot.machine,
      path: existingRoot.path,
    };
    const members = new Map(
      this.state.members.map((member) => [
        agentTeamMemberKey(member),
        structuredClone(member),
      ]),
    );
    for (const member of members.values()) {
      member.discoveredBy = member.discoveredBy.filter(
        (candidate) => !sameAgentTeamRoot(candidate, rootRef),
      );
    }
    for (const scanned of result.members) {
      const key = agentTeamMemberKey({
        machine: root.machine,
        manifestPath: scanned.manifestPath,
      });
      const previous = members.get(key);
      const discoveredBy = previous?.discoveredBy ?? [];
      if (
        !discoveredBy.some((candidate) => sameAgentTeamRoot(candidate, rootRef))
      ) {
        discoveredBy.push(structuredClone(rootRef));
      }
      members.set(key, {
        machine: root.machine,
        manifestPath: scanned.manifestPath,
        name: scanned.name,
        description: scanned.description,
        harnesses: [...scanned.harnesses],
        env: structuredClone(scanned.env),
        discoveredBy,
        status: 'active',
      });
    }
    for (const member of members.values()) {
      member.status =
        member.discoveredBy.length === 0 ? 'member_missing' : 'active';
    }

    const successfulRoot: AgentTeamRoot = {
      ...existingRoot,
      scan: {
        status: 'success',
        scannedAt: attemptedAt,
        diagnostics: structuredClone(result.diagnostics),
      },
    };
    const nextState: AgentTeamRegistryState = {
      roots: this.state.roots.map((candidate) =>
        sameAgentTeamRoot(candidate, root) ? successfulRoot : candidate,
      ),
      members: [...members.values()],
      profiles: structuredClone(this.state.profiles),
      configs: structuredClone(this.state.configs),
    };
    this.commit(nextState);
    return {
      ok: true,
      root: structuredClone(successfulRoot),
      members: structuredClone(nextState.members),
    };
  }

  removeRoot(root: AgentTeamRootRef): boolean {
    if (!this.findRoot(root)) return false;
    this.bumpRootEpoch(root);
    const members = this.state.members.map((member) => {
      const discoveredBy = member.discoveredBy.filter(
        (candidate) => !sameAgentTeamRoot(candidate, root),
      );
      return {
        ...structuredClone(member),
        discoveredBy,
        status:
          discoveredBy.length === 0
            ? ('member_missing' as const)
            : ('active' as const),
      };
    });
    this.commit({
      roots: this.state.roots.filter(
        (candidate) => !sameAgentTeamRoot(candidate, root),
      ),
      members,
      profiles: structuredClone(this.state.profiles),
      configs: structuredClone(this.state.configs),
    });
    return true;
  }

  private findRoot(root: AgentTeamRootRef): AgentTeamRoot | undefined {
    return this.state.roots.find((candidate) =>
      sameAgentTeamRoot(candidate, root),
    );
  }

  private async startSetup(
    profile: AgentTeamManifestProfile,
  ): Promise<AgentTeamManifestProfile> {
    this.requireActiveMember(profile.agentletId, profile.launch.manifestPath);
    const config = this.getMemberConfig(
      profile.agentletId,
      profile.launch.manifestPath,
    );
    if (!config.ready) {
      throw new AgentTeamError(
        'config_incomplete',
        `Agent Team Profile is missing required Configs: ${config.missingRequired.join(', ')}`,
      );
    }
    const controlPort = this.requireControlPort();
    const operationId = this.generateId();
    if (
      !operationId.trim() ||
      this.state.profiles.some(
        (candidate) =>
          isManifestProfile(candidate) &&
          candidate.preparation.status === 'setting_up' &&
          candidate.preparation.operationId === operationId,
      )
    ) {
      throw new Error(
        `Generated Agent Team setup operation ID is invalid or duplicated: ${operationId}`,
      );
    }

    const settingUp: AgentTeamManifestProfile = {
      ...profile,
      preparation: {
        status: 'setting_up',
        operationId,
        startedAt: this.now(),
      },
    };
    this.store.resetSetupLog(profile.id);
    this.persistProfile(settingUp);

    try {
      const result = await controlPort.setupAgentTeam(profile.agentletId, {
        operationId,
        manifestPath: profile.launch.manifestPath,
        harness: profile.launch.harness,
        workingDirPath: profile.workingDirPath,
      });
      if (result.operationId !== operationId || result.accepted !== true) {
        throw new Error(
          `Agent Team setup returned a mismatched operation: ${result.operationId}`,
        );
      }
    } catch (error) {
      const current = this.requireManifestProfile(profile.id);
      if (
        current.preparation.status === 'setting_up' &&
        current.preparation.operationId === operationId
      ) {
        this.failSetupIfCurrent(
          profile.id,
          operationId,
          setupError(error, 'setup_start_failed'),
        );
        throw error;
      }
      return structuredClone(current);
    }
    return structuredClone(this.requireManifestProfile(profile.id));
  }

  private handleSetupProgress(
    machine: string,
    progress: AgentTeamSetupProgressParams,
  ): void {
    const profile = this.state.profiles.find(
      (candidate) =>
        isManifestProfile(candidate) &&
        candidate.agentletId === machine &&
        candidate.preparation.status === 'setting_up' &&
        candidate.preparation.operationId === progress.operationId,
    );
    if (
      !profile ||
      !isManifestProfile(profile) ||
      profile.preparation.status !== 'setting_up'
    ) {
      return;
    }

    if (progress.type === 'phase') {
      this.store.appendSetupLog(profile.id, {
        receivedAt: this.now(),
        phase: progress.phase,
        status: progress.status,
        message: progress.message,
      });
      return;
    }
    if (progress.type === 'completed') {
      this.persistProfile({
        ...profile,
        preparation: { status: 'ready', completedAt: this.now() },
      });
      return;
    }
    if (progress.type === 'failed') {
      this.persistProfile({
        ...profile,
        preparation: {
          status: 'error',
          failedAt: this.now(),
          error: progress.error,
        },
      });
      return;
    }
    this.persistProfile({
      ...profile,
      preparation: { status: 'not_prepared' },
    });
  }

  private failSetupIfCurrent(
    profileId: string,
    operationId: string,
    error: AgentTeamSetupError,
  ): void {
    const profile = this.requireManifestProfile(profileId);
    if (
      profile.preparation.status !== 'setting_up' ||
      profile.preparation.operationId !== operationId
    ) {
      return;
    }
    this.persistProfile({
      ...profile,
      preparation: { status: 'error', failedAt: this.now(), error },
    });
  }

  private recoverInterruptedSetups(): void {
    let changed = false;
    const profiles = this.state.profiles.map((profile) => {
      if (
        !isManifestProfile(profile) ||
        profile.preparation.status !== 'setting_up'
      ) {
        return profile;
      }
      changed = true;
      return {
        ...profile,
        preparation: {
          status: 'error' as const,
          failedAt: this.now(),
          error: {
            code: 'setup_interrupted',
            message: 'Setup was interrupted by an Agenetes restart',
          },
        },
      };
    });
    if (changed) {
      this.commit({ ...cloneState(this.state), profiles });
    }
  }

  private requireControlPort(): AgentTeamControlPort {
    if (!this.controlPort) {
      throw new Error('Agent Team control port is not configured');
    }
    return this.controlPort;
  }

  private createManifestProfile(
    input: CreateAgentTeamManifestProfileInput,
  ): AgentTeamManifestProfile {
    const member = this.requireActiveMember(
      input.agentletId,
      input.manifestPath,
    );
    this.assertHarnessSupported(member, input.harness);
    this.assertWorkingDirPath(input.workingDirPath);
    const profile: AgentTeamManifestProfile = {
      id: this.allocateProfileId(input.id),
      alias: this.assertAlias(input.alias),
      agentletId: input.agentletId,
      workingDirPath: input.workingDirPath,
      ...(input.customData === undefined
        ? {}
        : { customData: input.customData }),
      launch: {
        kind: 'agent-team-manifest',
        manifestPath: input.manifestPath,
        harness: input.harness,
      },
      preparation: { status: 'not_prepared' },
    };
    this.commit({
      ...cloneState(this.state),
      profiles: [...this.state.profiles, profile],
    });
    return structuredClone(profile);
  }

  private createCommandProfile(
    input: CreateAcpCommandProfileInput,
  ): AcpCommandProfile {
    this.assertWorkingDirPath(input.workingDirPath);
    if (!input.agentletId.trim()) {
      throw new AgentTeamError(
        'invalid_agentlet',
        'ACP command Profile agentletId must be non-empty',
      );
    }
    if (!input.command.trim()) {
      throw new AgentTeamError(
        'invalid_command',
        'ACP command Profile command must be non-empty',
      );
    }
    const profile: AcpCommandProfile = {
      id: this.allocateProfileId(input.id),
      alias: this.assertAlias(input.alias),
      agentletId: input.agentletId,
      workingDirPath: input.workingDirPath,
      launch: { kind: 'acp-command', command: input.command },
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.customData === undefined
        ? {}
        : { customData: input.customData }),
    };
    this.commit({
      ...cloneState(this.state),
      profiles: [...this.state.profiles, profile],
    });
    return structuredClone(profile);
  }

  private allocateProfileId(requestedId?: string): string {
    const id = requestedId ?? this.generateId();
    if (!id.trim() || id.trim() !== id) {
      throw new Error(
        'Generated Agent Profile ID must be non-empty without surrounding whitespace',
      );
    }
    if (this.state.profiles.some((profile) => profile.id === id)) {
      throw new AgentTeamError(
        'profile_conflict',
        `Agent Profile already exists: ${id}`,
      );
    }
    return id;
  }

  private requireProfile(id: string): AgentProfile {
    const profile = this.state.profiles.find(
      (candidate) => candidate.id === id,
    );
    if (!profile) {
      throw new AgentTeamError(
        'profile_not_found',
        `Agent Profile not found: ${id}`,
      );
    }
    return profile;
  }

  private requireManifestProfile(id: string): AgentTeamManifestProfile {
    const profile = this.requireProfile(id);
    if (!isManifestProfile(profile)) {
      throw new AgentTeamError(
        'invalid_profile_kind',
        `Agent Profile is not manifest-backed: ${id}`,
      );
    }
    return profile;
  }

  private manifestProfilesFor(
    machine: string,
    manifestPath: string,
  ): AgentTeamManifestProfile[] {
    return this.state.profiles.filter(
      (profile): profile is AgentTeamManifestProfile =>
        isManifestProfile(profile) &&
        profile.agentletId === machine &&
        profile.launch.manifestPath === manifestPath,
    );
  }

  private persistProfile(profile: AgentProfile): void {
    this.commit({
      ...cloneState(this.state),
      profiles: this.state.profiles.map((candidate) =>
        candidate.id === profile.id ? profile : candidate,
      ),
    });
  }

  private requireActiveMember(
    machine: string,
    manifestPath: string,
  ): AgentTeamMember {
    const member = this.requireMember(machine, manifestPath);
    if (member.status !== 'active') {
      throw new AgentTeamError(
        'member_missing',
        `Agent Team member is missing: ${agentTeamMemberKey(member)}`,
      );
    }
    return member;
  }

  private requireMember(
    machine: string,
    manifestPath: string,
  ): AgentTeamMember {
    const member = this.state.members.find(
      (candidate) =>
        candidate.machine === machine &&
        candidate.manifestPath === manifestPath,
    );
    if (!member) {
      throw new AgentTeamError(
        'member_not_found',
        `Agent Team member not found: ${agentTeamMemberKey({ machine, manifestPath })}`,
      );
    }
    return member;
  }

  private assertAlias(alias: string): string {
    if (!alias.trim() || alias.trim() !== alias) {
      throw new AgentTeamError(
        'invalid_alias',
        'Agent Profile alias must be non-empty without surrounding whitespace',
      );
    }
    return alias;
  }

  private assertHarnessSupported(
    member: AgentTeamMember,
    harness: string,
  ): void {
    if (!member.harnesses.includes(harness)) {
      throw new AgentTeamError(
        'unsupported_harness',
        `Harness "${harness}" is not declared by Agent Team member ${agentTeamMemberKey(member)}`,
      );
    }
  }

  private assertWorkingDirPath(workingDirPath: string): void {
    if (!workingDirPath.trim()) {
      throw new AgentTeamError(
        'invalid_working_directory',
        'Agent Team workingDirPath must be non-empty',
      );
    }
  }

  private isCurrentRoot(root: AgentTeamRootRef, epoch: number): boolean {
    return (
      this.findRoot(root) !== undefined &&
      (this.rootEpochs.get(agentTeamRootKey(root)) ?? 0) === epoch
    );
  }

  private bumpRootEpoch(root: AgentTeamRootRef): void {
    const key = agentTeamRootKey(root);
    this.rootEpochs.set(key, (this.rootEpochs.get(key) ?? 0) + 1);
  }

  private commit(nextState: AgentTeamRegistryState): void {
    this.store.save(nextState);
    this.state = cloneState(nextState);
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const { handler, onError } of this.changeSubscriptions) {
      try {
        handler();
      } catch (error) {
        onError(error);
      }
    }
  }
}
