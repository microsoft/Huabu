import {
  agentTeamMemberKey,
  agentTeamRootKey,
  sameAgentTeamRoot,
} from './identity.js';

import type {
  AgentTeamMember,
  AgentTeamRegistryState,
  AgentTeamRegistryStore,
  AgentTeamRescanResult,
  AgentTeamRoot,
  AgentTeamRootRef,
  AgentTeamScanPort,
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
    });
    return true;
  }

  private findRoot(root: AgentTeamRootRef): AgentTeamRoot | undefined {
    return this.state.roots.find((candidate) =>
      sameAgentTeamRoot(candidate, root),
    );
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
