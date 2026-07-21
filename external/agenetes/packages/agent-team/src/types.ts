import type {
  AgentTeamEnvField,
  AgentTeamScanDiagnostic,
  AgentTeamScanParams,
  AgentTeamScanResult,
  AgentTeamSetupCancelParams,
  AgentTeamSetupCancelResult,
  AgentTeamSetupParams,
  AgentTeamSetupProgressParams,
  AgentTeamSetupStartResult,
  AgentTeamValidateParams,
  AgentTeamValidateResult,
} from '@agentlet/protocol';

/**
 * An arbitrary JSON value. Used by {@link AgentProfileBase.customData}, which
 * agenetes stores and returns verbatim without ever interpreting its contents.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

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

export interface AgentTeamMachine {
  machine: string;
  hostname: string;
  platform: string;
}

export interface AgentTeamSetupError {
  code: string;
  message: string;
}

export type AgentTeamPreparation =
  | { status: 'not_prepared' }
  | { status: 'setting_up'; operationId: string; startedAt: number }
  | { status: 'ready'; completedAt: number }
  | { status: 'error'; failedAt: number; error: AgentTeamSetupError };

export interface AgentProfileBase {
  id: string;
  alias: string;
  agentletId: string;
  workingDirPath: string;
  /**
   * Caller-owned, opaque bag of JSON data. agenetes persists it verbatim and
   * never reads or interprets its contents; embedding hosts use it to attach
   * their own per-Profile data (e.g. display preferences) without changing this
   * package.
   */
  customData?: Record<string, JsonValue>;
}

export interface AgentTeamManifestProfile extends AgentProfileBase {
  launch: {
    kind: 'agent-team-manifest';
    manifestPath: string;
    harness: string;
  };
  preparation: AgentTeamPreparation;
}

export interface AcpCommandProfile extends AgentProfileBase {
  launch: {
    kind: 'acp-command';
    command: string;
  };
  metadata?: {
    cliId?: string;
  };
}

export type AgentProfile = AgentTeamManifestProfile | AcpCommandProfile;

export interface AgentProfileSnapshot {
  profileId: string;
  agentletId: string;
  workingDirPath: string;
  launch: AgentProfile['launch'];
}

export interface AgentTeamManifestRuntime {
  environment: Record<string, string>;
}

export interface AgentTeamSetupLogEntry {
  receivedAt: number;
  phase: Extract<AgentTeamSetupProgressParams, { type: 'phase' }>['phase'];
  status: 'started' | 'completed';
  message: string;
}

export interface AgentTeamManifestProfileDetail extends AgentTeamManifestProfile {
  setupLog: AgentTeamSetupLogEntry[];
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
  profiles: AgentProfile[];
  configs: AgentTeamMemberConfig[];
}

export interface AgentTeamRegistryStore {
  load(): AgentTeamRegistryState;
  save(state: AgentTeamRegistryState): void;
  loadSetupLog(profileId: string): AgentTeamSetupLogEntry[];
  resetSetupLog(profileId: string): void;
  appendSetupLog(profileId: string, entry: AgentTeamSetupLogEntry): void;
  deleteSetupLog(profileId: string): void;
}

export type AgentTeamRegistryChangeHandler = () => void;
export type AgentTeamRegistryChangeErrorHandler = (error: unknown) => void;

export interface AgentTeamScanPort {
  scanAgentTeams(
    machine: string,
    params: AgentTeamScanParams,
  ): Promise<AgentTeamScanResult>;
}

export interface AgentTeamControlPort extends AgentTeamScanPort {
  listAgentTeamMachines(): AgentTeamMachine[];
  onAgentTeamMachinesChanged(handler: () => void): () => void;
  setupAgentTeam(
    machine: string,
    params: AgentTeamSetupParams,
  ): Promise<AgentTeamSetupStartResult>;
  cancelAgentTeamSetup(
    machine: string,
    params: AgentTeamSetupCancelParams,
  ): Promise<AgentTeamSetupCancelResult>;
  validateAgentTeam(
    machine: string,
    params: AgentTeamValidateParams,
  ): Promise<AgentTeamValidateResult>;
  onAgentTeamSetupProgress(
    handler: (machine: string, progress: AgentTeamSetupProgressParams) => void,
  ): () => void;
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

export interface CreateAgentTeamManifestProfileInput {
  id?: string;
  alias: string;
  agentletId: string;
  manifestPath: string;
  harness: string;
  workingDirPath: string;
  customData?: Record<string, JsonValue>;
}

export interface CreateAcpCommandProfileInput {
  id?: string;
  alias: string;
  agentletId: string;
  command: string;
  workingDirPath: string;
  metadata?: {
    cliId?: string;
  };
  customData?: Record<string, JsonValue>;
}

export type CreateAgentProfileInput =
  | ({
      launchKind: 'agent-team-manifest';
    } & CreateAgentTeamManifestProfileInput)
  | ({
      launchKind: 'acp-command';
    } & CreateAcpCommandProfileInput);

export interface PatchAgentProfileInput {
  alias?: string;
  metadata?: {
    cliId?: string;
  } | null;
  /**
   * Opaque host data. `undefined` leaves it untouched, `null` clears it, and an
   * object replaces the whole bag.
   */
  customData?: Record<string, JsonValue> | null;
}

export interface AgentTeamMemberSummary {
  machine: string;
  manifestPath: string;
  name: string;
  description: string;
  status: AgentTeamMember['status'];
  profileCount: number;
  preparationCounts: Record<AgentTeamPreparation['status'], number>;
}

export interface AgentTeamMemberDetail {
  member: AgentTeamMember;
  config: AgentTeamMemberConfigView;
  profiles: AgentTeamManifestProfileDetail[];
}

export type UpdateAgentTeamMemberConfigsInput = Record<string, string | null>;
