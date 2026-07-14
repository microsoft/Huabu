import type {
  AgentTeamEnvField,
  AgentTeamScanDiagnostic,
  AgentTeamScanParams,
  AgentTeamScanResult,
} from '@agentlet/protocol';

export interface AgentTeamRootRef {
  machine: string;
  path: string;
}

export type AgentTeamRootScan =
  | { status: 'never_scanned' }
  | {
      status: 'success';
      scannedAt: number;
      diagnostics: AgentTeamScanDiagnostic[];
    }
  | {
      status: 'error';
      attemptedAt: number;
      message: string;
    };

export interface AgentTeamRoot extends AgentTeamRootRef {
  scan: AgentTeamRootScan;
}

export interface AgentTeamMember {
  machine: string;
  manifestPath: string;
  name: string;
  description: string;
  harnesses: string[];
  env: AgentTeamEnvField[];
  discoveredBy: AgentTeamRootRef[];
  status: 'active' | 'member_missing';
}

export interface AgentTeamRegistryState {
  roots: AgentTeamRoot[];
  members: AgentTeamMember[];
}

export interface AgentTeamRegistryStore {
  load(): AgentTeamRegistryState;
  save(state: AgentTeamRegistryState): void;
}

export interface AgentTeamScanPort {
  scanAgentTeams(
    machine: string,
    params: AgentTeamScanParams,
  ): Promise<AgentTeamScanResult>;
}

export type AgentTeamRescanResult =
  | {
      ok: true;
      root: AgentTeamRoot;
      members: AgentTeamMember[];
    }
  | {
      ok: false;
      root: AgentTeamRoot;
      error: string;
    };
