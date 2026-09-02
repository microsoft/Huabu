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

/**
 * Current Agent Profile record schema version (docs/proposals/agent-resource-registry.md
 * §9, §15). A persisted record with no `schemaVersion` is legacy v1: the
 * store accepts it only as v1, migrates it to v2 with `resourceIds: []`,
 * and rewrites it explicitly. Application code (registry, driver) only ever
 * sees v2 — compatibility parsing lives at the store boundary.
 */
export const AGENT_PROFILE_SCHEMA_VERSION = 2;

export interface AgentProfileBase {
  schemaVersion: typeof AGENT_PROFILE_SCHEMA_VERSION;
  id: string;
  alias: string;
  agentletId: string;
  workingDirPath: string;
  /**
   * The Profile's selectable resource IDs (§9), first-class and generic
   * rather than Huabu-owned `customData`. A host unions its own required
   * defaults with this list at realization; Agenetes never hard-codes
   * default resource IDs itself.
   */
  resourceIds: string[];
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
  /**
   * The effective resource IDs snapshotted at first realization
   * (docs/proposals/agent-resource-registry.md §9, §15). Backward-compatible
   * addition to Agent Profile driver workload v1: optional-on-read (an
   * existing snapshot without the field reads as `[]`) and explicit-on-write
   * for every newly created workload. The driver `schemaVersion` therefore
   * stays 1 — this is an additive field, not a driver contract change.
   */
  resourceIds: string[];
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
  /** Optional resources beyond any host-applied required defaults; defaults to `[]`. */
  resourceIds?: string[];
  customData?: Record<string, JsonValue>;
}

export interface CreateAcpCommandProfileInput {
  id?: string;
  alias: string;
  agentletId: string;
  command: string;
  workingDirPath: string;
  /** Optional resources beyond any host-applied required defaults; defaults to `[]`. */
  resourceIds?: string[];
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
  /**
   * `undefined` leaves the Profile's `resourceIds` untouched; a present array
   * completely replaces it, including an empty array (§9: "Profile patch
   * replaces the complete list").
   */
  resourceIds?: string[];
}

/**
 * Context a resource-ID validation seam receives alongside the candidate
 * IDs: enough to enforce placement (a machine-local resource is eligible
 * only when its `provider` equals the Profile's `agentletId`) without this
 * package depending on the Resource Registry package itself.
 */
export interface AgentResourceValidationContext {
  agentletId: string;
}

/**
 * Injectable seam validating that a Profile's candidate `resourceIds` are
 * known to the registry and eligible for its placement (§9). Kept as a
 * narrow port rather than a direct `@agenetes/resource-registry` dependency
 * so this package stays usable without pulling in the registry package; a
 * host composes a real implementation over its own Resource Registry
 * instance. When no port is supplied, the registry only enforces the
 * bounded shape of `resourceIds` (trimmed, unique, within the canonical
 * bound) and skips existence/eligibility checks.
 */
export interface AgentResourceValidationPort {
  /** Throws for any ID that is unknown to the registry or ineligible for `context`. */
  validateResourceIds(
    resourceIds: readonly string[],
    context: AgentResourceValidationContext,
  ): void;
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
