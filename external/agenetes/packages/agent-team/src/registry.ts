import { randomUUID } from 'node:crypto';

import {
  agentTeamMemberKey,
  agentTeamRootKey,
  sameAgentTeamRoot,
} from './identity.js';

import type {
  AgentTeamDeployment,
  AgentTeamMember,
  AgentTeamRegistryState,
  AgentTeamRegistryStore,
  AgentTeamRescanResult,
  AgentTeamRoot,
  AgentTeamRootRef,
  AgentTeamScanPort,
  CreateAgentTeamDeploymentInput,
  UpdateAgentTeamDeploymentInput,
} from './types.js';

function cloneState(state: AgentTeamRegistryState): AgentTeamRegistryState {
  return structuredClone(state);
}

export class AgentTeamRegistry {
  private state: AgentTeamRegistryState;
  private readonly rootEpochs = new Map<string, number>();
  private readonly inFlightScans = new Map<
    string,
    { epoch: number; promise: Promise<AgentTeamRescanResult> }
  >();

  constructor(
    private readonly store: AgentTeamRegistryStore,
    private readonly scanPort: AgentTeamScanPort,
    private readonly now: () => number = Date.now,
    private readonly generateId: () => string = randomUUID,
  ) {
    this.state = store.load();
    for (const root of this.state.roots) {
      this.rootEpochs.set(agentTeamRootKey(root), 0);
    }
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
    if (placementChanged && current.enabled) {
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
    const deployments = this.state.deployments.filter(
      (deployment) => deployment.id !== id,
    );
    if (deployments.length === this.state.deployments.length) return false;
    this.commit({ ...cloneState(this.state), deployments });
    return true;
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
    });
    return true;
  }

  private findRoot(root: AgentTeamRootRef): AgentTeamRoot | undefined {
    return this.state.roots.find((candidate) =>
      sameAgentTeamRoot(candidate, root),
    );
  }

  private requireActiveMember(
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
    if (member.status !== 'active') {
      throw new Error(
        `Agent Team member is missing: ${agentTeamMemberKey(member)}`,
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
