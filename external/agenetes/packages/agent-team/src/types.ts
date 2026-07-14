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

export interface AgentTeamSetupError {
  code: string;
  message: string;
}

export type AgentTeamDeploymentSetup =
  | { status: 'disabled' }
  | { status: 'setting_up'; operationId: string; startedAt: number }
  | { status: 'ready'; completedAt: number }
  | { status: 'error'; failedAt: number; error: AgentTeamSetupError };

export interface AgentTeamDeployment {
  id: string;
  alias: string;
  revision: number;
  enabled: boolean;
  machine: string;
  manifestPath: string;
  harness: string;
  workingDirPath: string;
  setup: AgentTeamDeploymentSetup;
}

export interface AgentTeamMemberConfig {
  machine: string;
  manifestPath: string;
  /** Persisted non-secret overrides only. */
  values: Record<string, string>;
}

export interface AgentTeamConfigFieldView {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  configured: boolean;
  /** Present only for non-secret fields with an override or default. */
  value?: string;
}

export interface AgentTeamMemberConfigView {
  machine: string;
  manifestPath: string;
  fields: AgentTeamConfigFieldView[];
  missingRequired: string[];
  ready: boolean;
}

export interface AgentTeamSecretStore {
  /** Read only a host-persisted managed value, excluding environment fallbacks. */
  get(id: string): string | null;
  /** Atomically persist or clear managed values when the host supports it. */
  setMany(updates: Record<string, string | null>): Promise<void>;
}

export interface AgentTeamRegistryState {
  roots: AgentTeamRoot[];
  members: AgentTeamMember[];
  deployments: AgentTeamDeployment[];
  configs: AgentTeamMemberConfig[];
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

export interface CreateAgentTeamDeploymentInput {
  alias: string;
  machine: string;
  manifestPath: string;
  harness: string;
  workingDirPath: string;
}

export interface UpdateAgentTeamDeploymentInput {
  alias?: string;
  harness?: string;
  workingDirPath?: string;
}

export type UpdateAgentTeamMemberConfigsInput = Record<string, string | null>;
