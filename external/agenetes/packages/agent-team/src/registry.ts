import { randomUUID } from 'node:crypto';

import {
  agentTeamMemberKey,
  agentTeamRootKey,
  sameAgentTeamRoot,
} from './identity.js';
import { agentTeamMemberSecretId } from './secret-id.js';

import type { AgentTeamSetupProgressParams } from '@agentlet/protocol';
import type {
  AgentTeamControlPort,
  AgentTeamDeployment,
  AgentTeamMemberConfigView,
  AgentTeamMember,
  AgentTeamRegistryState,
  AgentTeamRegistryStore,
  AgentTeamRescanResult,
  AgentTeamRoot,
  AgentTeamRootRef,
  AgentTeamScanPort,
  AgentTeamSecretStore,
  AgentTeamSetupError,
  CreateAgentTeamDeploymentInput,
  UpdateAgentTeamMemberConfigsInput,
  UpdateAgentTeamDeploymentInput,
} from './types.js';

const SETUP_LOG_LIMIT = 200;

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

export class AgentTeamRegistry {
  private state: AgentTeamRegistryState;
  private readonly rootEpochs = new Map<string, number>();
  private readonly inFlightScans = new Map<
    string,
    { epoch: number; promise: Promise<AgentTeamRescanResult> }
  >();
  private readonly unsubscribeSetupProgress?: () => void;

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
  }

  dispose(): void {
    this.unsubscribeSetupProgress?.();
  }

  listRoots(): AgentTeamRoot[] {
    return structuredClone(this.state.roots);
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
        throw new Error(
          `Agent Team member does not declare environment field: ${name}`,
        );
      }
      if (typeof value !== 'string' && value !== null) {
        throw new Error(
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

  listDeployments(member?: {
    machine: string;
    manifestPath: string;
  }): AgentTeamDeployment[] {
    const deployments = member
      ? this.state.deployments.filter(
          (deployment) =>
            deployment.machine === member.machine &&
            deployment.manifestPath === member.manifestPath,
        )
      : this.state.deployments;
    return structuredClone(deployments);
  }

  getDeployment(id: string): AgentTeamDeployment | undefined {
    const deployment = this.state.deployments.find(
      (candidate) => candidate.id === id,
    );
    return deployment ? structuredClone(deployment) : undefined;
  }

  getDeploymentByAlias(alias: string): AgentTeamDeployment | undefined {
    const deployment = this.state.deployments.find(
      (candidate) => candidate.alias === alias,
    );
    return deployment ? structuredClone(deployment) : undefined;
  }

  createDeployment(input: CreateAgentTeamDeploymentInput): AgentTeamDeployment {
    this.assertAliasAvailable(input.alias);
    const member = this.requireActiveMember(input.machine, input.manifestPath);
    this.assertHarnessSupported(member, input.harness);
    this.assertWorkingDirPath(input.workingDirPath);

    const id = this.generateId();
    if (!id.trim() || id.trim() !== id) {
      throw new Error(
        'Generated Agent Team deployment ID must be non-empty without surrounding whitespace',
      );
    }
    if (this.state.deployments.some((deployment) => deployment.id === id)) {
      throw new Error(`Agent Team deployment ID already exists: ${id}`);
    }
    const deployment: AgentTeamDeployment = {
      id,
      alias: input.alias,
      revision: 1,
      enabled: false,
      machine: input.machine,
      manifestPath: input.manifestPath,
      harness: input.harness,
      workingDirPath: input.workingDirPath,
      setup: { status: 'disabled' },
      setupLog: [],
    };
    this.commit({
      ...cloneState(this.state),
      deployments: [...this.state.deployments, deployment],
    });
    return structuredClone(deployment);
  }

  updateDeployment(
    id: string,
    input: UpdateAgentTeamDeploymentInput,
  ): AgentTeamDeployment {
    const current = this.state.deployments.find(
      (deployment) => deployment.id === id,
    );
    if (!current) {
      throw new Error(`Agent Team deployment not found: ${id}`);
    }
    if (input.alias !== undefined && input.alias !== current.alias) {
      this.assertAliasAvailable(input.alias, id);
    }

    const harness = input.harness ?? current.harness;
    const workingDirPath = input.workingDirPath ?? current.workingDirPath;
    const placementChanged =
      harness !== current.harness || workingDirPath !== current.workingDirPath;
    if (
      placementChanged &&
      (current.enabled || current.setup.status === 'setting_up')
    ) {
      throw new Error(
        `Disable Agent Team deployment before changing placement: ${id}`,
      );
    }
    if (placementChanged) {
      const member = this.requireActiveMember(
        current.machine,
        current.manifestPath,
      );
      this.assertHarnessSupported(member, harness);
      this.assertWorkingDirPath(workingDirPath);
    }

    const next: AgentTeamDeployment = {
      ...current,
      alias: input.alias ?? current.alias,
      harness,
      workingDirPath,
      revision: placementChanged ? current.revision + 1 : current.revision,
      setup: placementChanged ? { status: 'disabled' } : current.setup,
      setupLog: placementChanged ? [] : current.setupLog,
    };
    this.commit({
      ...cloneState(this.state),
      deployments: this.state.deployments.map((deployment) =>
        deployment.id === id ? next : deployment,
      ),
    });
    return structuredClone(next);
  }

  deleteDeployment(id: string): boolean {
    const current = this.state.deployments.find(
      (deployment) => deployment.id === id,
    );
    if (current?.enabled || current?.setup.status === 'setting_up') {
      throw new Error(
        `Disable Agent Team deployment before deleting it: ${id}`,
      );
    }
    const deployments = this.state.deployments.filter(
      (deployment) => deployment.id !== id,
    );
    if (deployments.length === this.state.deployments.length) return false;
    this.commit({ ...cloneState(this.state), deployments });
    return true;
  }

  async enableDeployment(id: string): Promise<AgentTeamDeployment> {
    const deployment = this.requireDeployment(id);
    if (deployment.enabled) return structuredClone(deployment);
    if (deployment.setup.status === 'setting_up') {
      throw new Error(
        `Agent Team deployment setup transition is already in progress: ${id}`,
      );
    }
    return this.startSetup(deployment, true);
  }

  async retryDeploymentSetup(id: string): Promise<AgentTeamDeployment> {
    const deployment = this.requireDeployment(id);
    if (!deployment.enabled || deployment.setup.status !== 'error') {
      throw new Error(
        `Agent Team deployment is not eligible for setup retry: ${id}`,
      );
    }
    return this.startSetup(deployment, false);
  }

  async disableDeployment(id: string): Promise<AgentTeamDeployment> {
    const deployment = this.requireDeployment(id);
    if (!deployment.enabled) return structuredClone(deployment);

    const disabling: AgentTeamDeployment = {
      ...deployment,
      enabled: false,
    };
    this.persistDeployment(disabling);

    if (deployment.setup.status !== 'setting_up') {
      const disabled: AgentTeamDeployment = {
        ...disabling,
        setup: { status: 'disabled' },
      };
      this.persistDeployment(disabled);
      return structuredClone(disabled);
    }

    const controlPort = this.requireControlPort();
    try {
      const result = await controlPort.cancelAgentTeamSetup(
        deployment.machine,
        { operationId: deployment.setup.operationId },
      );
      if (!result.cancelled) {
        const current = this.requireDeployment(id);
        if (
          current.setup.status !== 'setting_up' ||
          current.setup.operationId !== deployment.setup.operationId
        ) {
          return structuredClone(current);
        }
        const error = {
          code: 'setup_cancel_rejected',
          message: `Setup operation is no longer cancellable: ${deployment.setup.operationId}`,
        };
        this.failSetupIfCurrent(
          deployment.id,
          deployment.setup.operationId,
          error,
        );
        throw new Error(error.message);
      }
    } catch (error) {
      const current = this.requireDeployment(id);
      if (
        current.setup.status === 'setting_up' &&
        current.setup.operationId === deployment.setup.operationId
      ) {
        this.failSetupIfCurrent(
          id,
          deployment.setup.operationId,
          setupError(error, 'setup_cancel_failed'),
        );
      }
      throw error;
    }

    const current = this.requireDeployment(id);
    if (
      current.setup.status === 'setting_up' &&
      current.setup.operationId === deployment.setup.operationId
    ) {
      const disabled: AgentTeamDeployment = {
        ...current,
        setup: { status: 'disabled' },
      };
      this.persistDeployment(disabled);
      return structuredClone(disabled);
    }
    return structuredClone(current);
  }

  async addRoot(root: AgentTeamRootRef): Promise<AgentTeamRescanResult> {
    if (!root.machine.trim() || !root.path.trim()) {
      throw new Error('Agent Team root machine and path must be non-empty');
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
      throw new Error(`Agent Team root not found: ${agentTeamRootKey(root)}`);
    }

    const attemptedAt = this.now();
    let result;
    try {
      result = await this.scanPort.scanAgentTeams(root.machine, {
        rootPath: root.path,
      });
    } catch (error) {
      if (!this.isCurrentRoot(root, epoch)) {
        throw new Error(
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
      throw new Error(
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
      deployments: structuredClone(this.state.deployments),
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
      deployments: structuredClone(this.state.deployments),
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
    deployment: AgentTeamDeployment,
    setEnabled: boolean,
  ): Promise<AgentTeamDeployment> {
    this.requireActiveMember(deployment.machine, deployment.manifestPath);
    const config = this.getMemberConfig(
      deployment.machine,
      deployment.manifestPath,
    );
    if (!config.ready) {
      throw new Error(
        `Agent Team deployment is missing required Configs: ${config.missingRequired.join(', ')}`,
      );
    }
    const controlPort = this.requireControlPort();
    const operationId = this.generateId();
    if (
      !operationId.trim() ||
      this.state.deployments.some(
        (candidate) =>
          candidate.setup.status === 'setting_up' &&
          candidate.setup.operationId === operationId,
      )
    ) {
      throw new Error(
        `Generated Agent Team setup operation ID is invalid or duplicated: ${operationId}`,
      );
    }

    const settingUp: AgentTeamDeployment = {
      ...deployment,
      enabled: setEnabled ? true : deployment.enabled,
      setup: {
        status: 'setting_up',
        operationId,
        startedAt: this.now(),
      },
      setupLog: [],
    };
    this.persistDeployment(settingUp);

    try {
      const result = await controlPort.setupAgentTeam(deployment.machine, {
        operationId,
        manifestPath: deployment.manifestPath,
        harness: deployment.harness,
        workingDirPath: deployment.workingDirPath,
      });
      if (result.operationId !== operationId || result.accepted !== true) {
        throw new Error(
          `Agent Team setup returned a mismatched operation: ${result.operationId}`,
        );
      }
    } catch (error) {
      const current = this.requireDeployment(deployment.id);
      if (
        current.setup.status === 'setting_up' &&
        current.setup.operationId === operationId
      ) {
        this.failSetupIfCurrent(
          deployment.id,
          operationId,
          setupError(error, 'setup_start_failed'),
        );
        throw error;
      }
      return structuredClone(current);
    }
    return structuredClone(this.requireDeployment(deployment.id));
  }

  private handleSetupProgress(
    machine: string,
    progress: AgentTeamSetupProgressParams,
  ): void {
    const deployment = this.state.deployments.find(
      (candidate) =>
        candidate.machine === machine &&
        candidate.setup.status === 'setting_up' &&
        candidate.setup.operationId === progress.operationId,
    );
    if (!deployment || deployment.setup.status !== 'setting_up') return;

    const setupLog =
      progress.type === 'phase'
        ? [
            ...deployment.setupLog,
            {
              receivedAt: this.now(),
              phase: progress.phase,
              status: progress.status,
              message: progress.message,
            },
          ].slice(-SETUP_LOG_LIMIT)
        : deployment.setupLog;

    if (progress.type === 'phase') {
      this.persistDeployment({ ...deployment, setupLog });
      return;
    }
    if (progress.type === 'completed') {
      this.persistDeployment({
        ...deployment,
        setup: deployment.enabled
          ? { status: 'ready', completedAt: this.now() }
          : { status: 'disabled' },
        setupLog,
      });
      return;
    }
    if (progress.type === 'failed') {
      this.persistDeployment({
        ...deployment,
        setup: {
          status: 'error',
          failedAt: this.now(),
          error: progress.error,
        },
        setupLog,
      });
      return;
    }
    this.persistDeployment({
      ...deployment,
      enabled: false,
      setup: { status: 'disabled' },
      setupLog,
    });
  }

  private failSetupIfCurrent(
    deploymentId: string,
    operationId: string,
    error: AgentTeamSetupError,
  ): void {
    const deployment = this.requireDeployment(deploymentId);
    if (
      deployment.setup.status !== 'setting_up' ||
      deployment.setup.operationId !== operationId
    ) {
      return;
    }
    this.persistDeployment({
      ...deployment,
      setup: { status: 'error', failedAt: this.now(), error },
    });
  }

  private recoverInterruptedSetups(): void {
    let changed = false;
    const deployments = this.state.deployments.map((deployment) => {
      if (deployment.setup.status !== 'setting_up') return deployment;
      changed = true;
      return {
        ...deployment,
        setup: {
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
      this.commit({ ...cloneState(this.state), deployments });
    }
  }

  private requireDeployment(id: string): AgentTeamDeployment {
    const deployment = this.state.deployments.find(
      (candidate) => candidate.id === id,
    );
    if (!deployment) {
      throw new Error(`Agent Team deployment not found: ${id}`);
    }
    return deployment;
  }

  private requireControlPort(): AgentTeamControlPort {
    if (!this.controlPort) {
      throw new Error('Agent Team control port is not configured');
    }
    return this.controlPort;
  }

  private persistDeployment(deployment: AgentTeamDeployment): void {
    this.commit({
      ...cloneState(this.state),
      deployments: this.state.deployments.map((candidate) =>
        candidate.id === deployment.id ? deployment : candidate,
      ),
    });
  }

  private requireActiveMember(
    machine: string,
    manifestPath: string,
  ): AgentTeamMember {
    const member = this.requireMember(machine, manifestPath);
    if (member.status !== 'active') {
      throw new Error(
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
      throw new Error(
        `Agent Team member not found: ${agentTeamMemberKey({ machine, manifestPath })}`,
      );
    }
    return member;
  }

  private assertAliasAvailable(alias: string, currentId?: string): void {
    if (!alias.trim() || alias.trim() !== alias) {
      throw new Error(
        'Agent Team deployment alias must be non-empty without surrounding whitespace',
      );
    }
    if (
      this.state.deployments.some(
        (deployment) =>
          deployment.alias === alias && deployment.id !== currentId,
      )
    ) {
      throw new Error(`Agent Team deployment alias already exists: ${alias}`);
    }
  }

  private assertHarnessSupported(
    member: AgentTeamMember,
    harness: string,
  ): void {
    if (!member.harnesses.includes(harness)) {
      throw new Error(
        `Harness "${harness}" is not declared by Agent Team member ${agentTeamMemberKey(member)}`,
      );
    }
  }

  private assertWorkingDirPath(workingDirPath: string): void {
    if (!workingDirPath.trim()) {
      throw new Error('Agent Team workingDirPath must be non-empty');
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
  }
}
